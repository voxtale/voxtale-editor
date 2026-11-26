// Motion numbers shared by both graphics paths: the GSAP kit (../../../motion.ts
// turns them into window.kit) and the native Remotion scenes (./kit.tsx). Pure,
// no imports, so the sandbox bundles it and tests run it without Remotion.

/** Cubic-bezier curves (x1, y1, x2, y2), as in CSS. Typical durations in the skill. */
export const CURVES={
  glide:[0.333,0,0,1], // soft start, long finish: entrances, a rising title, cooling down
  flowIn:[0.001,0.66,0.16,0.98], // arrives at full speed (a smear on frame 1), then settles for a long time
  flowInBig:[0.001,0.87,0.16,0.974], // same, harder: an end card arriving from the back
  flowOut:[1,0,0.999,0.01], // holds still, then leaves at once (74% of the travel on the last frame)
  swing:[0.86,0.01,0.15,0.99], // lingers, rushes, lingers: pans, pushes, big slides
  land:[0.001,1,0,1], // arrives fast and stops sharply but softly
  flyBy:[0.001,0.506,0.999,0], // crosses the frame: fast, slow, fast
  press:[0.333,0,0.667,1], // click: 4 frames in + 4 back
  scroll:[0.6,0,0.3,1],
  fadeSlow:[0.167,0,0.833,1],
  endPush:[1,0,0.075,1], // slow push on the end card
  cursor:[0.36,0,0.03,0.97], // a cursor gliding to its target
  shake:[0.74,0,0.18,1], // impact shake
  moderate:[0.2,0.6,0.35,1],
} as const satisfies Record<string,readonly [number,number,number,number]>;
export type CurveName=keyof typeof CURVES;

/**
 * SNAP: from `from` to `to` in `frames` frames in a straight line, then the
 * bounce (overshoots ~14%, settles in ~1 s), at `frame` frames since the snap
 * began. Only for small interface pieces that appear in place (tick, dot,
 * badge, button, list marker, bar): never text, a card, a banner or a window.
 * `amp` by size: 0.035 small piece, 0.02 a bit bigger (button).
 */
export function snap(frame:number,fps:number,from:number,to:number,{frames=4,amp=0.035}={}):number {
  if(frame<=0)return from;
  if(frame<frames)return from+((to-from)*frame)/frames;
  // Bounce computed at 25 fps: the same overshoot at 24, 25 or 30 fps.
  const t=(frame-frames)/fps,speed=(to-from)/(frames/25);
  const fade=(1-Math.min(1,t/3))**2; // the bounce dies within 3 s
  return to+(speed*amp*Math.sin(1.8*t*2*Math.PI))/Math.exp(3*t)*fade;
}

/** Gaussian blur (std dev, px) that looks like a smear `length` px long: that of a box blur of the same length. */
export const smearStd=(length:number)=>Math.abs(length)/Math.sqrt(12);

/** Delay (frames) of item `i` of `n` in a staggered entrance: `each` frames per rank, counted from the start, end, centre, edges or a given rank. */
export function stagger(i:number,n:number,{each,from='start'}:{each:number;from?:'start'|'end'|'center'|'edges'|number}):number {
  const mid=(n-1)/2;
  const rank=from==='start'?i:from==='end'?n-1-i:from==='center'?Math.abs(i-mid)
    :from==='edges'?mid-Math.abs(i-mid):Math.abs(i-from);
  return rank*each;
}

/** A counter that settles: smaller and smaller steps towards the end, rounded to `decimals`, exactly `to` at frame `frames`. */
export function countSteps(frame:number,frames:number,from:number,to:number,decimals=0):number {
  const t=Math.min(1,Math.max(0,frame/Math.max(1,frames)));
  const k=10**decimals;
  return Math.round((from+(to-from)*(1-(1-t)**3))*k)/k;
}

/** Slow drift during a hold, `px` over the whole duration (`life` 0 -> 1). Default 0: text at rest stays still. */
export const driftOffset=(life:number,px:number)=>life*px;

/** Font size (px) so one line measured `w100` px at 100 px, with `letterSpacing` em over `chars` letters, fits `width`. */
export const fitFont=(w100:number,chars:number,width:number,{min=1,max=Infinity,letterSpacing=0}={})=>
  Math.max(min,Math.min(max,width/Math.max(1e-6,w100/100+letterSpacing*chars)));

/** Frames of the pro entrance (0.9 s) and exit (0.8 s) at this tempo; a short animation shares them out. */
export function proTimes(durationFrames:number,fps:number,speed=1) {
  const enter=Math.max(1,Math.min(Math.round((0.9*fps)/speed),Math.floor(durationFrames*0.45)));
  const leave=Math.max(1,Math.min(Math.round((0.8*fps)/speed),Math.floor(durationFrames*0.35)));
  return {enter,leave};
}

/**
 * Level of a transition (flash, burn) at `frame`: 0 -> 1 -> 0, and 1 (fully
 * opaque) on the middle frame, or the two middle frames for an even length.
 * Set its middle on the cut and those frames hide the join.
 */
export function transitionLevel(frame:number,durationFrames:number,curve=2.2):number {
  const half=Math.max(0.5,(durationFrames-1)/2);
  const away=Math.max(0,Math.abs(frame-(durationFrames-1)/2)-0.5)/half;
  return Math.pow(1-Math.min(1,away),curve);
}

/** "The *best* tool": words between asterisks take the accent colour. */
export const accentParts=(text:string)=>text.split(/(\*[^*]+\*)/).filter(Boolean).map(part=>({text:part.replace(/^\*|\*$/g,''),accent:/^\*[^*]+\*$/.test(part)}));

/** Float offset: one full round trip over the whole duration, so it follows stretching. */
export const floatOffset=(life:number,amplitude:number)=>Math.sin(life*Math.PI*2)*amplitude;

export type Seg={text:string;accent:boolean};
/** Lines of a hook: "\n" breaks there, else a word that would pass `max` (measured width) wraps. Accent runs stay glued to their punctuation. */
export function hookLines(parts:Seg[],width:(text:string)=>number,max:number) {
  const words:{segs:Seg[];br:boolean}[]=[];
  let gap=true,br=false;
  for(const part of parts)for(const chunk of part.text.split(/( |\n)/)) {
    if(chunk===' '||chunk==='\n'){gap=true;br||=chunk==='\n';continue;}
    if(!chunk)continue;
    if(gap){words.push({segs:[],br});gap=br=false;}
    words[words.length-1]!.segs.push({text:chunk,accent:part.accent});
  }
  const lines:{segs:Seg[];text:string}[]=[];
  for(const w of words) {
    const t=w.segs.map(s=>s.text).join(''),last=lines[lines.length-1];
    if(last&&!w.br&&width(`${last.text} ${t}`)<=max){last.segs.push({text:' ',accent:false},...w.segs);last.text+=` ${t}`;}
    else lines.push({segs:[...w.segs],text:t});
  }
  return lines;
}

/**
 * Outline of a stack of centred lines (half-widths `half`, each `lh` tall) as
 * one box, TikTok style: rounded outer corners `r` and, where two lines of
 * different widths meet, a concave round joining them. SVG path, clockwise.
 */
export function stackPath(half:number[],lh:number,r:number) {
  const cx=Math.max(...half);
  const h=half.reduce<number[]>((a,v)=>[...a,a.length&&Math.abs(v-a[a.length-1]!)<0.5?a[a.length-1]!:v],[]);
  const pts:[number,number][]=[];
  h.forEach((v,i)=>pts.push([cx+v,i*lh],[cx+v,(i+1)*lh]));
  for(let i=h.length-1;i>=0;i--)pts.push([cx-h[i]!,(i+1)*lh],[cx-h[i]!,i*lh]);
  const at=(a:[number,number][],i:number)=>a[(i+a.length)%a.length]!;
  const once=pts.filter((p,i)=>Math.hypot(p[0]-at(pts,i-1)[0],p[1]-at(pts,i-1)[1])>0.01);
  const v=once.filter((p,i)=>{const a=at(once,i-1),b=at(once,i+1);return Math.abs((p[0]-a[0])*(b[1]-p[1])-(p[1]-a[1])*(b[0]-p[0]))>0.01;});
  const n=(x:number)=>+x.toFixed(2);
  return v.map((p,i)=>{
    const a=at(v,i-1),b=at(v,i+1);
    const lin=Math.hypot(p[0]-a[0],p[1]-a[1]),lout=Math.hypot(b[0]-p[0],b[1]-p[1]);
    const k=Math.max(0,Math.min(r,lin/2,lout/2));
    const din=[(p[0]-a[0])/lin,(p[1]-a[1])/lin] as const,dout=[(b[0]-p[0])/lout,(b[1]-p[1])/lout] as const;
    const sweep=din[0]*dout[1]-din[1]*dout[0]>0?1:0; // turning right = outer corner; left = concave round
    return `${i?'L':'M'}${n(p[0]-din[0]*k)} ${n(p[1]-din[1]*k)} A${n(k)} ${n(k)} 0 0 ${sweep} ${n(p[0]+dout[0]*k)} ${n(p[1]+dout[1]*k)}`;
  }).join(' ')+' Z';
}
