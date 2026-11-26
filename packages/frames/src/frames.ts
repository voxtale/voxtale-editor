// What the agent needs from the clips' full files, behind one port. The local
// engine answers on this machine (localFrames); a cloud run asks the creator's
// desktop, where the files are, so no full file leaves it. Clips are named by
// hash: the host finds its own file for each. ffmpeg only, no model.
import {spawn} from 'node:child_process';
import type {EventEmitter} from 'node:events';
import {copyFile,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {VOICE_STEP,packVoice,voiceFrames} from './voice';

export type Ff=(args:string[])=>Promise<void>;

/** Runs ffmpeg `bin` to completion; throws with its stderr tail. */
export function ffmpeg(bin='ffmpeg',timeoutMs=120_000):Ff {
  return args=>new Promise((resolve,reject)=>{
    // JPEG out needs full-range YUV: ffmpeg 6 (the desktop's) refuses anything else.
    const out=args.at(-1)??'';
    if(/\.jpe?g$/i.test(out)&&!args.includes('-pix_fmt'))args=[...args.slice(0,-1),'-pix_fmt','yuvj420p',out];
    const child=spawn(bin,['-hide_banner','-nostdin','-loglevel','error','-y',...args],{stdio:['ignore','ignore','pipe']});
    let err='';
    child.stderr!.on('data',(b:Buffer)=>{err=(err+b.toString()).slice(-2000);});
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);
    // bun-types drop ChildProcess's EventEmitter side; node has it.
    const events=child as unknown as EventEmitter;
    events.on('error',(e:Error)=>{clearTimeout(timer);reject(e);});
    events.on('close',(code:number|null)=>{clearTimeout(timer);code===0?resolve():reject(new Error(`ffmpeg: ${err.slice(-600)}`));});
  });
}

/** One source frame (the speaker), used as the backdrop when checking a graphic. */
export async function frameAt(ff:Ff,src:string,t:number,out:string,width:number):Promise<void> {
  await ff(['-ss',String(t),'-i',src,'-frames:v','1','-vf',`scale=${width}:-2`,out]);
}

export interface FramePoint {clip:string;t:number}

export interface GraphicJob {
  /** Graphic id, unique in the run. */
  id:string;
  /** index.html and kit.css of a HyperFrames composition. */
  html:string;
  kitCss:string;
  width:number;
  height:number;
  seconds:number;
  /** Seconds into the graphic to check. */
  stills:number[];
  /** Source frame the stills sit over. */
  backdrop:FramePoint;
  /**
   * Files on this machine copied next to the composition as ./brand/<name> (brand fonts, logo).
   * Local hosts only: a relay host has no access to them and leaves them out.
   */
  files?:{name:string;path:string}[];
}

export interface GraphicResult {
  ok:boolean;
  report:string;
  /** The stills over the backdrop, side by side (JPEG). */
  sheet?:Uint8Array;
  /** The transparent WebM, as a file on the caller's machine. */
  webm?:string;
}

export interface FrameHost {
  /** 8 frames across [start,end] over the waveform (PNG). */
  filmstrip(clip:string,start:number,end:number):Promise<Uint8Array>;
  /** Last frame before and first after each join, one row per join (JPEG). */
  joins(pairs:{a:FramePoint;b:FramePoint}[]):Promise<Uint8Array>;
  /** JPEG frames `width` px wide; null where a frame failed. */
  frames(clip:string,times:number[],width:number):Promise<(Uint8Array|null)[]>;
  graphic(job:GraphicJob):Promise<GraphicResult>;
  /**
   * The whole clip in one pass: one tiny grey frame every `every` seconds,
   * `width`x`height` bytes each, back to back. For change detection, not viewing.
   */
  sample?(clip:string,every:number,width:number,height:number):Promise<Uint8Array>;
  /** The sound of [start,end]: mono 32-bit float samples at AUDIO_RATE, back to back. For measuring how a line was said. */
  audio?(clip:string,start:number,end:number):Promise<Uint8Array>;
  /** The whole clip's voice track: level and pitch every VOICE_STEP, packed (see unpackVoice). */
  voice?(clip:string):Promise<Uint8Array>;
}

/** Sample rate of `audio`: enough for a voice's loudness and pitch. */
export const AUDIO_RATE=8000;
/** Longest span one `audio` call reads, seconds. */
export const AUDIO_MAX_SECONDS=120;
/** Seconds of sound `voice` reads at a time. */
const VOICE_CHUNK=600;

/**
 * Renders a HyperFrames composition: `dir` holds index.html and kit.css; the
 * renderer adds GSAP and the fonts. Docker locally (./hyperframes), Electron's
 * Chromium in the desktop app.
 */
export type HtmlRenderer=(o:{dir:string;width:number;height:number;seconds:number})=>Promise<{ok:boolean;webm?:string;report:string}>;

const PARALLEL=4;

/** Frames in a filmstrip. */
export const STRIP_FRAMES=8;
/** Source times of a filmstrip's cells: the first at `start`, the last the final frame before `end`, the rest evenly between. */
export function stripTimes(start:number,end:number,n=STRIP_FRAMES):number[] {
  return Array.from({length:n},(_,k)=>start+k*(end-start)/(n-1));
}

/** Answers from files on this machine. `sources`: full file per clip hash. */
export function localFrames(o:{sources:Record<string,string>;dir:string;html?:HtmlRenderer;ff?:Ff}):FrameHost {
  const ff=o.ff??ffmpeg();
  let n=0;
  const file=(hash:string)=>{
    const f=o.sources[hash];
    if(!f)throw new Error(`clip ${hash.slice(0,8)} is not on this computer`);
    return f;
  };
  const scratch=async(name:string)=>{const d=join(o.dir,`${name}-${++n}`);await mkdir(d,{recursive:true});return d;};
  return {
    async filmstrip(clip,start,end) {
      // First cell is the frame at start, last is the last frame before end: a short clip's key moment often sits at an edge.
      const times=stripTimes(start,end),n=times.length,cell=Math.floor(1600/n),src=file(clip);
      const out=join(await scratch('strip'),'strip.png');
      const tail=Math.max(0,end-0.5);
      const inputs=[...times.slice(0,-1).flatMap(t=>['-ss',String(t),'-i',src]),'-ss',String(tail),'-t',String(Math.max(0.05,end-tail)),'-i',src];
      const cells=times.map((_,k)=>`[${k}:v]${k===n-1?'reverse,':''}trim=end_frame=1,setpts=PTS-STARTPTS,scale=${cell}:-2[v${k}]`).join(';');
      const top=`${cells};${times.map((_,k)=>`[v${k}]`).join('')}hstack=inputs=${n}`;
      const args=(graph:string,audio=false)=>[...inputs,...(audio?['-ss',String(start),'-t',String(Math.max(0.5,end-start)),'-i',src]:[]),'-filter_complex',graph,'-frames:v','1',out];
      // A clip with no sound (a screen recording) gets frames only.
      await ff(args(`${top}[top];[${n}:a]aformat=channel_layouts=mono,showwavespic=s=${cell*n}x120:colors=0x66ccff[wave];[top][wave]vstack=inputs=2`,true))
        .catch(()=>ff(args(top)));
      return new Uint8Array(await readFile(out));
    },
    async joins(pairs) {
      if(!pairs.length)throw new Error('no joins: the cut is one segment');
      const dir=await scratch('joins');
      const rows:string[]=[];
      for(const [k,{a,b}] of pairs.entries()) {
        const fa=join(dir,`${k}a.jpg`),fb=join(dir,`${k}b.jpg`),row=join(dir,`${k}.jpg`);
        await ff(['-ss',String(Math.max(0,a.t)),'-i',file(a.clip),'-frames:v','1','-vf','scale=480:-2',fa]);
        await ff(['-ss',String(b.t),'-i',file(b.clip),'-frames:v','1','-vf','scale=480:-2',fb]);
        await ff(['-i',fa,'-i',fb,'-filter_complex','[0][1]hstack=inputs=2',row]);
        rows.push(row);
      }
      const out=join(dir,'sheet.jpg');
      await ff([...rows.flatMap(r=>['-i',r]),'-filter_complex',rows.length>1?`${rows.map((_,i)=>`[${i}]`).join('')}vstack=inputs=${rows.length}`:'null',out]);
      return new Uint8Array(await readFile(out));
    },
    async frames(clip,times,width) {
      const src=file(clip),dir=await scratch('frames');
      const out:(Uint8Array|null)[]=new Array(times.length).fill(null);
      let next=0;
      await Promise.all(Array.from({length:Math.min(PARALLEL,times.length)},async()=>{
        while(next<times.length) {
          const k=next++,jpg=join(dir,`${k}.jpg`);
          try {await frameAt(ff,src,times[k]!,jpg,width);out[k]=new Uint8Array(await readFile(jpg));} catch {/* stays null */}
        }
      }));
      return out;
    },
    async sample(clip,every,width,height) {
      const out=join(await scratch('sample'),'grey.raw');
      await sampleFile(ff,file(clip),every,width,height,out);
      return new Uint8Array(await readFile(out));
    },
    async audio(clip,start,end) {
      const out=join(await scratch('audio'),'a.f32');
      await ff(['-ss',String(Math.max(0,start)),'-t',String(Math.min(AUDIO_MAX_SECONDS,Math.max(0.05,end-start))),'-i',file(clip),
        '-vn','-ac','1','-ar',String(AUDIO_RATE),'-f','f32le','-c:a','pcm_f32le',out]);
      return new Uint8Array(await readFile(out));
    },
    async voice(clip) {
      const dir=await scratch('voice'),parts:Uint8Array[]=[];
      // In pieces, so a long clip never sits in memory whole. Each piece reads one step past its end: the last window needs it.
      for(let k=0;;k++) {
        const out=join(dir,`${k}.f32`);
        const read=ff(['-ss',String(k*VOICE_CHUNK),'-t',String(VOICE_CHUNK+VOICE_STEP),'-i',file(clip),'-vn','-ac','1','-ar',String(AUDIO_RATE),'-f','f32le','-c:a','pcm_f32le',out]);
        // Past the end of the sound there is nothing to read.
        if(k)try {await read;} catch {break;} else await read;
        const buf=await readFile(out).catch(()=>Buffer.alloc(0));
        await rm(out,{force:true});
        const samples=new Float32Array(buf.buffer.slice(buf.byteOffset,buf.byteOffset+Math.floor(buf.byteLength/4)*4));
        parts.push(packVoice(voiceFrames(samples,AUDIO_RATE)));
        if(samples.length<VOICE_CHUNK*AUDIO_RATE)break;
      }
      const all=new Uint8Array(parts.reduce((s,p)=>s+p.length,0));
      let at=0;
      for(const p of parts){all.set(p,at);at+=p.length;}
      return all;
    },
    async graphic(job) {
      if(!o.html)return {ok:false,report:'render failed: no graphics renderer on this computer'};
      return renderGraphic(join(o.dir,'graphics',job.id),job,file(job.backdrop.clip),o.html,ff);
    },
  };
}

/** Grey frames every `every` seconds of `src`, raw bytes into `out`. One decode pass. */
export async function sampleFile(ff:Ff,src:string,every:number,width:number,height:number,out:string):Promise<void> {
  await ff(['-i',src,'-an','-vf',`fps=1/${every},scale=${width}:${height}:flags=area,format=gray`,'-f','rawvideo',out]);
}

const tail=(s:string,n=1500)=>s.length>n?`…${s.slice(-n)}`:s;

/** Render, then lay stills over the speaker frame so the agent judges the graphic in context. */
export async function renderGraphic(dir:string,job:GraphicJob,backdrop:string,render:HtmlRenderer,ff:Ff=ffmpeg()):Promise<GraphicResult> {
  const inDir=join(dir,'in'),outDir=join(dir,'out');
  await rm(dir,{recursive:true,force:true});
  await mkdir(inDir,{recursive:true});await mkdir(outDir,{recursive:true});
  await writeFile(join(inDir,'index.html'),job.html);
  await writeFile(join(inDir,'kit.css'),job.kitCss);
  if(job.files?.length) {
    await mkdir(join(inDir,'brand'),{recursive:true});
    for(const f of job.files)await copyFile(f.path,join(inDir,'brand',basename(f.name))).catch(()=>{});
  }
  let r:Awaited<ReturnType<HtmlRenderer>>;
  try {r=await render({dir:inDir,width:job.width,height:job.height,seconds:job.seconds});}
  catch(e) {r={ok:false,report:`render failed: ${tail(e instanceof Error?e.message:String(e))}`};}
  const ok=r.ok&&!!r.webm&&await stat(r.webm).then(s=>s.size>0,()=>false);
  if(!ok)return {ok:false,report:r.report};
  const webm=r.webm!;
  // Alpha-aware VP9 decode (libvpx-vp9 before -i), overlaid on the speaker frame
  // (grabbed at canvas width, so no scaling: ffmpeg 6 scale2ref drops still images).
  const back=join(outDir,'backdrop.jpg');
  await frameAt(ff,backdrop,job.backdrop.t,back,job.width);
  const shots:string[]=[];
  for(const [k,t] of job.stills.filter(s=>s<job.seconds).entries()) {
    const png=join(outDir,`still-${k}.png`),comp=join(outDir,`comp-${k}.jpg`);
    await ff(['-c:v','libvpx-vp9','-ss',String(t),'-i',webm,'-frames:v','1',png]);
    await ff(['-i',back,'-i',png,'-filter_complex','[0][1]overlay=format=auto,scale=800:-2','-frames:v','1',comp]);
    shots.push(comp);
  }
  if(!shots.length)return {ok:true,webm,report:r.report};
  const sheet=join(outDir,'sheet.jpg');
  await ff([...shots.flatMap(s=>['-i',s]),'-filter_complex',shots.length>1?`${shots.map((_,i)=>`[${i}]`).join('')}hstack=inputs=${shots.length}`:'null',sheet]);
  return {ok:true,webm,report:r.report,sheet:new Uint8Array(await readFile(sheet))};
}
