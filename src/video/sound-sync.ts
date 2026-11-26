// Line up cameras and mics recorded together by their sound, pick who is
// talking, and measure a clip's sound against its picture (A/V offset).
// Method from REDACTED REDACTED/sync.py: 8 kHz mono, a 500 Hz loudness
// envelope (mean |x| over 16 samples), log-compressed and normalised, then
// FFT cross-correlation; confidence = peak over the median |c|, sure from 8.
import {ffmpegPath} from './ffmpeg-path';

export const SYNC_RATE=8000;
const HOP=16;
export const ENVELOPE_RATE=SYNC_RATE/HOP;

/** Mono 8 kHz float samples of a file's first sound track (local ffmpeg, no network). */
export async function decodeMono(path:string,o:{rate?:number;seconds?:number;signal?:AbortSignal}={}):Promise<Float32Array> {
  const args=['-hide_banner','-nostdin','-v','error','-i',path,'-map','0:a:0','-ac','1','-ar',String(o.rate??SYNC_RATE),...(o.seconds?['-t',String(o.seconds)]:[]),'-f','f32le','-'];
  const p=Bun.spawn([ffmpegPath(),...args],{stdout:'pipe',stderr:'pipe',signal:o.signal});
  const [buf,err,code]=await Promise.all([new Response(p.stdout).arrayBuffer(),new Response(p.stderr).text(),p.exited]);
  if(code)throw new Error(`ffmpeg decode ${path}: ${err.slice(-300)}`);
  return new Float32Array(buf.slice(0,buf.byteLength-(buf.byteLength%4)));
}

/** Loudness envelope: mean |x| per 16 samples, log1p(1000 e), zero mean, unit spread. */
export function envelope(x:Float32Array,hop=HOP):Float64Array {
  const n=Math.floor(x.length/hop),e=new Float64Array(n);
  for(let i=0;i<n;i++) {
    let s=0;
    for(let k=0;k<hop;k++)s+=Math.abs(x[i*hop+k]!);
    e[i]=Math.log1p((s/hop)*1000);
  }
  let m=0;for(const v of e)m+=v;m/=n||1;
  let sd=0;for(const v of e)sd+=(v-m)**2;sd=Math.sqrt(sd/(n||1))||1;
  for(let i=0;i<n;i++)e[i]=(e[i]!-m)/sd;
  return e;
}

/** In-place radix-2 FFT (inverse when `inv`, unscaled). */
function fft(re:Float64Array,im:Float64Array,inv=false) {
  const n=re.length;
  for(let i=1,j=0;i<n;i++) {
    let bit=n>>1;
    for(;j&bit;bit>>=1)j^=bit;
    j^=bit;
    if(i<j){[re[i],re[j]]=[re[j]!,re[i]!];[im[i],im[j]]=[im[j]!,im[i]!];}
  }
  for(let len=2;len<=n;len<<=1) {
    const a=(inv?2:-2)*Math.PI/len,wr=Math.cos(a),wi=Math.sin(a);
    for(let i=0;i<n;i+=len) {
      let cr=1,ci=0;
      for(let k=0;k<len/2;k++) {
        const p=i+k,q=p+len/2,xr=re[q]!*cr-im[q]!*ci,xi=re[q]!*ci+im[q]!*cr;
        re[q]=re[p]!-xr;im[q]=im[p]!-xi;re[p]=re[p]!+xr;im[p]=im[p]!+xi;
        const t=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=t;
      }
    }
  }
}

/**
 * Where `b` sits on `a`: b[t] matches a[t + lag]. Lag in samples (positive:
 * b starts later), confidence = peak over the median |c|. `maxLag` bounds the search.
 */
export function crossCorrelate(a:ArrayLike<number>,b:ArrayLike<number>,maxLag=Infinity):{lag:number;confidence:number} {
  let n=1;while(n<a.length+b.length)n<<=1;
  const ar=new Float64Array(n),ai=new Float64Array(n),br=new Float64Array(n),bi=new Float64Array(n);
  for(let i=0;i<a.length;i++)ar[i]=a[i]!;
  for(let i=0;i<b.length;i++)br[i]=b[i]!;
  fft(ar,ai);fft(br,bi);
  for(let i=0;i<n;i++){const r=ar[i]!*br[i]!+ai[i]!*bi[i]!,m=ai[i]!*br[i]!-ar[i]!*bi[i]!;ar[i]=r;ai[i]=m;}
  fft(ar,ai,true);
  let best=-Infinity,lag=0;
  const abs:number[]=[];
  for(let i=0;i<n;i++) {
    const k=i<=n/2?i:i-n;
    if(k>a.length||-k>b.length||Math.abs(k)>maxLag)continue;
    const v=ar[i]!/n;
    abs.push(Math.abs(v));
    if(v>best){best=v;lag=k;}
  }
  abs.sort((x,y)=>x-y);
  const med=abs[Math.floor(abs.length/2)]||1e-9;
  return {lag,confidence:best/med};
}

/**
 * Each file's start on a shared clock from its envelope: pairwise matches,
 * then a tree of the surest links from the first file. Files no sure link
 * reaches come back without a start.
 */
export function placeBySound(envs:readonly {clipId:string;env:Float64Array}[],o:{rate?:number;min?:number}={}):{clipId:string;start?:number;confidence?:number}[] {
  const rate=o.rate??ENVELOPE_RATE,min=o.min??8;
  const pair=new Map<string,{lag:number;confidence:number}>();
  for(let i=0;i<envs.length;i++)for(let j=i+1;j<envs.length;j++)pair.set(`${i},${j}`,crossCorrelate(envs[i]!.env,envs[j]!.env));
  const start=new Map<number,number>([[0,0]]),conf=new Map<number,number>();
  for(;;) {
    let pick:{to:number;at:number;c:number}|null=null;
    for(const [key,m] of pair) {
      const [i,j]=key.split(',').map(Number) as [number,number];
      if(m.confidence<min)continue;
      const from=start.has(i)&&!start.has(j)?i:start.has(j)&&!start.has(i)?j:-1;
      if(from<0)continue;
      const to=from===i?j:i,at=start.get(from)!+(from===i?m.lag:-m.lag)/rate;
      if(!pick||m.confidence>pick.c)pick={to,at,c:m.confidence};
    }
    if(!pick)break;
    start.set(pick.to,pick.at);conf.set(pick.to,pick.c);
  }
  return envs.map((e,i)=>({clipId:e.clipId,...(start.has(i)?{start:start.get(i)!}:{}),...(conf.has(i)?{confidence:conf.get(i)!}:{})}));
}

/** Level in dB per `step` seconds (RMS), for picking the active mic or angle. */
export function activityLevels(x:Float32Array,rate=SYNC_RATE,step=0.1):number[] {
  const hop=Math.max(1,Math.round(rate*step)),out:number[]=[];
  for(let i=0;i+hop<=x.length;i+=hop) {
    let s=0;for(let k=i;k<i+hop;k++)s+=x[k]!*x[k]!;
    out.push(Math.max(-90,10*Math.log10(s/hop+1e-12)));
  }
  return out;
}

/**
 * A clip's A/V offset from mouth motion and loudness, one value per frame:
 * the lag (within ±maxLag s) where they agree best. Positive: the sound is
 * early, move it later. Null when the match is weak (confidence < 3).
 */
export function avOffsetFrom(motion:readonly number[],loud:readonly number[],fps:number,maxLag=0.5):{offset:number;confidence:number}|null {
  const z=(xs:readonly number[])=>{const m=xs.reduce((s,x)=>s+x,0)/(xs.length||1),sd=Math.sqrt(xs.reduce((s,x)=>s+(x-m)**2,0)/(xs.length||1))||1;return xs.map(x=>(x-m)/sd);};
  const r=crossCorrelate(z(motion),z(loud),Math.round(maxLag*fps));
  return r.confidence>=3?{offset:Math.round(r.lag/fps*1000)/1000,confidence:r.confidence}:null;
}

/**
 * Measure a video's A/V offset over its first `seconds`: frame-to-frame
 * change in a mouth box (fractions of the frame; default lower middle)
 * against sound level per frame. Local ffmpeg only.
 */
export async function measureAvOffset(path:string,fps:number,o:{box?:{x:number;y:number;w:number;h:number};seconds?:number;signal?:AbortSignal}={}):Promise<{offset:number;confidence:number}|null> {
  const b=o.box??{x:0.3,y:0.45,w:0.4,h:0.35},t=String(o.seconds??60);
  const vf=`crop=iw*${b.w}:ih*${b.h}:iw*${b.x}:ih*${b.y},scale=160:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`;
  const p=Bun.spawn([ffmpegPath(),'-hide_banner','-nostdin','-v','error','-t',t,'-i',path,'-map','0:v:0','-vf',vf,'-f','null','-'],{stdout:'pipe',stderr:'pipe',signal:o.signal});
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  if(code)throw new Error(`ffmpeg motion ${path}: ${err.slice(-300)}`);
  const motion=[...out.matchAll(/YAVG=([\d.]+)/g)].map(m=>Number(m[1]));
  const pcm=await decodeMono(path,{seconds:Number(t),signal:o.signal});
  const loud=activityLevels(pcm,SYNC_RATE,1/fps).slice(0,motion.length);
  return motion.length>fps*5?avOffsetFrom(motion.slice(0,loud.length),loud,fps):null;
}
