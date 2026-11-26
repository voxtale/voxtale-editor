// The motion kit for agent graphics: a pro motion designer's curves, the snap
// bounce, directional motion blur, stagger and settling counters. The numbers
// and their rules come from REDACTED (measured on After Effects projects; skill
// pro-motion). Here they serve GSAP compositions under either renderer:
// MOTION_KIT_JS goes into every composition as window.kit, right after GSAP.

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

/** Frames per second the kit counts in (both renderers render at 30). */
export const KIT_FPS=30;

/**
 * window.kit inside a composition. Plain JS, no network. Every helper adds
 * tweens to the paused timeline, so seeking any frame gives the same picture.
 */
export const MOTION_KIT_JS=`(function(){
var FPS=${KIT_FPS},C=${JSON.stringify(CURVES)};
function bez(x1,y1,x2,y2){var cx=3*x1,bx=3*(x2-x1)-cx,ax=1-cx-bx,cy=3*y1,by=3*(y2-y1)-cy,ay=1-cy-by;
 function X(t){return((ax*t+bx)*t+cx)*t}function Y(t){return((ay*t+by)*t+cy)*t}function D(t){return(3*ax*t+2*bx)*t+cx}
 return function(p){if(p<=0)return 0;if(p>=1)return 1;var t=p,i,e,d;
  for(i=0;i<8;i++){e=X(t)-p;if(Math.abs(e)<1e-6)return Y(t);d=D(t);if(Math.abs(d)<1e-6)break;t-=e/d;}
  var lo=0,hi=1;t=p;for(i=0;i<40;i++){e=X(t);if(Math.abs(e-p)<1e-6)break;if(e<p)lo=t;else hi=t;t=(lo+hi)/2;}return Y(t);};}
var curves={};for(var k in C)curves[k]=bez.apply(null,C[k]);
var snap=(${snap.toString()});
function el(t){return typeof t==='string'?document.querySelector(t):t}
var n=0;
/* Ease for a snap tween lasting \`seconds\` (1.2 or more lets the bounce settle). */
function snapEase(seconds,o){return function(p){return p>=1?1:snap(p*seconds*FPS,FPS,0,1,o)}}
/* Move with directional motion blur (180 deg shutter, phase 0, as After Effects): o={at,dur,curve,x:[a,b],y:[a,b],blur}. */
function travel(tl,target,o){var e=el(target),ease=curves[o.curve||'flowIn'],x=o.x||[0,0],y=o.y||[0,0],dur=o.dur;
 tl.fromTo(e,{x:x[0],y:y[0]},{x:x[1],y:y[1],duration:dur,ease:ease},o.at);
 if(o.blur===false)return tl;
 var id='kmb'+(n++),ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
 svg.setAttribute('width','0');svg.setAttribute('height','0');svg.style.position='absolute';
 svg.innerHTML='<filter id="'+id+'" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="0 0"/></filter>';
 document.body.appendChild(svg);var g=svg.querySelector('feGaussianBlur'),f=Math.max(1,Math.ceil(dur*FPS)),on=false;
 for(var i=0;i<=f;i++){var p=i/f,q=Math.min(1,(i+0.5)/f),dx=(ease(q)-ease(p))*(x[1]-x[0]),dy=(ease(q)-ease(p))*(y[1]-y[0]),
  sx=Math.abs(dx)/Math.sqrt(12),sy=Math.abs(dy)/Math.sqrt(12),now=sx>0.3||sy>0.3,t=o.at+i/FPS;
  if(now)tl.set(g,{attr:{stdDeviation:sx.toFixed(2)+' '+sy.toFixed(2)}},t);
  if(now!==on){tl.set(e,{filter:now?'url(#'+id+')':'none'},t);on=now;}}
 if(on)tl.set(e,{filter:'none'},o.at+dur);
 return tl;}
/* Arrive tinted in the accent and bright, then cool to the element's own colour over ~1.4 s (glide). */
function cool(tl,target,at,o){var e=el(target),own=getComputedStyle(e).color,acc=(o&&o.color)||getComputedStyle(document.getElementById('root')||document.body).getPropertyValue('--accent').trim()||'#5eb0ff';
 tl.fromTo(e,{color:acc,textShadow:'0 0 18px '+acc},{color:own,textShadow:'0 0 0px rgba(0,0,0,0)',duration:34/24,ease:curves.glide},at);return tl;}
/* Impact shake on the scene container when something lands: (-8,+28) px in 2.4 frames, back in 1.6; a 0.4 deg rock. Scale px with the canvas. */
function shake(tl,target,at,o){var e=el(target),s=(o&&o.scale)||1,a=2.4/24,b=1.6/24;
 tl.to(e,{x:-8*s,y:28*s,duration:a,ease:curves.shake},at).to(e,{x:0,y:0,duration:b,ease:curves.shake},at+a)
  .to(e,{rotation:0.4,duration:b,ease:curves.shake},at).to(e,{rotation:0,duration:4.8/24,ease:curves.shake},at+b);return tl;}
var stagger=(${stagger.toString()});
var countSteps=(${countSteps.toString()});
window.kit={fps:FPS,curves:curves,snap:snap,snapEase:snapEase,travel:travel,cool:cool,shake:shake,stagger:stagger,countSteps:countSteps};
})();`;

const GSAP_TAG=/<script[^>]*src=["']\.\/gsap\.min\.js["'][^>]*>\s*<\/script>/i;

/** The composition with window.kit loaded right after GSAP (left alone when GSAP is missing or the kit is already in). */
export function withMotionKit(html:string):string {
  if(html.includes('window.kit={fps:'))return html;
  return html.replace(GSAP_TAG,m=>`${m}\n<script>${MOTION_KIT_JS}</script>`);
}
