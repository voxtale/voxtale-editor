// Look before choosing. The clip index and the transcript are text about the
// footage; for a clip with no words they are all the agent has unless it looks.
// This measures what the frames show (camera movement, shot size), checks the
// index labels against it, and checks a candidate ranking covers every clip
// and every field the brief names. Code only: frames in, numbers out.
//
// Our values:
// - stills per clip: t=0, quarter, half, three quarters, last frame. The
//   edges matter: a short clip can show its key moment in its first or last
//   tenth of a second, which evenly spaced stills skip.
// - movement from tiny grey frames (64x36, ~40 per clip): the best shift
//   (±6 px) and scale (0.80-1.25, refined to 0.25%) from the first frame to
//   the last. Push-in or pull-out = scale off by more than 3% (asm-1's "very
//   slow push-in" clip measures 4.5% over 5.3 s); pan or tilt (or a sideways
//   dolly) = shift over 4% of the frame, about 2.5 px at 64 wide (asm-1's
//   "slow dolly left" clip shifts 4.7%). On asm-1's twelve clips these read
//   the brief's movement right for all four correct picks. Frames an eighth
//   apart are fitted too; if they go the other way, or the move fits under
//   10% better than none, it is unclear.
// - shot size from the face height (fraction of the frame): close >= 0.3,
//   medium >= 0.12, else wide. Roughly head-and-shoulders vs waist-up vs
//   full body on a 16:9 frame.
// - a label from at most 2 stills over more than 6 s is low confidence: the
//   picture can change inside it without a cut.
import type {ClipIndex,IndexSegment} from '@voxtale/editdoc';

export type Movement='static'|'push-in'|'pull-out'|'pan left'|'pan right'|'tilt up'|'tilt down'|'moving'|'unclear';
export type ShotSize='close'|'medium'|'wide';

export interface Look {
  movement:Movement;
  /** First frame to last: scale (1 = none) and shift in frame widths/heights. */
  scale:number;dx:number;dy:number;
  /** How much better the move fits first to last than no move at all, 0-1. Low = the frames do not say. */
  fit:number;
  /** Mean grey change between neighbour frames, 0-1. */
  change:number;
}

export const SURVEY_STILLS=5;
export const SAMPLE_W=64,SAMPLE_H=36;
const SHIFT=6,PAIRS=8,TIE=0.15,FIT_MIN=0.1;
/** Scale steps tried between two compared frames: 0.80-1.25, 1% apart, then refined to 0.25%. */
const SCALES=Array.from({length:46},(_,k)=>Math.round((0.8+k*0.01)*100)/100);
const PUSH=0.03,PAN=0.04,STILL=0.012;
const CLOSE=0.3,MEDIUM=0.12;
const LONG_LABEL=6;

/** Times for the stills: both edges plus three between. */
export function surveyTimes(duration:number,fps=30):number[] {
  const last=Math.max(0,duration-1/fps);
  return Array.from({length:SURVEY_STILLS},(_,k)=>Math.round(last*k/(SURVEY_STILLS-1)*1000)/1000);
}

/** Grey value at a fractional point, bilinear; undefined outside the frame. */
function at(f:Uint8Array,w:number,h:number,x:number,y:number):number|undefined {
  if(x<0||y<0||x>w-1||y>h-1)return undefined;
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(w-1,x0+1),y1=Math.min(h-1,y0+1),fx=x-x0,fy=y-y0;
  return (f[y0*w+x0]!*(1-fx)+f[y0*w+x1]!*fx)*(1-fy)+(f[y1*w+x0]!*(1-fx)+f[y1*w+x1]!*fx)*fy;
}
/** Mean difference when b is a scaled about the centre by s, then shifted by (dx,dy). Centre crop: edges do not count. */
function misfit(a:Uint8Array,b:Uint8Array,w:number,h:number,s:number,dx:number,dy:number):number {
  const cx=(w-1)/2,cy=(h-1)/2,m=Math.round(w*0.12);
  let sum=0,n=0;
  for(let y=m>>1;y<h-(m>>1);y++)for(let x=m;x<w-m;x++) {
    const v=at(a,w,h,cx+(x-cx-dx)/s,cy+(y-cy-dy)/s);
    if(v===undefined)continue;
    sum+=Math.abs(b[y*w+x]!-v);n++;
  }
  return n>w*h/4?sum/n:Infinity;
}
/** Best (dx, dy, scale) taking frame a to frame b: shift first, then scale with the shift refined round it. */
function step(a:Uint8Array,b:Uint8Array,w:number,h:number,fine=false):{dx:number;dy:number;s:number;err:number} {
  let best={dx:0,dy:0,s:1,err:misfit(a,b,w,h,1,0,0)};
  const better=(c:{dx:number;dy:number;s:number},err:number)=>{if(err<best.err-TIE)best={...c,err};};
  for(let dy=-SHIFT;dy<=SHIFT;dy++)for(let dx=-SHIFT;dx<=SHIFT;dx++)better({dx,dy,s:1},misfit(a,b,w,h,1,dx,dy));
  const {dx:bx,dy:by}=best;
  for(const s of SCALES)for(let dy=by-2;dy<=by+2;dy++)for(let dx=bx-2;dx<=bx+2;dx++)if(s!==1)better({dx,dy,s},misfit(a,b,w,h,s,dx,dy));
  if(fine) {
    const c={...best};
    for(let s=c.s-0.01;s<=c.s+0.01+1e-9;s+=0.0025)for(let dy=c.dy-1;dy<=c.dy+1;dy+=0.5)for(let dx=c.dx-1;dx<=c.dx+1;dx+=0.5)better({dx,dy,s},misfit(a,b,w,h,s,dx,dy));
  }
  return best;
}

/**
 * Camera movement over `frames` grey frames (w x h bytes each, in order).
 * The move is first frame to last, fitted finely, so a slow push-in still
 * shows. Frames an eighth of the stretch apart are fitted too: when they
 * disagree with first-to-last (one says in, the other out), or the move fits
 * little better than none, something in the picture moves on its own (a
 * person walking at the lens grows like a push-in) and the answer is unclear.
 */
export function measureMovement(frames:Uint8Array[],w=SAMPLE_W,h=SAMPLE_H):Look {
  if(frames.length<2)return {movement:'static',scale:1,dx:0,dy:0,fit:0,change:0};
  let change=0;
  for(let k=1;k<frames.length;k++){const a=frames[k-1]!,b=frames[k]!;let d=0;for(let i=0;i<a.length;i++)d+=Math.abs(a[i]!-b[i]!);change+=d/a.length/255;}
  change/=frames.length-1;
  const first=frames[0]!,last=frames.at(-1)!;
  const whole=step(first,last,w,h,true),none=misfit(first,last,w,h,1,0,0);
  const fit=none>0&&Number.isFinite(none)?Math.max(0,1-whole.err/none):0;
  const gap=Math.max(1,Math.floor((frames.length-1)/PAIRS));
  let chain=1,cdx=0,cdy=0;
  for(let k=0;k+gap<frames.length;k+=gap){const st=step(frames[k]!,frames[k+gap]!,w,h);chain*=st.s;cdx+=st.dx;cdy+=st.dy;}
  // A pan wider than one fit can reach: the steps add up past it.
  const wide=Math.abs(cdx)>=SHIFT||Math.abs(cdy)>=SHIFT;
  const scale=wide?chain:whole.s,fx=(wide?cdx:whole.dx)/w,fy=(wide?cdy:whole.dy)/h;
  const torn=!wide&&((chain>1+PUSH&&scale<1-PUSH)||(chain<1-PUSH&&scale>1+PUSH));
  const moved=Math.abs(scale-1)>PUSH||Math.abs(fx)>=PAN||Math.abs(fy)>=PAN;
  const movement:Movement=
    change<STILL&&!moved?'static'
    :torn||(moved&&fit<FIT_MIN)?'unclear'
    :scale>1+PUSH?'push-in'
    :scale<1-PUSH?'pull-out'
    :Math.abs(fx)>=PAN&&Math.abs(fx)>=Math.abs(fy)?(fx<0?'pan right':'pan left')
    :Math.abs(fy)>=PAN?(fy<0?'tilt down':'tilt up')
    :change<STILL?'static':'moving';
  const r=(x:number)=>Math.round(x*1000)/1000;
  return {movement,scale:r(scale),dx:r(fx),dy:r(fy),fit:r(fit),change:r(change)};
}

/** The camera as a yes/no: moves, holds, or the frames do not say. */
export function cameraMoves(l:Look|undefined):boolean|undefined {
  if(!l||l.movement==='unclear'||l.movement==='moving')return undefined;
  return l.movement!=='static';
}

/** Split one `sample` pass (frames back to back) into frames. */
export function splitFrames(bytes:Uint8Array,w=SAMPLE_W,h=SAMPLE_H):Uint8Array[] {
  const n=Math.floor(bytes.length/(w*h));
  return Array.from({length:n},(_,k)=>bytes.subarray(k*w*h,(k+1)*w*h));
}

export function shotSize(faceHeight:number|undefined):ShotSize|undefined {
  if(faceHeight===undefined)return undefined;
  return faceHeight>=CLOSE?'close':faceHeight>=MEDIUM?'medium':'wide';
}

const STILL_WORDS=/\b(stand(s|ing)?|still|static|stationary|locked[- ]off|fixed|motionless|facing (forward|the camera))\b/i;
const MOVE_WORDS=/\b(push(es|ing)?[- ]in|zoom(s|ing)?|dolly|pans?|panning|track(s|ing)|travel(s|ling|ing)?|tilts?|handheld|moving camera|camera moves)\b/i;

/** Words of an agent's or label's text, read as a movement claim. */
export function movementClaim(text:string):'still'|'moving'|undefined {
  if(MOVE_WORDS.test(text))return 'moving';
  if(STILL_WORDS.test(text))return 'still';
  return undefined;
}
const sizeClaim=(text:string):ShotSize|undefined=>
  /\b(close[- ]?up|close|tight|ecu|cu)\b/i.test(text)?'close'
  :/\b(medium|mid[- ]shot|waist|knees?[- ]up|cowboy)\b/i.test(text)?'medium'
  :/\b(wide|full[- ]body|long shot|establishing)\b/i.test(text)?'wide':undefined;

export interface LabelFlag {segment:string;why:string}

/**
 * Index labels the frames disagree with, or that rest on too little.
 * `lookOf` gives the measured movement over a stretch of the clip, when measured.
 */
export function labelFlags(ix:ClipIndex,lookOf?:(start:number,end:number)=>Look|undefined):LabelFlag[] {
  const out:LabelFlag[]=[];
  const flag=(s:IndexSegment,why:string)=>out.push({segment:s.id,why});
  for(const s of ix.segments) {
    if(s.usable===null)flag(s,'never labelled');
    const len=s.end-s.start;
    if(len>LONG_LABEL)flag(s,`labelled from at most 2 stills over ${len.toFixed(1)}s: the picture may change inside it`);
    const size=shotSize(s.face?.h),said=['wide','medium','close'].includes(s.shotType)?s.shotType as ShotSize:sizeClaim(s.description);
    if(size&&said&&size!==said)flag(s,`says ${said}, but the face fills ${Math.round(s.face!.h*100)}% of the height (${size})`);
    const look=lookOf?.(s.start,s.end);
    const claim=movementClaim(`${s.description} ${s.action}`);
    const moves=cameraMoves(look);
    if(claim==='still'&&moves===true)flag(s,`reads as a still shot, but the frames show ${look!.movement}`);
    if(claim==='moving'&&moves===false)flag(s,'reads as camera movement, but the frames are still');
  }
  return out;
}

export interface Score {clip:string;field:string;score:number;seen:string}
export interface Ranked {clip:string;total:number}

/**
 * Check a candidate ranking: every candidate viewed, every field scored for
 * every candidate, and what the agent says it saw against what was measured.
 */
export function rankCandidates(o:{fields:string[];scores:Score[];candidates:string[];viewed:Set<string>;measured:(clip:string)=>{look?:Look;size?:ShotSize}|undefined}):{ranked:Ranked[];missing:string[];unviewed:string[];unscored:string[];flags:string[];close:string[]} {
  const clips=[...new Set(o.scores.map(s=>s.clip))];
  const missing:string[]=[];
  for(const c of clips)for(const f of o.fields)if(!o.scores.some(s=>s.clip===c&&s.field===f))missing.push(`${c}: ${f}`);
  const unviewed=clips.filter(c=>!o.viewed.has(c));
  const unscored=o.candidates.filter(c=>!clips.includes(c));
  const flags:string[]=[];
  for(const s of o.scores) {
    const m=o.measured(s.clip);
    if(!m)continue;
    const field=s.field.toLowerCase();
    if(/shot|size|framing/.test(field)&&m.size) {
      const said=sizeClaim(s.seen);
      if(said&&said!==m.size)flag(`${s.clip} ${s.field}: you saw ${said}; the face measures ${m.size}`);
    }
    if(/camera|movement|motion|move/.test(field)&&m.look) {
      const said=movementClaim(s.seen),mv=m.look.movement,moves=cameraMoves(m.look);
      if(said==='still'&&moves===true)flag(`${s.clip} ${s.field}: you saw it still; the frames measure ${mv}`);
      if(said==='moving'&&moves===false)flag(`${s.clip} ${s.field}: you saw movement; the frames measure static`);
      const push=/push(es|ing)?[- ]?in|zoom(s|ing)? in|dolly (in|forward)/i.test(s.seen),pull=/pull(s|ing)?[- ]?(out|back)|zoom(s|ing)? out|dolly (out|back)/i.test(s.seen);
      const side=/\b(pan|dolly|track|truck)(s|ing)? (left|right)\b/i.exec(s.seen)?.[3]?.toLowerCase();
      if(side&&moves!==undefined&&mv!==`pan ${side}`)flag(`${s.clip} ${s.field}: you saw it move ${side}; the frames measure ${mv}`);
      if(push&&moves!==undefined&&mv!=='push-in')flag(`${s.clip} ${s.field}: you saw a push-in; the frames measure ${mv}`);
      if(pull&&moves!==undefined&&mv!=='pull-out')flag(`${s.clip} ${s.field}: you saw a pull-out; the frames measure ${mv}`);
    }
  }
  function flag(x:string){flags.push(x);}
  const ranked=clips.map(clip=>({clip,total:o.scores.filter(s=>s.clip===clip&&o.fields.includes(s.field)).reduce((a,s)=>a+s.score,0)}))
    .sort((a,b)=>b.total-a.total);
  const close=ranked.length>1&&ranked[0]!.total-ranked[1]!.total<=1?[`${ranked[0]!.clip} vs ${ranked[1]!.clip}: ${ranked[0]!.total} vs ${ranked[1]!.total}`]:[];
  return {ranked,missing,unviewed,unscored,flags,close};
}
