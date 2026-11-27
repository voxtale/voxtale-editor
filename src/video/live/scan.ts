// A finished live, end to end up to the candidate list: transcript in
// pieces, local signals, candidate windows, then (optional) one fast-model
// pass over the windows only. Everything lands in <live dir>/ so a second
// call reuses it. The model and the transcriber are injected; nothing here
// spends unless the caller passes them.
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {maybeJson,writeJson} from '../artifacts';
import {promptText} from '../../services/prompts';
import {findCandidates,mergeRatings,ranked,scanText,type Candidate} from './candidates';
import {LIVE_SCAN_JSON,LIVE_SCAN_PROMPT_ID} from './prompts';
import {chatPeaks,laughPeaks,loudness,parseChat,parseMarkers,perMinute,replayPeaks,seconds,soundPeaks,type ChatMessage,type Signal} from './signals';
import {transcribeLive,type AudioCutter,type LiveTranscript,type PieceTranscriber} from './transcribe';

/** A model call: system text, user input, JSON schema → parsed JSON (askPlanner's shape). */
export type Ask=(system:string,input:unknown,schema:object)=>Promise<unknown>;

export interface LiveIndex {source:string;duration:number;signals:Signal[];candidates:Candidate[];rated:boolean}

/**
 * A moment the model placed in the wrong hour ("0:28:10" for "6:28:10")
 * moved back to the window's hour, else null.
 */
export function inside(c:{start:number;end:number},from:number,to:number):{start:number;end:number}|null {
  for(let h=-12;h<=12;h++) {
    const s=c.start+h*3600,e=c.end+h*3600;
    if(s>=from-60&&e<=to+120&&s>=0)return {start:s,end:e};
  }
  return null;
}

/** Rate candidate windows with the fast model, 15 per call. */
export async function rateWithModel(cands:Candidate[],words:LiveTranscript['words'],duration:number,ask:Ask,o:{batch?:number;progress?:(done:number,total:number,msg:string)=>void}={}):Promise<Candidate[]> {
  const size=o.batch??15,out:Parameters<typeof mergeRatings>[1]=[];
  for(let i=0;i<cands.length;i+=size) {
    const part=cands.slice(i,i+size);
    o.progress?.(i,cands.length,`rating windows ${i+1}-${i+part.length}`);
    const r=await ask(promptText(LIVE_SCAN_PROMPT_ID),{windows:scanText(part,words)},LIVE_SCAN_JSON) as {ratings?:{id:string;rating:number;start:string;end:string;what:string;why:string}[]};
    for(const x of r.ratings??[]) {
      const c=part.find(p=>p.id===x.id);
      if(!c)continue;
      const fixed=inside({start:seconds(x.start),end:seconds(x.end)},c.start,c.end);
      out.push({id:x.id,rating:x.rating,what:x.what,why:x.why,...(fixed?fixed:{})});
    }
  }
  return mergeRatings(cands,out,duration);
}

/**
 * The live's index in `dir`: transcript (transcript.json + pieces/),
 * signals and candidates (candidates.json). Chat and markers are files the
 * creator gave; heatmap is yt-dlp's `heatmap` list.
 */
export async function scanLive(o:{source:string;duration:number;dir:string;chat?:string;markers?:string;
  heatmap?:{start_time:number;end_time:number;value:number}[];top?:number;
  transcribe?:PieceTranscriber;cut?:AudioCutter;levels?:(source:string)=>Promise<number[]>;ask?:Ask;
  progress?:(done:number,total:number,msg:string)=>void;fresh?:boolean}):Promise<LiveIndex> {
  const file=join(o.dir,'candidates.json');
  const saved=o.fresh?undefined:await maybeJson(file) as LiveIndex|undefined;
  if(saved&&saved.source===o.source&&(saved.rated||!o.ask))return saved;
  const t=await transcribeLive({source:o.source,duration:o.duration,dir:o.dir,...(o.transcribe?{transcribe:o.transcribe}:{}),...(o.cut?{cut:o.cut}:{}),...(o.progress?{progress:o.progress}:{})});
  let signals:Signal[],cands:Candidate[];
  if(saved&&saved.source===o.source){signals=saved.signals;cands=saved.candidates;}
  else {
    o.progress?.(0,1,'reading the sound');
    const levelsFile=join(o.dir,'levels.json');
    const levels:number[]=(await maybeJson(levelsFile))??await (o.levels??loudness)(o.source);
    if(!existsSync(levelsFile))await writeJson(levelsFile,levels);
    const chat:ChatMessage[]=o.chat?parseChat(await readFile(o.chat,'utf8')):[];
    signals=[...soundPeaks(levels),...chatPeaks(perMinute(chat)),...laughPeaks(t.words,chat),
      ...(o.markers?parseMarkers(await readFile(o.markers,'utf8')):[]),...(o.heatmap?replayPeaks(o.heatmap):[])].sort((a,b)=>a.t-b.t);
    cands=findCandidates(t.words,signals,o.duration,{top:o.top??80});
  }
  if(o.ask)cands=await rateWithModel(cands,t.words,o.duration,o.ask,{...(o.progress?{progress:o.progress}:{})});
  const index:LiveIndex={source:o.source,duration:o.duration,signals,candidates:ranked(cands),rated:!!o.ask};
  await writeJson(file,index);
  return index;
}
