// The 9:16 layout of a live clip, decided on its own frames: a streamer's
// webcam can change corner, fill the screen or disappear. Frames every 2 s
// go through our face finder: a small face means a webcam box (sized from
// the face, then snapped to the overlay's own edges, which stay still while
// the game moves), a big face means a full-screen webcam, none means game
// only. Runs of the same layout become segments; planVertical turns them
// into stack spans (webcam over game) and a reframe path (reframe.ts) for
// the rest. The agent sees the plan and a contact sheet and can fix it.
import {mkdir,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Reframe,ReframeSpeed,Stack} from '@voxtale/editdoc';
import {ffmpegPath} from '../ffmpeg-path';
import type {FaceBox,FaceFinder} from '../footage-index';
import {run} from '../media';
import {joinReframes,reframePath,type SubjectFinder} from '../reframe';
import type {StackSpan} from './stack';

/** Fractions of the live's frame, top-left corner. */
export interface Box {x:number;y:number;w:number;h:number}
/** One moment of the clip from `from` (seconds of the clip file). */
export type LayoutPart={from:number;layout:'stack';facecam:Box}|{from:number;layout:'full'|'game';x:number};
/** Gray picture, row-major, 0-255. */
export interface Gray {width:number;height:number;data:Uint8Array}
export interface Sample {t:number;face:FaceBox|null;gray?:Gray}

/** A face taller than this share of the frame is a full-screen webcam. */
export const FULL_FACE=0.2;
/** A webcam box is about this many face sizes across. */
export const CAM_PER_FACE=3.2;
/** Seconds between samples; a layout shorter than MIN_PART joins its neighbour. */
export const EVERY=2,MIN_PART=4;
/** Contact sheet: one frame per SHEET_EVERY s, 4×6 tiles. */
export const SHEET_EVERY=4;

const clamp=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));

/** The webcam box guessed from a face (centre coords, as the face finder gives), kept inside the frame and pulled to a near edge. */
export function camFromFace(f:FaceBox):Box {
  let w=clamp(f.w*CAM_PER_FACE,0.08,0.6),h=clamp(f.h*CAM_PER_FACE,0.08,0.6);
  let x=clamp(f.x-w/2,0,1-w),y=clamp(f.y-h/2*0.9,0,1-h);
  // Webcams sit against the frame's edges: a gap under 4% closes.
  if(x<0.04){w+=x;x=0;} if(1-(x+w)<0.04)w=1-x;
  if(y<0.04){h+=y;y=0;} if(1-(y+h)<0.04)h=1-y;
  return {x,y,w,h};
}

/** Mean edge strength over frames: |dx| and |dy| per pixel. A still overlay's border stays strong; moving game averages out. */
export function staticEdges(frames:Gray[]):{width:number;height:number;gx:Float32Array;gy:Float32Array}|null {
  const f0=frames[0];
  if(!f0)return null;
  const {width:W,height:H}=f0,gx=new Float32Array(W*H),gy=new Float32Array(W*H);
  for(const f of frames) {
    if(f.width!==W||f.height!==H)continue;
    for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++) {
      const i=y*W+x;
      gx[i]+=Math.abs(f.data[i+1]!-f.data[i-1]!);
      gy[i]+=Math.abs(f.data[i+W]!-f.data[i-W]!);
    }
  }
  const n=frames.length;
  for(let i=0;i<gx.length;i++){gx[i]/=n;gy[i]/=n;}
  return {width:W,height:H,gx,gy};
}

/**
 * The box moved onto the overlay's own border where one is clear: each
 * side that does not touch the frame edge looks within ±40% of the box size
 * for the line with the strongest still edge along it. A weak line (under
 * 2× the area's median) leaves the side where it was.
 */
export function refineBox(b:Box,e:NonNullable<ReturnType<typeof staticEdges>>):Box {
  const {width:W,height:H,gx,gy}=e;
  const col=(x:number,y0:number,y1:number)=>{let s=0;for(let y=y0;y<y1;y++)s+=gx[y*W+x]!;return s/Math.max(1,y1-y0);};
  const row=(y:number,x0:number,x1:number)=>{let s=0;for(let x=x0;x<x1;x++)s+=gy[y*W+x]!;return s/Math.max(1,x1-x0);};
  const best=(lo:number,hi:number,f:(i:number)=>number,max:number)=>{
    const vals:number[]=[];let bi=-1,bv=-1;
    for(let i=Math.max(1,lo);i<=Math.min(max-2,hi);i++){const v=f(i);vals.push(v);if(v>bv){bv=v;bi=i;}}
    const med=[...vals].sort((a,c)=>a-c)[Math.floor(vals.length/2)]??0;
    return bv>Math.max(4,2*med)?bi:-1;
  };
  let [x0,x1,y0,y1]=[b.x*W,(b.x+b.w)*W,b.y*H,(b.y+b.h)*H];
  const sw=b.w*W*0.4,sh=b.h*H*0.4,ya=Math.round(y0+(y1-y0)*0.2),yb=Math.round(y1-(y1-y0)*0.2),xa=Math.round(x0+(x1-x0)*0.2),xb=Math.round(x1-(x1-x0)*0.2);
  if(b.x>0.005){const i=best(Math.round(x0-sw),Math.round(x0+sw),x=>col(x,ya,yb),W);if(i>=0)x0=i;}
  if(b.x+b.w<0.995){const i=best(Math.round(x1-sw),Math.round(x1+sw),x=>col(x,ya,yb),W);if(i>=0)x1=i;}
  if(b.y>0.005){const i=best(Math.round(y0-sh),Math.round(y0+sh),y=>row(y,xa,xb),H);if(i>=0)y0=i;}
  if(b.y+b.h<0.995){const i=best(Math.round(y1-sh),Math.round(y1+sh),y=>row(y,xa,xb),H);if(i>=0)y1=i;}
  const r=(v:number)=>Math.round(v*1e4)/1e4;
  const out={x:r(x0/W),y:r(y0/H),w:r((x1-x0)/W),h:r((y1-y0)/H)};
  return out.w>=0.05&&out.h>=0.05?out:b;
}

const iou=(a:Box,b:Box)=>{
  const ix=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),iy=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  const i=ix*iy;return i/(a.w*a.h+b.w*b.h-i||1);
};
const med=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]??0.5;};

/**
 * Samples → layout parts. Each sample is classed (stack / full / game), a
 * lone odd sample takes its neighbours' class, runs of the same class (and
 * for stacks the same corner) join, short runs fold into the one before.
 * Each stack part's box is the median face box, then refined on the part's
 * still edges.
 */
export function detectLayout(samples:Sample[],o:{fullFace?:number}={}):LayoutPart[] {
  if(!samples.length)return [{from:0,layout:'game',x:0.5}];
  const full=o.fullFace??FULL_FACE;
  type K={kind:'stack'|'full'|'game';cam?:Box};
  const ks:K[]=samples.map(s=>!s.face?{kind:'game'}:s.face.h>=full?{kind:'full'}:{kind:'stack',cam:camFromFace(s.face)});
  // A one-sample flicker (a face missed in one frame) takes its neighbours' class.
  for(let i=1;i+1<ks.length;i++)if(ks[i-1]!.kind===ks[i+1]!.kind&&ks[i]!.kind!==ks[i-1]!.kind)ks[i]={...ks[i-1]!};
  type Run={a:number;b:number;kind:K['kind']};
  const runs:Run[]=[];
  ks.forEach((k,i)=>{
    const last=runs.at(-1),prev=ks[i-1];
    const same=last&&last.kind===k.kind&&(k.kind!=='stack'||!prev?.cam||!k.cam||iou(prev.cam,k.cam)>0.3);
    if(same)last.b=i;else runs.push({a:i,b:i,kind:k.kind});
  });
  // Short runs fold into the run before (or after, for the first).
  const len=(r:Run)=>(samples[r.b+1]?.t??samples[r.b]!.t+EVERY)-samples[r.a]!.t;
  for(let i=0;i<runs.length;) {
    if(runs.length>1&&len(runs[i]!)<MIN_PART) {
      const into=i>0?runs[i-1]!:runs[i+1]!;
      into.a=Math.min(into.a,runs[i]!.a);into.b=Math.max(into.b,runs[i]!.b);
      runs.splice(i,1);
      // Merged neighbours of the same kind join too.
      for(let j=1;j<runs.length;j++)if(runs[j]!.kind===runs[j-1]!.kind){runs[j-1]!.b=runs[j]!.b;runs.splice(j,1);j--;}
      i=Math.max(0,i-1);
    } else i++;
  }
  return runs.map((r,k):LayoutPart=>{
    const from=k===0?0:samples[r.a]!.t;
    const ss=samples.slice(r.a,r.b+1),faces=ss.map(s=>s.face).filter((f):f is FaceBox=>!!f);
    if(r.kind==='game')return {from,layout:'game',x:0.5};
    if(r.kind==='full')return {from,layout:'full',x:Math.round(med(faces.map(f=>f.x))*1e4)/1e4};
    const cams=ss.map((_,i)=>ks[r.a+i]!.cam).filter((c):c is Box=>!!c);
    let box:Box={x:med(cams.map(c=>c.x)),y:med(cams.map(c=>c.y)),w:med(cams.map(c=>c.w)),h:med(cams.map(c=>c.h))};
    const edges=staticEdges(ss.flatMap(s=>s.gray?[s.gray]:[]));
    if(edges&&ss.length>=3)box=refineBox(box,edges);
    return {from,layout:'stack',facecam:box};
  });
}

/** The agent's layout list, checked: in order, boxes inside the frame; what is wrong drops out; nothing left = game at the centre. */
export function readLayout(list:unknown):LayoutPart[] {
  const frac=(v:unknown):v is number=>typeof v==='number'&&v>=0&&v<=1;
  const ok=(Array.isArray(list)?list:[]).flatMap((s:any):LayoutPart[]=>{
    const from=Number(s?.from??0),f=s?.facecam;
    if(!(from>=0))return [];
    if((s.layout==='stack'||s.layout==='split')&&f&&frac(f.x)&&frac(f.y)&&frac(f.w)&&frac(f.h)&&f.w>0.03&&f.h>0.03&&f.x+f.w<=1.001&&f.y+f.h<=1.001)
      return [{from,layout:'stack',facecam:{x:f.x,y:f.y,w:f.w,h:f.h}}];
    if(s.layout==='full'||s.layout==='game')return [{from,layout:s.layout,x:frac(s.x)?s.x:0.5}];
    return [];
  }).sort((a,b)=>a.from-b.from);
  return ok.length?[{...ok[0]!,from:0},...ok.slice(1).filter((s,i)=>s.from>ok[i]!.from)]:[{from:0,layout:'game',x:0.5}];
}

/**
 * The stack for a webcam box on a 1080×1920 canvas: the webcam band's height
 * follows the box's shape (480-960 px), the game below cropped beside the
 * webcam, not over it.
 */
export function stackFor(f:Box,src:{width:number;height:number},canvas={width:1080,height:1920}):Stack {
  const W=canvas.width,H=canvas.height;
  const band=Math.round(Math.min(H/2,Math.max(H/4,W*(f.h*src.height)/(f.w*src.width))));
  // Half the game's visible width (fraction of the source) when it fills the lower band at full height.
  const seen=Math.min(0.5,(W/(H-band))*src.height/src.width/2);
  const gx=f.x+f.w/2<0.5?Math.max(0.5,f.x+f.w+seen):Math.min(0.5,f.x-seen);
  const cx=clamp(gx,seen,1-seen),r=(v:number)=>Math.round(v*1e4)/1e4;
  return {top:{x:r(f.x),y:r(f.y),w:r(f.w),h:r(f.h)},bottom:{x:r(cx-seen),y:0,w:r(2*seen),h:1},split:r(band/H)};
}

export interface VerticalPlan {stacks:StackSpan[];reframe:Reframe|null;parts:(LayoutPart&{to:number})[]}

/**
 * Layout parts of a clip (`duration` s, source `src`) → stack spans for the
 * cut and one reframe path for the full and game parts: a full part follows
 * the face (reframePath), a game part holds on its x.
 */
export async function planVertical(parts:LayoutPart[],src:{path:string;width:number;height:number},duration:number,
  o:{speed?:ReframeSpeed;subject?:SubjectFinder;follow?:boolean}={}):Promise<VerticalPlan> {
  const spans=parts.map((p,i)=>({...p,to:i+1<parts.length?parts[i+1]!.from:duration})).filter(p=>p.to-p.from>0.01);
  const stacks:StackSpan[]=[],paths:(Reframe|null)[]=[];
  const speed=o.speed??'default',hold=(x:number,a:number,b:number):Reframe=>({speed,keys:[{t:a+0.001,x},{t:Math.max(a+0.002,b-0.001),x}]});
  for(const p of spans) {
    if(p.layout==='stack')stacks.push({from:p.from,to:p.to,stack:stackFor(p.facecam,src)});
    else if(p.layout==='full'&&o.follow!==false) {
      const r=await reframePath(src,{from:p.from,to:p.to},'9:16',{speed,...(o.subject?{subject:o.subject}:{})}).catch(()=>null);
      paths.push(r?.reframe??hold(p.x,p.from,p.to));
    }
    else paths.push(hold(p.x,p.from,p.to));
  }
  return {stacks,reframe:joinReframes(paths),parts:spans};
}

/** One line per part, for the agent. */
export function layoutText(parts:(LayoutPart&{to?:number})[]):string {
  const f=(v:number)=>v.toFixed(2);
  return parts.map(p=>`${f(p.from)}s${p.to!==undefined?`-${f(p.to)}s`:''} ${p.layout}${p.layout==='stack'?` facecam x${f(p.facecam.x)} y${f(p.facecam.y)} w${f(p.facecam.w)} h${f(p.facecam.h)}`:` x${f(p.x)}`}`).join('\n');
}

// ---- frames (local ffmpeg) -------------------------------------------------

/** JPEG frames every EVERY s at 480 px wide, and the same frames gray at 160×90 for edges. */
export async function sampleClip(path:string,dir:string,faces:FaceFinder):Promise<Sample[]> {
  await mkdir(dir,{recursive:true});
  await run(ffmpegPath(),['-v','error','-nostdin','-y','-i',path,'-an','-vf',`fps=1/${EVERY},scale=480:-2`,'-q:v','5',join(dir,'s-%05d.jpg')]);
  const files=(await readdir(dir)).filter(f=>/^s-\d+\.jpg$/.test(f)).sort();
  const jpegs=await Promise.all(files.map(f=>readFile(join(dir,f)).then(b=>new Uint8Array(b))));
  const found=await faces(jpegs);
  const W=160,H=90,p=Bun.spawn([ffmpegPath(),'-v','error','-nostdin','-i',path,'-an','-vf',`fps=1/${EVERY},scale=${W}:${H},format=gray`,'-f','rawvideo','-'],{stdout:'pipe',stderr:'ignore'});
  const raw=new Uint8Array(await new Response(p.stdout).arrayBuffer());await p.exited;
  return files.map((_,i)=>({t:i*EVERY,face:found[i]??null,...(raw.length>=(i+1)*W*H?{gray:{width:W,height:H,data:raw.subarray(i*W*H,(i+1)*W*H)}}:{})}));
}

/** Contact sheets of a clip: one frame per SHEET_EVERY s, 4 per row, 6 rows (24 per sheet; name-1.jpg, name-2.jpg…). */
export async function contactSheets(clip:string,dir:string,name:string):Promise<string[]> {
  await mkdir(dir,{recursive:true});
  await run(ffmpegPath(),['-v','error','-nostdin','-y','-i',clip,'-an','-vf',`fps=1/${SHEET_EVERY},scale=480:-2,tile=4x6:padding=4:color=black`,'-q:v','4',join(dir,`${name}-%d.jpg`)]);
  return (await readdir(dir)).filter(f=>f.startsWith(`${name}-`)&&f.endsWith('.jpg'))
    .sort((a,b)=>Number(a.match(/-(\d+)\.jpg$/)![1])-Number(b.match(/-(\d+)\.jpg$/)![1])).map(f=>join(dir,f));
}
