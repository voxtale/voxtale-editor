// Beat grid: the tempo of a music file and where its first beat falls, found
// by code from the sound itself. Cuts and picture changes snap to this grid
// when music plays under them. A file with no steady pulse gets no grid.
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BEAT_CONFIDENCE_MIN,type EditDoc} from '@voxtale/editdoc';

export interface Beats {
  /** Beats per minute. */
  bpm:number;
  /** Seconds into the file of the first beat. */
  first:number;
  /** 0–1: how many grid beats land on a clear hit. Calm or floating music scores low; under BEAT_CONFIDENCE_MIN nothing snaps. */
  confidence?:number;
  /** Seconds into the file where the track comes alive: the default in-point. */
  livelyFrom?:number;
}

/** Envelope frames per second. */
const FPS=100;
const BPM_MIN=60,BPM_MAX=180;
/** Tempos near this are the likeliest reading of a pulse and its half or double. */
const BPM_CENTRE=110;
/** How much the grid's beats must stand out of the track to count as a pulse. */
const MIN_CONTRAST=1.8;
/** Sample rate the finder reads. */
export const BEAT_RATE=11025;
/** Seconds of the file read: tempo is found once, from its start. */
export const BEAT_SECONDS=120;

/** How strongly sound starts at each 10 ms step: rises in loudness, with the slow swell taken out. */
function onsets(samples:Float32Array,rate:number):Float32Array {
  const hop=Math.round(rate/FPS),n=Math.floor(samples.length/hop);
  const e=new Float32Array(n);
  for(let i=0;i<n;i++) {
    let s=0;
    for(let j=i*hop;j<(i+1)*hop;j++)s+=samples[j]!*samples[j]!;
    e[i]=Math.log1p(1000*Math.sqrt(s/hop));
  }
  const flux=new Float32Array(n);
  for(let i=1;i<n;i++)flux[i]=Math.max(0,e[i]!-e[i-1]!);
  // Less the mean of the second around it, so a loud passage does not outvote a quiet one.
  const out=new Float32Array(n),w=FPS/2;
  let sum=0;
  for(let i=0;i<Math.min(n,w);i++)sum+=flux[i]!;
  for(let i=0;i<n;i++) {
    if(i+w<n)sum+=flux[i+w]!;
    if(i-w-1>=0)sum-=flux[i-w-1]!;
    const count=Math.min(n-1,i+w)-Math.max(0,i-w)+1;
    out[i]=Math.max(0,flux[i]!-sum/count);
  }
  // A little blur: a beat a frame early or late still counts.
  const soft=new Float32Array(n);
  for(let i=0;i<n;i++)soft[i]=((out[i-1]??0)+2*out[i]!+(out[i+1]??0))/4;
  return soft;
}

const at=(o:Float32Array,x:number):number=>{
  const i=Math.floor(x),f=x-i;
  return (o[i]??0)*(1-f)+(o[i+1]??0)*f;
};

/** Mean onset strength on a grid of `period` frames starting at `phase`. */
function comb(o:Float32Array,period:number,phase:number):number {
  let s=0,k=0;
  for(let x=phase;x<o.length-1;x+=period){s+=at(o,x);k++;}
  return k?s/k:0;
}

/**
 * Tempo and first beat of mono samples. Undefined when the sound has no
 * steady pulse (speech, ambient pads, free time).
 */
export function findBeats(samples:Float32Array,rate:number):Beats|undefined {
  const o=onsets(samples,rate);
  // The real step: the hop is a whole number of samples.
  const fps=rate/Math.round(rate/FPS);
  if(o.length<fps*8)return undefined;
  let mean=0;
  for(const v of o)mean+=v;
  mean/=o.length;
  if(mean<=0)return undefined;
  // Coarse tempo: how well the track matches itself one beat later (and two).
  const lagMin=Math.floor(60*fps/BPM_MAX),lagMax=Math.ceil(60*fps/BPM_MIN);
  const corr=(lag:number)=>{
    let s=0;
    for(let i=0;i+lag<o.length;i++)s+=o[i]!*o[i+lag]!;
    return s/(o.length-lag);
  };
  let best=0,bestScore=-1;
  for(let lag=lagMin;lag<=lagMax;lag++) {
    const bpm=60*fps/lag;
    const prior=Math.exp(-0.5*(Math.log2(bpm/BPM_CENTRE)/0.6)**2);
    const score=(corr(lag)+0.5*corr(lag*2))*prior;
    if(score>bestScore){bestScore=score;best=lag;}
  }
  // Fine tempo and phase: the grid that lands on the most onsets. A hundredth
  // of a frame matters: the error adds up over every beat of the track.
  let period=best,phase=0,strength=-1;
  for(let p=best-1;p<=best+1;p+=0.01) {
    for(let ph=0;ph<p;ph+=1) {
      const s=comb(o,p,ph);
      if(s>strength){strength=s;period=p;phase=ph;}
    }
  }
  for(let ph=Math.max(0,phase-1);ph<=phase+1;ph+=0.1) {
    const s=comb(o,period,ph);
    if(s>strength){strength=s;phase=ph;}
  }
  if(strength<mean*MIN_CONTRAST)return undefined;
  while(phase>=period)phase-=period;
  return {bpm:Math.round(60*fps/period*100)/100,first:Math.round(phase/fps*1000)/1000,
    confidence:gridConfidence(o,period,phase),livelyFrom:livelyFrom(samples,rate,o,fps)};
}

/**
 * Does each beat of the grid have a clear hit within 20 ms? Mean over the
 * beats of the hit's strength against the track's strong hits (its 90th
 * percentile), capped at 1.
 */
function gridConfidence(o:Float32Array,period:number,phase:number):number {
  const sorted=Float32Array.from(o).sort(),top=sorted[Math.floor(sorted.length*0.9)]!;
  if(!(top>0))return 0;
  let s=0,k=0;
  for(let x=phase;x<o.length-2;x+=period) {
    const i=Math.round(x);
    s+=Math.min(1,Math.max(o[i-2]??0,o[i-1]??0,o[i]??0,o[i+1]??0,o[i+2]??0)/top);k++;
  }
  return k?Math.round(s/k*100)/100:0;
}

/**
 * Where the track comes alive: the first second at the level of its body
 * (within 6 dB of its loud seconds), then within a second of that the biggest
 * step up, then the strongest hit in the half second after. Means in dB, not
 * power: one lone hit in the intro does not count as the start.
 */
export function livelyFrom(samples:Float32Array,rate:number,o?:Float32Array,fps?:number):number {
  const n=Math.round(rate/10),blocks=Math.floor(samples.length/n);
  if(blocks<2)return 0;
  const db=new Float64Array(blocks);
  for(let b=0;b<blocks;b++){let p=0;for(let j=b*n;j<(b+1)*n;j++)p+=samples[j]!*samples[j]!;db[b]=10*Math.log10(p/n+1e-10);}
  const c=new Float64Array(blocks+1);
  for(let i=0;i<blocks;i++)c[i+1]=c[i]!+db[i]!;
  const after=Float64Array.from({length:blocks},(_,i)=>{const a=Math.min(i+10,blocks);return (c[a]!-c[i]!)/(a-i);});
  const before=Float64Array.from({length:blocks},(_,i)=>{const b=Math.max(i-10,0);return i>0?(c[i]!-c[b]!)/Math.max(i-b,1):-100;});
  const p90=Float64Array.from(after).sort()[Math.floor(blocks*0.9)]!;
  const first=Math.max(0,after.findIndex(v=>v>=p90-6));
  let start=first,step=-Infinity;
  for(let i=Math.max(first-10,0);i<=Math.min(first+10,blocks-1);i++)if(after[i]!-before[i]!>step){step=after[i]!-before[i]!;start=i;}
  let t=start/10;
  // On the hit that starts the lively part (the loudest in the half second), not on a 100 ms block edge.
  if(o&&fps) {
    let best=0;
    for(let i=Math.max(0,Math.round((t-0.1)*fps));i<Math.min(o.length,Math.round((t+0.5)*fps));i++)if(o[i]!>best){best=o[i]!;t=i/fps;}
  }
  return Math.round(t*1000)/1000;
}

/** Beats of a sound file on this machine; `ff` runs ffmpeg with these arguments. */
export async function beatsOfFile(path:string,ff:(args:string[])=>Promise<void>):Promise<Beats|undefined> {
  const dir=await mkdtemp(join(tmpdir(),'voxtale-beats-'));
  try {
    const raw=join(dir,'a.f32');
    await ff(['-t',String(BEAT_SECONDS),'-i',path,'-vn','-ac','1','-ar',String(BEAT_RATE),'-f','f32le','-c:a','pcm_f32le',raw]);
    const buf=await readFile(raw);
    return findBeats(new Float32Array(buf.buffer,buf.byteOffset,Math.floor(buf.byteLength/4)),BEAT_RATE);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
}

export interface BeatGrid {
  /** Output-timeline seconds of every beat under the edit, in order. */
  times:number[];
  /** Tempo of the first bed, for reports. */
  bpm:number;
}

type Bed={clipId:string;in:number;start:number;end:number;status:string};

/** A bed's beats are too loose to cut to (calm, floating or rubato music). Unmeasured confidence counts as firm. */
export const weakBeats=(b:{confidence?:number}|undefined)=>b?.confidence!==undefined&&b.confidence<BEAT_CONFIDENCE_MIN;

/**
 * The beats of the music laid under an edit, on its timeline. With `firm`,
 * beds whose beat is weak are left out: picture changes snap only to a
 * pulse a viewer hears.
 */
export function beatGrid(doc:Pick<EditDoc,'clips'>,music:Bed[],opts:{firm?:boolean}={}):BeatGrid|undefined {
  const clips=new Map(doc.clips.map(c=>[c.id,c]));
  const times:number[]=[];
  let bpm=0;
  for(const m of music) {
    const b=clips.get(m.clipId)?.beats;
    if(!b||m.status==='suggested'||(opts.firm&&weakBeats(b)))continue;
    bpm||=b.bpm;
    const period=60/b.bpm;
    // First beat of the file at or after the bed's in point.
    const k0=Math.ceil((m.in-b.first)/period-1e-9);
    for(let k=Math.max(0,k0);;k++) {
      const t=m.start+b.first+k*period-m.in;
      if(t>=m.end)break;
      times.push(t);
    }
  }
  return times.length?{times:times.sort((a,b)=>a-b),bpm}:undefined;
}

/** Beds under the edit whose beat was too weak to snap to, with their tempo and confidence. */
export function weakBeds(doc:Pick<EditDoc,'clips'>,music:Bed[]):{clipId:string;bpm:number;confidence:number}[] {
  const clips=new Map(doc.clips.map(c=>[c.id,c])),seen=new Set<string>();
  return music.flatMap(m=>{
    const b=clips.get(m.clipId)?.beats;
    if(!b||m.status==='suggested'||!weakBeats(b)||seen.has(m.clipId))return [];
    seen.add(m.clipId);
    return [{clipId:m.clipId,bpm:b.bpm,confidence:b.confidence!}];
  });
}

/** The beat nearest `t`, when one is within `reach` seconds. */
export function nearestBeat(grid:BeatGrid|undefined,t:number,reach:number):number|undefined {
  if(!grid)return undefined;
  let lo=0,hi=grid.times.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(grid.times[mid]!<t)lo=mid+1;else hi=mid;}
  const cands=[grid.times[lo-1],grid.times[lo]].filter((x):x is number=>x!==undefined);
  const best=cands.sort((a,b)=>Math.abs(a-t)-Math.abs(b-t))[0];
  return best!==undefined&&Math.abs(best-t)<=reach?best:undefined;
}
