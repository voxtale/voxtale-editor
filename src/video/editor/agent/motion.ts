// The motion kit for agent graphics: a pro motion designer's curves, the snap
// bounce, directional motion blur, stagger and settling counters. The numbers
// and their rules come from REDACTED (measured on After Effects projects; skill
// pro-motion). Here they serve GSAP compositions under either renderer:
// MOTION_KIT_JS goes into every composition as window.kit, right after GSAP.

export {CURVES,countSteps,smearStd,snap,stagger,type CurveName} from './sandbox/remotion/scenes/motion';
import {CURVES,countSteps,snap,stagger} from './sandbox/remotion/scenes/motion';

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
