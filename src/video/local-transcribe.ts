// Local, free transcription: Parakeet TDT 0.6B v3 on the creator's machine
// (voxtale_native/asr.py: parakeet-mlx on Apple Silicon, sherpa-onnx on the
// CPU elsewhere). No key, no upload. The weights come from
// tools/fetch-parakeet.sh; nothing here downloads them.
//
// Which engine runs: VOXTALE_EDITOR_TRANSCRIBE=local|assemblyai|auto (default
// auto: local when its model is on disk, else a clear error naming the fetch
// script; AssemblyAI only when asked for, so nothing bills by surprise).
//
// Long input goes in pieces read with a pad each side; the pieces join on word
// midpoints, and a word read twice a little apart at a seam is kept once.
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeAsr,REPO_ROOT} from '../native/bridge';
import {ffmpegPath} from './ffmpeg-path';
import {run} from './media';

export const FETCH_SCRIPT='tools/fetch-parakeet.sh';
export const PARAKEET_MODEL='parakeet-tdt-0.6b-v3';
/** Folders under models/parakeet/ (same names as voxtale_native/asr.py). */
export const MLX_DIR='parakeet-tdt-0.6b-v3-mlx',ONNX_DIR='sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const MLX_FILES=['config.json','model.safetensors'],ONNX_FILES=['encoder.int8.onnx','decoder.int8.onnx','joiner.int8.onnx','tokens.txt'];

export type EngineName='local'|'assemblyai';
export interface LocalModel {backend:'mlx'|'onnx';dir:string;missing:string[];ready:boolean}

/** The local model this machine would use and what of it is missing. Same rule as asr.py use_mlx. */
export function localModel(o:{root?:string;platform?:string;arch?:string;env?:Record<string,string|undefined>}={}):LocalModel {
  const env=o.env??process.env,platform=o.platform??process.platform,arch=o.arch??process.arch;
  const backend=platform==='darwin'&&arch==='arm64'&&env.VOXTALE_EDITOR_ASR!=='cpu'?'mlx':'onnx';
  const dir=join(o.root??REPO_ROOT,'models','parakeet',backend==='mlx'?MLX_DIR:ONNX_DIR);
  const missing=(backend==='mlx'?MLX_FILES:ONNX_FILES).filter(f=>!existsSync(join(dir,f)));
  return {backend,dir,missing,ready:!missing.length};
}

const SIZE={mlx:'2.5 GB, MLX',onnx:'490 MB, ONNX int8'} as const;

/** The missing-model message: names the fetch script and the paid way out. */
export function missingModelMessage(m:Pick<LocalModel,'backend'|'dir'>):string {
  return `Local transcription needs the Parakeet v3 model (${SIZE[m.backend]}) in ${m.dir}: run ${FETCH_SCRIPT} in the editor repo once (free download). Or set VOXTALE_EDITOR_TRANSCRIBE=assemblyai to use AssemblyAI (paid, needs ASSEMBLYAI_API_KEY).`;
}
export class MissingModelError extends Error {override name='MissingModelError';}

export interface EngineChoice {engine:EngineName;
  /** What the tool output says, e.g. "local Parakeet v3, free, on this machine". */
  label:string;why:string}
export const ENGINE_LABEL:Record<EngineName,string>={local:'local Parakeet v3, free, on this machine',assemblyai:'AssemblyAI, paid'};

/**
 * Which engine transcribes. `requested`: the caller's pick, else
 * VOXTALE_EDITOR_TRANSCRIBE. An injected fetch means a caller (a test, a
 * resumed AssemblyAI job) wants AssemblyAI. Throws MissingModelError when
 * local is due and its model is not on disk.
 */
export function chooseEngine(o:{requested?:string;model?:LocalModel;injectedFetch?:boolean;env?:Record<string,string|undefined>}={}):EngineChoice {
  const raw=(o.requested??(o.env??process.env).VOXTALE_EDITOR_TRANSCRIBE??'auto').trim().toLowerCase()||'auto';
  if(!['auto','local','assemblyai'].includes(raw))throw new Error(`VOXTALE_EDITOR_TRANSCRIBE=${raw}: use local, assemblyai or auto`);
  const pick=(engine:EngineName,why:string):EngineChoice=>({engine,label:ENGINE_LABEL[engine],why});
  if(raw==='assemblyai')return pick('assemblyai','asked for (VOXTALE_EDITOR_TRANSCRIBE=assemblyai)');
  if(raw==='auto'&&o.injectedFetch)return pick('assemblyai','an AssemblyAI client was passed in');
  const model=o.model??localModel(o.env?{env:o.env}:{});
  if(!model.ready)throw new MissingModelError(missingModelMessage(model));
  return pick('local',raw==='local'?'asked for (VOXTALE_EDITOR_TRANSCRIBE=local)':'model on this machine');
}

export interface RawWord {text:string;start:number;end:number;confidence:number}
/** One read of the input: keeps words whose midpoint is in [from,to); reads [readFrom,readTo]. */
export interface Span {index:number;from:number;to:number;readFrom:number;readTo:number}

/** Longer than LOCAL_LONG goes in LOCAL_PIECE pieces read LOCAL_PAD more each side: one piece's sound stays in memory (10 h of 16 kHz is 2.3 GB). */
export const LOCAL_LONG=25*60,LOCAL_PIECE=20*60,LOCAL_PAD=5;

/** The pieces of a `duration`-second input: one when short, else `piece`-long with `pad` read each side; a last sliver joins the piece before. */
export function spans(duration:number,o:{long?:number;piece?:number;pad?:number}={}):Span[] {
  const long=o.long??LOCAL_LONG,size=o.piece??LOCAL_PIECE,pad=o.pad??LOCAL_PAD;
  if(duration<=long)return [{index:0,from:0,to:duration,readFrom:0,readTo:duration}];
  const out:Span[]=[];
  for(let from=0,i=0;from<duration;from+=size,i++) {
    const to=duration-(from+size)<size/6?duration:from+size;
    out.push({index:i,from,to,readFrom:Math.max(0,from-pad),readTo:Math.min(duration,to+pad)});
    if(to===duration)break;
  }
  return out;
}

type Timed={start:number;end:number};
const mid=(w:Timed)=>(w.start+w.end)/2;
const same=(x:Timed,y:Timed)=>Math.min(x.end,y.end)-Math.max(x.start,y.start)>0.5*Math.min(x.end-x.start,y.end-y.start);

/**
 * Words read on [a,b) (file time) replace the ones there; a word belongs to
 * the pass its midpoint falls in. At a seam the same word read a little apart
 * by two reads comes out once, never twice or not at all (60 ms apart was
 * enough to double it). from REDACTED REDACTED/transcribe.py merge_pass.
 */
export function mergePass<W extends Timed>(words:W[],fresh:W[],a:number,b:number):W[] {
  const inside=fresh.filter(n=>a<=mid(n)&&mid(n)<b);
  const gone=new Set(words.filter(w=>(a<=mid(w)&&mid(w)<b)||inside.some(n=>same(w,n))));
  const taken=new Set(inside);
  const extra=fresh.filter(n=>!taken.has(n)&&[...gone].some(o=>a<=mid(o)&&mid(o)<b&&same(n,o)));
  return [...words.filter(w=>!gone.has(w)),...inside,...extra].sort((x,y)=>x.start-y.start);
}

/** The pieces' words on the input's clock, in order, each word once. `words` times are seconds from the piece's readFrom. */
export function stitch<W extends Timed>(parts:{span:Span;words:W[]}[]):W[] {
  const sorted=[...parts].sort((x,y)=>x.span.from-y.span.from);
  let out:W[]=[];
  sorted.forEach(({span,words},i)=>{
    const shifted=words.map(w=>({...w,start:w.start+span.readFrom,end:w.end+span.readFrom}));
    // Only words near the seam are compared.
    let cut=out.length;while(cut>0&&out[cut-1]!.start>=span.from-10)cut--;
    out=[...out.slice(0,cut),...mergePass(out.slice(cut),shifted,i?span.from:-Infinity,i===sorted.length-1?Infinity:span.to)];
  });
  return out;
}

/** One local engine: words of a 16 kHz mono 16-bit WAV, seconds from its start. Injected in tests. */
export interface LocalEngine {words(wav:string):Promise<{engine:string;model:string;words:RawWord[]}>}
/** voxtale_native/asr.py through the bridge. */
export const nativeEngine=(models?:string):LocalEngine=>({words:wav=>nativeAsr(wav,models)});

/** Cuts input seconds [from,to] (any file ffmpeg reads) to a 16 kHz mono 16-bit WAV. */
export type WavCutter=(input:string,from:number,to:number,out:string)=>Promise<void>;
export const ffmpegWav:WavCutter=async(input,from,to,out)=>{
  await run(ffmpegPath(),['-v','error','-nostdin','-y',...(from>0?['-ss',String(from)]:[]),'-t',String(to-from),'-i',input,'-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',out]);
};

export interface LocalOptions {engine?:LocalEngine;cut?:WavCutter;progress?:(message:string)=>void;long?:number;piece?:number;pad?:number}

/**
 * The one local entry point: words of `input` (video, FLAC, WAV; any length)
 * on its own clock, cut into pieces, each read by the engine, stitched.
 * transcribe / transcribeAudio call it for a file, a sequence's joined
 * passages or a live piece alike.
 */
export async function transcribeLocal(input:string,duration:number,o:LocalOptions={}):Promise<{engine:string;model:string;words:RawWord[]}> {
  const engine=o.engine??nativeEngine(),cut=o.cut??ffmpegWav,ps=spans(duration,o);
  const scratch=await mkdtemp(join(tmpdir(),'voxtale-asr-'));
  let name='parakeet',model=PARAKEET_MODEL;
  try {
    const parts:{span:Span;words:RawWord[]}[]=[];
    for(const s of ps) {
      o.progress?.(ps.length>1?`Parakeet: piece ${s.index+1}/${ps.length} (${Math.round(s.from)}-${Math.round(s.to)} s)`:'Parakeet: transcribing on this machine');
      const wav=join(scratch,`piece-${s.index}.wav`);
      await cut(input,s.readFrom,s.readTo,wav);
      const r=await engine.words(wav);
      name=r.engine;model=r.model;
      parts.push({span:s,words:r.words});
      await rm(wav,{force:true});
    }
    return {engine:name,model,words:stitch(parts)};
  } finally {await rm(scratch,{recursive:true,force:true});}
}
