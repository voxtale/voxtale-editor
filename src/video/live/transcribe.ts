// Transcribing a whole livestream (8-12 h) in pieces: each 30-min piece is
// read with 5 s more on each side, sent once, and kept in its own file, so a
// crash or a stop never pays again for a piece already done. The pieces join
// on word midpoints. Only the transcriber (AssemblyAI by default) costs money;
// it and the audio cutter are injected so tests run offline.
import {createHash} from 'node:crypto';
import {open,stat,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod/v4';
import {maybeJson,writeJson} from '../artifacts';
import {ffmpegPath} from '../ffmpeg-path';
import {run} from '../media';
import {transcribeAudio,type Transcript} from '../transcript';

/** Longer than this goes in pieces. */
export const LONG=45*60;
/** Piece length and the extra read each side. */
export const PIECE=30*60,PAD=5;

export interface LiveWord {text:string;start:number;end:number;confidence?:number}
/** The whole live's words on its own clock. Our own format: one file per live, any provider underneath. */
export const liveTranscriptSchema=z.object({version:z.literal(1),source:z.string(),quickId:z.string(),duration:z.number().positive(),
  pieces:z.number().int().positive(),words:z.array(z.object({text:z.string(),start:z.number(),end:z.number(),confidence:z.number().optional()}).strict())}).strict();
export type LiveTranscript=z.infer<typeof liveTranscriptSchema>;

export interface Piece {index:number;from:number;to:number;readFrom:number;readTo:number}

/** The pieces of a `duration`-second live: one for a short one, else PIECE-long with PAD read each side. */
export function pieces(duration:number,o:{long?:number;piece?:number;pad?:number}={}):Piece[] {
  const long=o.long??LONG,size=o.piece??PIECE,pad=o.pad??PAD;
  if(duration<=long)return [{index:0,from:0,to:duration,readFrom:0,readTo:duration}];
  const out:Piece[]=[];
  for(let from=0,i=0;from<duration;from+=size,i++) {
    // A last sliver joins the piece before it.
    const to=duration-(from+size)<size/6?duration:from+size;
    out.push({index:i,from,to,readFrom:Math.max(0,from-pad),readTo:Math.min(duration,to+pad)});
    if(to===duration)break;
  }
  return out;
}

/**
 * The pieces' words on the live's clock, in order. A word belongs to the
 * piece its midpoint falls in, so words read twice near a seam (the pads)
 * are kept once. `words` times are seconds from the piece's readFrom.
 */
export function mergePieces(parts:{piece:Piece;words:LiveWord[]}[]):LiveWord[] {
  const out:LiveWord[]=[];
  for(const {piece,words} of [...parts].sort((a,b)=>a.piece.from-b.piece.from))
    for(const w of words) {
      const start=w.start+piece.readFrom,end=w.end+piece.readFrom,mid=(start+end)/2;
      if(mid>=piece.from&&mid<piece.to)out.push({...w,start,end});
    }
  out.sort((a,b)=>a.start-b.start);
  // Keep the transcript's rule: no word starts before the one before it.
  return out;
}

/** A cheap id for a huge file: its size and the sha256 of its first and last MiB. A full hash of 12 h of video takes minutes. */
export async function quickId(path:string):Promise<string> {
  const {size}=await stat(path),mb=1<<20,h=createHash('sha256').update(String(size));
  const f=await open(path,'r');
  try {
    const head=Buffer.alloc(Math.min(mb,size));await f.read(head,0,head.length,0);h.update(head);
    if(size>mb){const tail=Buffer.alloc(Math.min(mb,size));await f.read(tail,0,tail.length,size-tail.length);h.update(tail);}
  } finally {await f.close();}
  return h.digest('hex').slice(0,24);
}

/** Cuts source seconds [from,to] of the live's sound to a mono 16 kHz FLAC. */
export type AudioCutter=(source:string,from:number,to:number,out:string)=>Promise<void>;
/** Sends one piece's sound; resumable on its output path (transcribeAudio keeps the job id beside it). */
export type PieceTranscriber=(audio:string,output:string,piece:{name:string;hash:string;duration:number})=>Promise<Pick<Transcript,'words'>>;

export const ffmpegCutter:AudioCutter=async(source,from,to,out)=>{
  await run(ffmpegPath(),['-v','error','-nostdin','-y','-ss',String(from),'-t',String(to-from),'-i',source,'-vn','-ac','1','-ar','16000','-c:a','flac',out]);
};
export const assemblyTranscriber:PieceTranscriber=(audio,output,piece)=>transcribeAudio(audio,output,piece);

/**
 * The whole live's transcript in `dir` (transcript.json), piece by piece:
 * a piece with its output already on disk is never cut or sent again.
 */
export async function transcribeLive(o:{source:string;duration:number;dir:string;id?:string;
  cut?:AudioCutter;transcribe?:PieceTranscriber;progress?:(done:number,total:number,msg:string)=>void;
  long?:number;piece?:number;pad?:number}):Promise<LiveTranscript> {
  const id=o.id??await quickId(o.source);
  const final=join(o.dir,'transcript.json');
  const saved=await maybeJson(final);
  if(saved){const t=liveTranscriptSchema.parse(saved);if(t.quickId===id)return t;throw new Error(`${final} is for another recording: move it away to transcribe this one`);}
  await mkdir(join(o.dir,'pieces'),{recursive:true});
  const ps=pieces(o.duration,o);
  const parts:{piece:Piece;words:LiveWord[]}[]=[];
  for(const p of ps) {
    const stem=join(o.dir,'pieces',`${id.slice(0,12)}-${String(p.index).padStart(3,'0')}`);
    const out=`${stem}.json`,audio=`${stem}.flac`;
    o.progress?.(p.index,ps.length,existsSync(out)?`piece ${p.index+1}/${ps.length}: saved`:`piece ${p.index+1}/${ps.length}: transcribing`);
    if(!existsSync(out)&&!existsSync(`${out}.state.json`))await (o.cut??ffmpegCutter)(o.source,p.readFrom,p.readTo,audio);
    const t=await (o.transcribe??assemblyTranscriber)(audio,out,{name:`${o.source}#${p.readFrom}-${p.readTo}`,hash:`${id}:${p.index}:${p.readFrom}-${p.readTo}`,duration:p.readTo-p.readFrom});
    parts.push({piece:p,words:t.words.map(w=>({text:w.text,start:w.start,end:w.end,confidence:w.confidence}))});
  }
  o.progress?.(ps.length,ps.length,'joining pieces');
  const t:LiveTranscript={version:1,source:o.source,quickId:id,duration:o.duration,pieces:ps.length,words:mergePieces(parts)};
  await writeJson(final,t);
  return t;
}
