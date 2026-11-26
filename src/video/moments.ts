// Clip moments: what each clip shows, change by change, at the second. The
// footage index (footage-index.ts) labels shots of up to 20s, which is too
// coarse to know when a screen recording turns to the bell curve. Here code
// finds every visible change in one cheap pass and owns the times; a provider
// only describes the moments it is given. Providers are swappable so they can
// be scored on the same truth (tools/moments-eval.ts).
import {z} from 'zod';
import type {FrameHost} from '@voxtale/frames';
import {promptStamp,promptText} from '../services/prompts';
import type {VisionModel,VisionPart} from './footage-index';
import {MOMENTS_PROMPT_ID} from './prompts';

const time=z.number().finite().nonnegative();
export const MOMENT_PROVIDERS=['dense','gemini-video','jev'] as const;
export type MomentProvider=typeof MOMENT_PROVIDERS[number];

export const momentSchema=z.object({
  id:z.string().regex(/^M\d{3,5}$/),
  start:time,
  end:time,
  /** Source second of the frame the description was made from. */
  frame:time,
  description:z.string().max(1000),
  changed:z.string().max(300),
  onScreenText:z.array(z.string().max(200)).max(8),
  subjects:z.array(z.string().max(120)).max(12),
}).strict();
export type Moment=z.infer<typeof momentSchema>;

export const clipMomentsSchema=z.object({
  clipHash:z.string().regex(/^[0-9a-f]{64}$/),
  provider:z.enum(MOMENT_PROVIDERS),
  model:z.string().max(120),
  promptVersion:z.string().max(80),
  /** Seconds between the grey frames change detection looked at. */
  every:z.number().positive(),
  moments:z.array(momentSchema).max(5000),
  costUsd:z.number().nonnegative(),
  ms:z.number().nonnegative(),
}).strict();
export type ClipMoments=z.infer<typeof clipMomentsSchema>;

export function momentsPromptVersion():string {
  const p=promptStamp()[MOMENTS_PROMPT_ID];
  return p?`${MOMENTS_PROMPT_ID}@${p.version}:${p.hash.slice(0,8)}`:MOMENTS_PROMPT_ID;
}

/** Saved moments, when they are for this clip and the current moments prompt; else undefined (describe again). */
export function freshMoments(saved:unknown,hash:string):ClipMoments|undefined {
  const m=clipMomentsSchema.safeParse(saved);
  return m.success&&m.data.promptVersion===momentsPromptVersion()&&m.data.clipHash===hash?m.data:undefined;
}

/** Grey frame size for change detection: big enough for a pen stroke, small enough for one pass over an hour. */
export const SAMPLE_W=96,SAMPLE_H=60;
/** A pixel counts as changed past this grey step (0-255). */
const PIXEL_STEP=10;
/** New moment past this share of steady pixels changed, or this share of all pixels. */
const QUIET_SHARE=0.0025,LOUD_SHARE=0.02;
/** Pixels that change this often across the clip (a clock, a spinner, a moving speaker) only count toward LOUD_SHARE. */
const BUSY_SHARE=0.03;
/** Moments last at least MIN and at most MAX seconds; a long still stretch is split so nothing goes undescribed for long. */
export const MOMENT_MIN=1,MOMENT_MAX=30;

/** Sample spacing for a clip: twice a second, fewer on long clips so the pass stays bounded. */
export const sampleEvery=(duration:number)=>Math.max(0.5,Math.ceil(duration/4000*4)/4);

export interface Span {start:number;end:number;frame:number}

/**
 * Where the picture changes, from grey frames `every` seconds apart. Each
 * moment runs from a change to the next; its frame is the last steady one
 * before the next change, when a drawing or a page looks complete.
 */
export function changeSpans(pixels:Uint8Array,o:{every:number;duration:number;width?:number;height?:number}):Span[] {
  const n=(o.width??SAMPLE_W)*(o.height??SAMPLE_H),count=Math.floor(pixels.length/n),every=o.every;
  if(!count)return [{start:0,end:o.duration,frame:o.duration/2}];
  const f=(i:number)=>pixels.subarray(i*n,(i+1)*n);
  const busy=new Uint32Array(n);
  for(let i=1;i<count;i++){const a=f(i-1),b=f(i);for(let k=0;k<n;k++)if(Math.abs(a[k]!-b[k]!)>PIXEL_STEP)busy[k]!++;}
  const steady=new Uint8Array(n);for(let k=0;k<n;k++)steady[k]=busy[k]!<=BUSY_SHARE*count?1:0;
  const diff=(a:Uint8Array,b:Uint8Array)=>{let all=0,quiet=0;for(let k=0;k<n;k++)if(Math.abs(a[k]!-b[k]!)>PIXEL_STEP){all++;quiet+=steady[k]!;}return {all:all/n,quiet:quiet/n};};
  const starts:number[]=[0];
  let anchor=0;
  for(let i=1;i<count;i++) {
    const x=diff(f(anchor),f(i));
    if(x.all<=LOUD_SHARE&&x.quiet<=QUIET_SHARE)continue;
    // Let a scroll or a stroke finish before the next comparison.
    let j=i;
    while(j+1<count&&diff(f(j),f(j+1)).all>0.002)j++;
    if(i*every-starts.at(-1)!>=MOMENT_MIN)starts.push(i*every);
    anchor=j;i=j;
  }
  const spans:Span[]=[];
  starts.forEach((s,k)=>{
    const end=k+1<starts.length?starts[k+1]!:o.duration;
    const parts=Math.max(1,Math.ceil((end-s)/MOMENT_MAX));
    for(let p=0;p<parts;p++) {
      const a=s+(end-s)*p/parts,b=s+(end-s)*(p+1)/parts;
      spans.push({start:+a.toFixed(2),end:+b.toFixed(2),frame:+Math.max(a,Math.min(b-every,o.duration-0.1)).toFixed(2)});
    }
  });
  return spans.filter(s=>s.end>s.start);
}

/** Even spans when the frame host cannot sample (an older desktop). */
export const evenSpans=(duration:number,step=10):Span[]=>Array.from({length:Math.max(1,Math.ceil(duration/step))},(_,k)=>{
  const start=k*step,end=Math.min(duration,start+step);
  return {start,end,frame:Math.max(start,end-0.5)};
});

export interface MomentWord {text:string;start:number;end:number}
export interface UnderstandInput {
  hash:string;
  duration:number;
  /** Speech heard during the clip, on its own clock: its own words, or a synced speaker's. */
  words:MomentWord[];
  frames:FrameHost;
}
export interface UnderstandOptions {batch?:number;concurrency?:number;width?:number;progress?:(message:string)=>void}

const str=(x:unknown,max:number)=>typeof x==='string'?x.trim().slice(0,max):'';
const strs=(x:unknown,n:number,max:number)=>Array.isArray(x)?x.filter((v):v is string=>typeof v==='string'&&v.trim()!=='').slice(0,n).map(v=>v.trim().slice(0,max)):[];
const spoken=(words:MomentWord[],start:number,end:number)=>words.filter(w=>w.start>=start&&w.start<end).map(w=>w.text).join(' ').slice(0,600);

async function pool<T>(items:T[],n:number,fn:(x:T)=>Promise<void>):Promise<void> {
  let next=0;
  await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(next<items.length)await fn(items[next++]!);}));
}

/** Frames per call to the frame host (a relay answer carries at most 64 files). */
const FRAME_BATCH=48;

/**
 * Dense provider: change detection over the whole clip, then a vision model
 * describes the frame closing each moment, a batch of consecutive moments per
 * call so it can say what changed.
 */
export async function denseMoments(input:UnderstandInput,model:VisionModel,o:UnderstandOptions={}):Promise<ClipMoments> {
  const t0=Date.now(),every=sampleEvery(input.duration);
  let spans=evenSpans(input.duration);
  if(input.frames.sample) {
    o.progress?.('Looking for every change in the picture');
    // An older desktop cannot sample: even spans, coarser but still described.
    try {spans=changeSpans(await input.frames.sample(input.hash,every,SAMPLE_W,SAMPLE_H),{every,duration:input.duration});}
    catch(e) {o.progress?.(`Change detection failed, using even spans: ${e instanceof Error?e.message:e}`);}
  }
  const ids=spans.map((_,k)=>`M${String(k+1).padStart(3,'0')}`);
  const jpegs:(Uint8Array|null)[]=[];
  for(let i=0;i<spans.length;i+=FRAME_BATCH)jpegs.push(...await input.frames.frames(input.hash,spans.slice(i,i+FRAME_BATCH).map(s=>s.frame),o.width??1024));
  o.progress?.(`Describing ${spans.length} moments`);
  const system=promptText(MOMENTS_PROMPT_ID);
  const labels=new Map<string,any>();
  let cost=0,used='';
  const size=o.batch??12;
  const batches:number[][]=[];
  for(let i=0;i<spans.length;i+=size)batches.push(Array.from({length:Math.min(size,spans.length-i)},(_,k)=>i+k));
  const call=async(b:number[])=>{
    const parts:VisionPart[]=[];
    for(const k of b) {
      const s=spans[k]!,said=spoken(input.words,s.start,s.end);
      parts.push({type:'text',text:`${ids[k]} [${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] words: ${said||'(none)'}`});
      if(jpegs[k])parts.push({type:'image',jpeg:jpegs[k]!});
    }
    const r=await model(system,parts);
    cost+=r.costUsd??0;used=r.model;
    const want=new Set(b.map(k=>ids[k]!));
    const got=(r.json as any)?.moments;
    for(const x of Array.isArray(got)?got:[])if(typeof x?.id==='string'&&want.has(x.id)&&!labels.has(x.id))labels.set(x.id,x);
  };
  let done=0;
  await pool(batches,o.concurrency??3,async b=>{
    try{await call(b);}catch(e){o.progress?.(`Moments batch failed: ${e instanceof Error?e.message:e}`);}
    o.progress?.(`Described ${done+=b.length}/${spans.length} moments`);
  });
  const retry=batches.map(b=>b.filter(k=>!labels.has(ids[k]!))).filter(b=>b.length);
  await pool(retry,o.concurrency??3,async b=>{try{await call(b);}catch(e){o.progress?.(`Moments retry failed: ${e instanceof Error?e.message:e}`);}});
  if(spans.length&&!labels.size)throw new Error('The model described no moments');
  const moments=spans.map((s,k)=>{
    const raw=labels.get(ids[k]!);
    return {id:ids[k]!,start:s.start,end:s.end,frame:s.frame,description:str(raw?.description,1000),changed:str(raw?.changed,300),
      onScreenText:strs(raw?.onScreenText,8,200),subjects:strs(raw?.subjects,12,120)};
  });
  return clipMomentsSchema.parse({clipHash:input.hash,provider:'dense',model:used,promptVersion:momentsPromptVersion(),every,moments,
    costUsd:Math.round(cost*1e6)/1e6,ms:Date.now()-t0});
}

/** Two clips on one clock: `clip` time = `with` time + offset. */
export interface ClipSync {clip:string;with:string;offset:number}
export interface SyncClip {id:string;kind:string;role?:string;duration:number;hasAudio:boolean;speaks:boolean}

/**
 * Clips recorded together. A recorder that takes screen and camera at once
 * (BlitzRecorder, OBS, Riverside) writes files of the same length that start
 * together; a non-speaking video that long beside a speaking clip shares its
 * clock. Audio cross-correlation for files that start apart is open.
 */
export function syncClips(clips:SyncClip[],tolerance=1):ClipSync[] {
  const out:ClipSync[]=[];
  for(const c of clips) {
    if(c.kind!=='video'||c.speaks||c.duration<20)continue;
    const partner=clips.filter(s=>s.speaks&&s.id!==c.id&&Math.abs(s.duration-c.duration)<=tolerance)
      .sort((a,b)=>Math.abs(a.duration-c.duration)-Math.abs(b.duration-c.duration))[0];
    if(partner)out.push({clip:c.id,with:partner.id,offset:0});
  }
  return out;
}
