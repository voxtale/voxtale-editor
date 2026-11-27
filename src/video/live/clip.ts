// One chosen moment of a live → its own clip folder, ready for the editor:
// the passage cut (with MARGIN s more each side, re-encoded so the cut is
// frame exact), and its words sliced out of the live's transcript and
// written where openProject looks for a transcript, so opening the clip
// never sends it to AssemblyAI again.
import {createHash} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {writeJson} from '../artifacts';
import {ffmpegPath} from '../ffmpeg-path';
import {run} from '../media';
import type {Transcript} from '../transcript';
import type {LiveWord} from './transcribe';

/** Seconds kept past each side of a pick, for trimming in the editor. from REDACTED live-run.ts MARGIN */
export const MARGIN=3;

export const clipStem=(n:number)=>`clip-${String(n).padStart(2,'0')}`;

/**
 * The words of [from,to] of the live, on the clip's clock, as a transcript
 * openProject accepts for the clip file (`sourceHash` = its sha256).
 */
export function sliceTranscript(words:LiveWord[],from:number,to:number,o:{source:string;sourceHash:string;duration:number;id:string}):Transcript {
  const ws=words.filter(w=>w.start>=from&&w.end<=to).map((w,id)=>({id,text:w.text,start:round(w.start-from),end:round(Math.min(w.end-from,o.duration)),confidence:w.confidence??0}))
    .filter(w=>w.end>w.start);
  return {version:1,provider:'assemblyai',providerId:o.id,source:o.source,sourceHash:o.sourceHash,duration:o.duration,model:'live-slice',words:ws.map((w,id)=>({...w,id}))};
}
const round=(v:number)=>Math.round(v*1000)/1000;

async function sha256(path:string):Promise<string> {
  const h=createHash('sha256');
  for await(const chunk of createReadStream(path))h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Cuts [from,to] of the live (a file, or a URL through yt-dlp --download-sections) to `out`, 1080p at most. */
export type PassageCutter=(source:string,from:number,to:number,out:string)=>Promise<void>;
export const cutPassage:PassageCutter=async(source,from,to,out)=>{
  if(/^https?:\/\//.test(source)) {
    await run('yt-dlp',['--quiet','--no-warnings','-f','bv*[height<=1080]+ba/b[height<=1080]/b','--download-sections',`*${from}-${to}`,'--force-keyframes-at-cuts',
      '--merge-output-format','mp4','-o',out,source]);
    return;
  }
  await run(ffmpegPath(),['-v','error','-nostdin','-y','-ss',String(from),'-i',source,'-t',String(to-from),
    '-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',out]);
};

/**
 * The clip folder `<root>/<stem>/`: <stem>.mp4 and its transcript in
 * .edit/transcripts/. Both kept when there (a second call cuts nothing).
 * Returns the clip file, where it starts in the live, and its length.
 */
export async function prepareClip(o:{root:string;stem:string;source:string;start:number;end:number;liveDuration:number;words:LiveWord[];
  liveId:string;cut?:PassageCutter;probe:(path:string)=>Promise<{duration:number}>}):Promise<{folder:string;file:string;offset:number;duration:number}> {
  const folder=join(o.root,o.stem),file=join(folder,`${o.stem}.mp4`);
  await mkdir(folder,{recursive:true});
  const from=Math.max(0,o.start-MARGIN),to=Math.min(o.liveDuration,o.end+MARGIN);
  if(!existsSync(file))await (o.cut??cutPassage)(o.source,from,to,file);
  const {duration}=await o.probe(file),hash=await sha256(file);
  const out=join(folder,'.edit','transcripts',`${hash.slice(0,12)}.json`);
  if(!existsSync(out)) {
    const t=sliceTranscript(o.words,from,from+duration,{source:file,sourceHash:hash,duration,id:`live:${o.liveId}:${from.toFixed(2)}`});
    // Written even empty: the open reads an empty one as "no speech" (noSpeech) and never sends the clip out.
    await mkdir(join(folder,'.edit','transcripts'),{recursive:true});await writeJson(out,t);
  }
  return {folder,file,offset:from,duration};
}
