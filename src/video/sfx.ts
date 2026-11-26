// Sound effects: a small library made here by code (no download, no licence
// to clear: we own every sample), where each hit peaks, and where the agent's
// hits land. The sounds are synthesised in plain TS with a fixed random seed,
// so the bytes, and so the hash an EditDoc names them by, are the same on
// every machine: any host can make the file again from its name.
import {createHash} from 'node:crypto';
import {mkdir,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {ClipRef} from '@voxtale/editdoc';

export const SFX_RATE=48000;

/** The library's sounds, by what they mark. */
export const SFX_SOUNDS={
  whoosh:'a pass of air: a change of scene, footage or a card sliding in',
  impact:'a low hit: a reveal, a number, the one line that lands; one to three a video',
  riser:'a rising tone that peaks on its end: builds into a reveal or a chapter',
  click:'a short dry click: a word or a box appearing, a cursor, a UI tap',
  pop:'a soft bubble pop: a callout or a sticker popping on',
} as const;
export type SfxSound=keyof typeof SFX_SOUNDS;
export const SFX_SOUND_IDS=Object.keys(SFX_SOUNDS) as [SfxSound,...SfxSound[]];

/**
 * How far under the voice each sound sits, dB of its loudest moment against
 * the speech target. REDACTED's ranges (click −6..−10, whoosh −10..−14, tick
 * −16..−20) at their middle; impact and riser are our pick.
 */
export const SFX_UNDER_VOICE:Record<SfxSound|'tick'|'sweep',number>={click:-8,pop:-10,whoosh:-12,impact:-10,riser:-14,tick:-18,sweep:-12};

// ---- synthesis ------------------------------------------------------------------

function rng(seed:number):()=>number {
  // mulberry32: same numbers everywhere.
  return ()=>{seed|=0;seed=seed+0x6d2b79f5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};
}
const white=(n:number,seed:number)=>{const r=rng(seed);return Float64Array.from({length:n},()=>r()*2-1);};
/** Pink noise (Paul Kellet's filter). */
function pink(n:number,seed:number):Float64Array {
  const w=white(n,seed),out=new Float64Array(n);
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for(let i=0;i<n;i++) {
    const x=w[i]!;
    b0=0.99886*b0+x*0.0555179;b1=0.99332*b1+x*0.0750759;b2=0.969*b2+x*0.153852;
    b3=0.8665*b3+x*0.3104856;b4=0.55*b4+x*0.5329522;b5=-0.7616*b5-x*0.016898;
    out[i]=(b0+b1+b2+b3+b4+b5+b6+x*0.5362)*0.11;b6=x*0.115926;
  }
  return out;
}
/** RBJ biquad, run in place. */
function biquad(x:Float64Array,kind:'bandpass'|'highpass',f:number,q:number):Float64Array {
  const w=2*Math.PI*f/SFX_RATE,a=Math.sin(w)/(2*q),c=Math.cos(w);
  const [b0,b1,b2]=kind==='bandpass'?[a,0,-a]:[(1+c)/2,-(1+c),(1+c)/2];
  const a0=1+a,a1=-2*c,a2=1-a;
  let x1=0,x2=0,y1=0,y2=0;
  for(let i=0;i<x.length;i++) {
    const y=(b0*x[i]!+b1*x1+b2*x2-a1*y1-a2*y2)/a0;
    x2=x1;x1=x[i]!;y2=y1;y1=y;x[i]=y;
  }
  return x;
}
/** Exponential fade shape (ffmpeg afade curve=exp, near enough): 0→1 over x in [0,1]. */
const expIn=(x:number)=>Math.max(0,Math.min(1,x))**3;
const fadeIn=(x:Float64Array,from:number,d:number,curve=expIn)=>{for(let i=0;i<x.length;i++){const t=i/SFX_RATE;if(t<from+d)x[i]=x[i]!*(t<from?0:curve((t-from)/d));}return x;};
const fadeOut=(x:Float64Array,from:number,d:number,curve=expIn)=>{for(let i=0;i<x.length;i++){const t=i/SFX_RATE;if(t>=from)x[i]=x[i]!*curve(1-(t-from)/d);}return x;};
const len=(s:number)=>Math.round(s*SFX_RATE);

const RECIPES:Record<SfxSound,()=>Float64Array>={
  // anoisesrc pink 0.6s, bandpass 1200 Hz 1.5 octaves, fade in 0.35s, out 0.25s: peaks at 0.35s.
  whoosh:()=>fadeOut(fadeIn(biquad(pink(len(0.6),11).map(v=>v*0.8),'bandpass',1200,0.67),0,0.35),0.35,0.25),
  // 60 Hz sine 0.6s fading out, plus a 80 ms white noise click on top.
  impact:()=>{
    const x=fadeOut(Float64Array.from({length:len(0.6)},(_,i)=>Math.sin(2*Math.PI*60*i/SFX_RATE)),0,0.55);
    const n=fadeOut(white(len(0.08),23),0,0.08,t=>t);
    for(let i=0;i<n.length;i++)x[i]=x[i]!+n[i]!;
    return x;
  },
  // 0.4·sin(2π(150t+300t²)) for 1.5s, fade in 1.4s, out the last 50 ms: peaks at its end.
  riser:()=>fadeOut(fadeIn(Float64Array.from({length:len(1.5)},(_,i)=>{const t=i/SFX_RATE;return 0.4*Math.sin(2*Math.PI*(150*t+300*t*t));}),0,1.4),1.45,0.05,t=>t),
  // 12 ms of white noise over 2 kHz, fading out.
  click:()=>fadeOut(biquad(white(len(0.012),37).map(v=>v*0.9),'highpass',2000,0.707),0,0.012,t=>t),
  // 0.8·sin(2π(900t−3000t²)) for 0.12s, 3 ms in, 0.1s out.
  pop:()=>fadeOut(fadeIn(Float64Array.from({length:len(0.12)},(_,i)=>{const t=i/SFX_RATE;return 0.8*Math.sin(2*Math.PI*(900*t-3000*t*t));}),0,0.003,t=>t),0.02,0.1),
};

/** Peak of the library's files: −3 dBFS, so the gain alone sets the level. */
const PEAK=10**(-3/20);
/** Shortest library file: a sound under a frame long would snap to nothing on the timeline. Silence fills the rest. */
const MIN_SECONDS=0.25;

export interface LibrarySound {sound:SfxSound;samples:Float32Array;wav:Uint8Array;hash:string;duration:number;peak:number;levelDb:number}

function wav16(x:Float32Array):Uint8Array {
  const b=new ArrayBuffer(44+x.length*2),v=new DataView(b);
  const s=(o:number,t:string)=>{for(let i=0;i<t.length;i++)v.setUint8(o+i,t.charCodeAt(i));};
  s(0,'RIFF');v.setUint32(4,36+x.length*2,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,SFX_RATE,true);v.setUint32(28,SFX_RATE*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,x.length*2,true);
  for(let i=0;i<x.length;i++)v.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,x[i]!))*32767),true);
  return new Uint8Array(b);
}

const cache=new Map<SfxSound,LibrarySound>();
/** One library sound: samples, WAV bytes, hash, where it peaks and how loud that moment is. */
export function librarySound(sound:SfxSound):LibrarySound {
  const hit=cache.get(sound);
  if(hit)return hit;
  const raw=RECIPES[sound]();
  const top=raw.reduce((m,v)=>Math.max(m,Math.abs(v)),0)||1;
  const samples=new Float32Array(Math.max(raw.length,len(MIN_SECONDS)));
  raw.forEach((v,i)=>{samples[i]=v/top*PEAK;});
  const wav=wav16(samples);
  const p=soundPeak(samples,SFX_RATE);
  const out={sound,samples,wav,hash:createHash('sha256').update(wav).digest('hex'),duration:samples.length/SFX_RATE,peak:p.t,levelDb:p.db};
  cache.set(sound,out);
  return out;
}

/** Clip id of a library sound in an EditDoc. */
export const libraryClipId=(s:SfxSound)=>`sfx-lib-${s}`;
export const isLibraryClip=(id:string)=>id.startsWith('sfx-lib-');

/** A library sound as an EditDoc clip. */
export function libraryClip(sound:SfxSound):ClipRef {
  const s=librarySound(sound);
  return {id:libraryClipId(sound),hash:s.hash,name:`VoxTale ${sound}.wav`,kind:'audio',role:'sfx',roleSource:'index',duration:s.duration,hasAudio:true,timecodeStart:0};
}

/** Library sound by hash, for renders: the file is made again from its name. */
export function libraryByHash(hash:string):LibrarySound|undefined {
  for(const s of SFX_SOUND_IDS){const l=librarySound(s);if(l.hash===hash)return l;}
  return undefined;
}

/** Write the library sounds among `hashes` into `dir`; hash → file. */
export async function writeLibrary(dir:string,hashes:Iterable<string>):Promise<Record<string,string>> {
  const out:Record<string,string>={};
  for(const h of new Set(hashes)) {
    const s=libraryByHash(h);
    if(!s)continue;
    const f=join(dir,`sfx-${s.sound}.wav`);
    if(!(await stat(f).catch(()=>null))){await mkdir(dir,{recursive:true});await writeFile(f,s.wav);}
    out[h]=f;
  }
  return out;
}

// ---- measuring ------------------------------------------------------------------

/**
 * Where a sound peaks: the loudest 10 ms, seconds into the file, and its
 * level (dBFS RMS of that 10 ms). A hit is placed so this lands on the gesture.
 */
export function soundPeak(samples:Float32Array,rate:number):{t:number;db:number} {
  const w=Math.max(1,Math.round(rate/100));
  let best=0,at=0;
  for(let i=0;i+w<=samples.length;i+=Math.max(1,w>>1)) {
    let s=0;
    for(let j=i;j<i+w;j++)s+=samples[j]!*samples[j]!;
    if(s>best){best=s;at=i;}
  }
  return {t:(at+w/2)/rate,db:best>0?10*Math.log10(best/w):-120};
}

// ---- checking -------------------------------------------------------------------

/** Two hits closer than this read as a rattle. */
export const SFX_MIN_GAP=0.4;
/** The same sound again within this, at the same level, reads as a machine gun. */
export const SFX_REPEAT_GAP=1.5;
/** A hit this close to the voice level (or over it) fights the words. */
export const SFX_LOUD_MARGIN=4;

export interface PlacedHit {id:string;sound:string;at:number;gainDb:number;
  /** dB of the hit's loudest moment against the speech target (negative = under the voice). */
  againstVoiceDb?:number}

/** What check_cut says about the effects: hits too close, the same one rattling, hits as loud as the voice. */
export function sfxWarnings(hits:PlacedHit[]):string[] {
  const out:string[]=[];
  const xs=[...hits].sort((a,b)=>a.at-b.at);
  for(let k=1;k<xs.length;k++) {
    const a=xs[k-1]!,b=xs[k]!,gap=b.at-a.at;
    if(gap<SFX_MIN_GAP)out.push(`${a.id} and ${b.id} hit ${gap.toFixed(2)}s apart (under ${SFX_MIN_GAP}s): drop one, or use one sound for the group`);
    else if(a.sound===b.sound&&gap<SFX_REPEAT_GAP&&Math.abs(a.gainDb-b.gainDb)<2)
      out.push(`${a.id} and ${b.id}: the same ${a.sound} ${gap.toFixed(2)}s apart at the same level (machine gun): alternate two sounds, or step the second down 3-4 dB`);
  }
  for(const h of xs)if(h.againstVoiceDb!==undefined&&h.againstVoiceDb>-SFX_LOUD_MARGIN)
    out.push(`${h.id} (${h.sound} @${h.at.toFixed(1)}s) peaks ${h.againstVoiceDb>=0?`${h.againstVoiceDb.toFixed(1)} dB over`:`only ${(-h.againstVoiceDb).toFixed(1)} dB under`} the voice: level down`);
  return out;
}
