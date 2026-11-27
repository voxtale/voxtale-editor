// Sequence transcription: transcribe only what the cut plays on chosen audio
// tracks inside a range of the cut, and add the words to each clip's
// transcript in source time. One audio file per clip (its heard passages
// joined with short silences), sent once; cached by clip and passages.
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {EditDoc} from '@voxtale/editdoc';
import {transcribeAudio} from './transcript';

export const SEQUENCE_TRACKS=['a-roll','b-roll','voiceover','music'] as const;
export type SequenceTrack=(typeof SEQUENCE_TRACKS)[number];
/** Shorter passages carry no word worth the call. from REDACTED transcribe-sequence.ts */
const MIN_PASSAGE=0.05;
/** Silence between joined passages, so words do not run across a join. */
export const PASSAGE_GAP=0.5;

/** A heard passage of one clip, in source seconds. */
export interface Passage {clipId:string;from:number;to:number}

/**
 * The source passages the cut plays on these tracks between `range` (cut seconds), merged per clip where they touch.
 * Muted b-roll is not heard and is skipped, as are suggestions.
 * from REDACTED editor/transcribe-sequence.ts sequenceRanges
 */
export function sequencePassages(doc:EditDoc,tracks:readonly SequenceTrack[],range?:{from?:number;to?:number}):Passage[] {
  const lo=range?.from??0,hi=range?.to??Infinity,out:Passage[]=[];
  for(const t of tracks)for(const i of doc.tracks[t] as {start:number;end:number;clipId:string;in:number;status?:string;muted?:boolean;speed?:number;mic?:string}[]) {
    if(i.status==='suggested'||i.muted)continue;
    const a=Math.max(i.start,lo),b=Math.min(i.end,hi);
    if(b-a<MIN_PASSAGE)continue;
    const speed=i.speed??1,from=i.in+(a-i.start)*speed;
    out.push({clipId:i.mic??i.clipId,from,to:from+(b-a)*speed});
  }
  return mergePassages(out);
}

/** Touching or overlapping passages of one clip become one, sorted by clip then time. */
export function mergePassages(ps:Passage[]):Passage[] {
  const s=[...ps].sort((x,y)=>x.clipId.localeCompare(y.clipId)||x.from-y.from),out:Passage[]=[];
  for(const p of s) {
    const last=out.at(-1);
    if(last&&last.clipId===p.clipId&&p.from<=last.to+0.01)last.to=Math.max(last.to,p.to);
    else out.push({...p});
  }
  return out;
}

/** Where each passage sits in the joined audio. */
export interface Placed {from:number;to:number;at:number}
export function placePassages(ps:{from:number;to:number}[]):Placed[] {
  let at=0;
  return ps.map(p=>{const x={from:p.from,to:p.to,at};at+=p.to-p.from+PASSAGE_GAP;return x;});
}

export interface SeqWord {id:number;text:string;start:number;end:number}
/** Joined-audio words back in source time; a word in a gap between passages is dropped. */
export function toSource(words:{text:string;start:number;end:number}[],placed:Placed[]):Omit<SeqWord,'id'>[] {
  const out:Omit<SeqWord,'id'>[]=[];
  for(const w of words) {
    const p=placed.find(q=>w.start>=q.at-1e-6&&w.start<q.at+(q.to-q.from));
    if(!p)continue;
    const start=p.from+(w.start-p.at),end=Math.min(p.to,p.from+(w.end-p.at));
    out.push({text:w.text,start,end:Math.max(end,start)});
  }
  return out;
}

/** New words into a clip's words: old ones keep their ids, a new word over an old one is dropped, ids go on from the top. */
export function mergeWords(old:SeqWord[],add:Omit<SeqWord,'id'>[]):{words:SeqWord[];added:number} {
  let next=old.reduce((m,w)=>Math.max(m,w.id),-1)+1,added=0;
  const fresh=add.filter(w=>!old.some(o=>w.start<o.end-1e-6&&w.end>o.start+1e-6)).map(w=>({id:next++,...w}));
  added=fresh.length;
  return {words:[...old,...fresh].sort((a,b)=>a.start-b.start||a.id-b.id),added};
}

type Ff=(args:string[])=>Promise<void>;
export interface SequenceClip {id:string;hash:string;path:string;words:SeqWord[]}
export interface SequenceOptions {fetch?:typeof fetch;progress?:(m:string)=>void;pollMs?:number}

/**
 * Transcribe each clip's passages once (cached under dir by clip hash and passages) and merge the words in.
 * Returns per clip the new word list and how many words it gained.
 */
export async function transcribePassages(ff:Ff,dir:string,clips:SequenceClip[],passages:Passage[],o:SequenceOptions={}):Promise<{clipId:string;words:SeqWord[];added:number;seconds:number;error?:string}[]> {
  await mkdir(dir,{recursive:true});
  const out=[];
  for(const c of clips) {
    const ps=passages.filter(p=>p.clipId===c.id);
    if(!ps.length)continue;
    const placed=placePassages(ps),seconds=ps.reduce((s,p)=>s+p.to-p.from,0);
    const key=createHash('sha256').update(`seq\n${c.hash}\n${ps.map(p=>`${p.from.toFixed(3)}-${p.to.toFixed(3)}`).join(',')}`).digest('hex');
    const base=join(dir,`seq-${c.hash.slice(0,12)}-${key.slice(0,10)}`),audio=`${base}.flac`;
    // The passages, each followed by a short silence, as one 16 kHz mono file.
    const parts=placed.map((p,k)=>`[0:a]atrim=start=${p.from.toFixed(3)}:end=${p.to.toFixed(3)},asetpts=PTS-STARTPTS,aresample=16000,aformat=channel_layouts=mono,apad=pad_dur=${PASSAGE_GAP}[p${k}]`);
    const graph=`${parts.join(';')};${placed.map((_,k)=>`[p${k}]`).join('')}concat=n=${placed.length}:v=0:a=1[out]`;
    try {
      await ff(['-i',c.path,'-filter_complex',graph,'-map','[out]','-ac','1','-ar','16000','-c:a','flac',audio]);
      const total=placed.at(-1)!.at+(placed.at(-1)!.to-placed.at(-1)!.from)+PASSAGE_GAP;
      const t=await transcribeAudio(audio,`${base}.json`,{name:`${c.id} passages`,hash:key,duration:total},{...(o.fetch?{fetch:o.fetch}:{}),...(o.progress?{progress:o.progress}:{}),...(o.pollMs!==undefined?{pollMs:o.pollMs}:{})});
      const m=mergeWords(c.words,toSource(t.words,placed));
      out.push({clipId:c.id,...m,seconds});
    } catch(e) {
      out.push({clipId:c.id,words:c.words,added:0,seconds,error:String((e as Error).message??e).slice(0,300)});
    }
  }
  return out;
}
