// Text over the speaker's face, measured. Where the face sits in the output
// frame at a moment (the index face box through the cover fit and the zoom),
// and how much of it a drawn overlay covers. Idea from REDACTED's cards rule
// (nothing over a face); the check is ours. Code only, no model.
import {shown,zoomAt,type EditDoc} from '@voxtale/editdoc';
import type {Face} from './kit';

/** A box in the output frame, top-left corner and size, fractions of the frame. */
export interface Box {x:number;y:number;w:number;h:number}

/** Share of the face an overlay must cover to be flagged (below is anti-aliasing or a shadow edge). */
export const FACE_COVER=0.05;

/**
 * The speaker's face box in the output frame at output second `t`, or null
 * when no speaker shows full frame (a gap, footage or a graphic on screen,
 * or no face known). `faceOf` gives the face at a source second of a clip.
 */
export function faceOnScreen(doc:EditDoc,t:number,faceOf:(clip:string,at:number)=>Face|undefined):Box|null {
  const on=<T extends {start:number;end:number;status:string}>(xs:T[])=>shown(xs).filter(i=>i.start<=t+1e-6&&t<i.end-1e-6);
  const a=on(doc.tracks['a-roll'])[0];
  if(!a||on(doc.tracks['b-roll']).length||on(doc.tracks.graphics).length)return null;
  const clip=doc.clips.find(c=>c.id===a.clipId);
  if(!clip||clip.kind!=='video'||!clip.width||!clip.height)return null;
  const f=faceOf(a.clipId,a.in+(t-a.start));
  if(!f)return null;
  let x0=f.x-f.w/2,x1=f.x+f.w/2,y0=f.y-f.h/2,y1=f.y+f.h/2;
  // Cover fit: the source fills the canvas, its overflow cropped evenly.
  const sa=clip.width/clip.height,ca=doc.canvas.width/doc.canvas.height;
  if(sa>ca){const k=ca/sa,off=(1-k)/2;x0=(x0-off)/k;x1=(x1-off)/k;}
  else if(sa<ca){const k=sa/ca,off=(1-k)/2;y0=(y0-off)/k;y1=(y1-off)/k;}
  // The zoom scales about the centre and shifts by dx/dy (fractions of the frame).
  const z=zoomAt(doc.tracks.zoom,t);
  const mx=(v:number)=>(1-z.scale)/2+z.dx+z.scale*v,my=(v:number)=>(1-z.scale)/2+z.dy+z.scale*v;
  const bx0=Math.max(0,mx(x0)),bx1=Math.min(1,mx(x1)),by0=Math.max(0,my(y0)),by1=Math.min(1,my(y1));
  return bx1>bx0&&by1>by0?{x:bx0,y:by0,w:bx1-bx0,h:by1-by0}:null;
}

/** Share of `face` that `box` covers, 0-1. */
export function covered(box:Box,face:Box):number {
  const w=Math.min(box.x+box.w,face.x+face.w)-Math.max(box.x,face.x);
  const h=Math.min(box.y+box.h,face.y+face.h)-Math.max(box.y,face.y);
  return w>0&&h>0?(w*h)/(face.w*face.h):0;
}

/** Warnings for overlays drawn over the face. `rows` carry the drawn box of each overlay at its moment. */
export function faceWarnings(doc:EditDoc,rows:{t:number;label:string;m:{box:Box|null}}[],faceOf:(clip:string,at:number)=>Face|undefined):string[] {
  return rows.flatMap(r=>{
    const face=r.m.box&&faceOnScreen(doc,r.t,faceOf);
    const c=face?covered(r.m.box!,face):0;
    return c>FACE_COVER?[`OVER THE FACE ${Math.round(c*100)}% at ${r.t.toFixed(1)}s: ${r.label} covers the speaker's face. Move it (top, bottom or the free side) or make it smaller`]:[];
  });
}
