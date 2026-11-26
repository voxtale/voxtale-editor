// Can a viewer read the text? For each text card and caption line on screen,
// the overlay is drawn twice over the same frame: as the render draws it, and
// with the letters' fill turned clear. Where the two differ is the letters;
// the ring of pixels just outside them is what they are read against (their
// outline, their box, or the picture). The WCAG contrast ratio of the two is
// the measure. Text near the frame edge is flagged too. Code only, no model.
//
// Threshold: 3:1, WCAG 2.x success criterion 1.4.3 (AA) for large text.
// Overlay text is large by WCAG's own measure: captions and cards on a 1080
// frame are 40 px and up, well over its 24 px (18 pt) line, and that holds on
// a phone too since the frame shrinks with the screen. Edge: the brand's safe
// margin (fraction of the width per edge, default 5%), the area players and
// phone UI crop or cover.
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {shown,type EditDoc} from '@voxtale/editdoc';
import {assScript,filterPath} from '../../render-edit';

/** WCAG 2.x relative luminance of an sRGB colour, 0-255 channels. */
export function luminance(r:number,g:number,b:number):number {
  const lin=(c:number)=>{const s=c/255;return s<=0.03928?s/12.92:((s+0.055)/1.055)**2.4;};
  return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
}

/** WCAG contrast ratio of two luminances, 1-21. */
export const contrast=(a:number,b:number)=>(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);

/** Below this the text fails WCAG AA for large text. */
export const MIN_CONTRAST=3;
/** Pixels differing by more than this (any channel) are part of the drawing. */
const DRAWN=24;
/** Ring outside the letters, in pixels of the measured frame: past the anti-aliased edge, inside a thin outline's reach. */
const RING_IN=1,RING_OUT=3;

export interface RGB {width:number;height:number;data:Uint8Array}

export interface Legibility {
  /** Text colour as drawn, and what it is read against, #rrggbb. */
  text:string;
  behind:string;
  ratio:number;
  /** Drawn area (letters plus outline or box), fractions of the frame. */
  box:{x:number;y:number;w:number;h:number}|null;
  /** Edges the drawing comes within the safe margin of. */
  edges:('left'|'right'|'top'|'bottom')[];
}

const hex=(r:number,g:number,b:number)=>'#'+[r,g,b].map(x=>Math.round(x).toString(16).padStart(2,'0')).join('');
const median=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]!:0;};

/** Grow a mask by `r` pixels (square), in two passes. */
function grow(mask:Uint8Array,w:number,h:number,r:number):Uint8Array {
  const a=new Uint8Array(mask.length),b=new Uint8Array(mask.length);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(mask[y*w+x])for(let d=-r;d<=r;d++){const xx=x+d;if(xx>=0&&xx<w)a[y*w+xx]=1;}
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(a[y*w+x])for(let d=-r;d<=r;d++){const yy=y+d;if(yy>=0&&yy<h)b[yy*w+x]=1;}
  return b;
}

/**
 * Measure one overlay: `bare` is the frame with nothing drawn, `full` with the
 * overlay, `clear` with the overlay's letters clear. Null when nothing drew.
 */
export function measure(bare:RGB,full:RGB,clear:RGB,margin:number):Legibility|null {
  const {width:w,height:h}=full,n=w*h;
  const diff=(p:RGB,q:RGB,i:number)=>Math.max(Math.abs(p.data[i*3]!-q.data[i*3]!),Math.abs(p.data[i*3+1]!-q.data[i*3+1]!),Math.abs(p.data[i*3+2]!-q.data[i*3+2]!));
  const letters=new Uint8Array(n),strength=new Uint16Array(n);
  let x0=w,y0=h,x1=-1,y1=-1;
  for(let i=0;i<n;i++) {
    const d=diff(full,clear,i);
    if(d>DRAWN){letters[i]=1;strength[i]=d;}
    if(diff(full,bare,i)>DRAWN){const x=i%w,y=(i/w)|0;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
  }
  const lit=[...strength.keys()].filter(i=>letters[i]);
  if(!lit.length)return null;
  // Fully covered letter pixels: the stronger half of the difference (edges blend into what is behind).
  const cut=median(lit.map(i=>strength[i]!));
  const core=lit.filter(i=>strength[i]!>=cut);
  const inner=grow(letters,w,h,RING_IN),outer=grow(letters,w,h,RING_OUT);
  const ring:number[]=[];
  for(let i=0;i<n;i++)if(outer[i]&&!inner[i])ring.push(i);
  const pick=(idx:number[])=>{
    const ls=idx.map(i=>({i,l:luminance(full.data[i*3]!,full.data[i*3+1]!,full.data[i*3+2]!)})).sort((a,b)=>a.l-b.l);
    const m=ls[Math.floor(ls.length/2)]!;
    return {l:m.l,rgb:hex(full.data[m.i*3]!,full.data[m.i*3+1]!,full.data[m.i*3+2]!)};
  };
  const t=pick(core),b=ring.length?pick(ring):t;
  const px=margin*w,edges:Legibility['edges']=[];
  if(x1>=0) {
    if(x0<px)edges.push('left');
    if(x1>w-1-px)edges.push('right');
    if(y0<px)edges.push('top');
    if(y1>h-1-px)edges.push('bottom');
  }
  return {text:t.rgb,behind:b.rgb,ratio:Math.round(contrast(t.l,b.l)*100)/100,
    box:x1>=0?{x:x0/w,y:y0/h,w:(x1-x0+1)/w,h:(y1-y0+1)/h}:null,edges};
}

/** ASS with every letter's fill clear; outlines, boxes and shadows stay. */
export const clearLetters=(ass:string)=>ass.split('\n').map(l=>l.startsWith('Dialogue:')
  ?l.replace(/\\1a&H[0-9A-F]{2}&/gi,'\\1a&HFF&').replace(/^(Dialogue:[^{]*\{)/,'$1\\1a&HFF&')
  :l).join('\n');

/** The doc with only one overlay showing; other captions stay as suggestions so the text keeps its place. */
export function only(doc:EditDoc,id:string):EditDoc {
  const hide=<T extends {id:string;status:string}>(xs:T[])=>xs.map(x=>x.id===id?x:{...x,status:'suggested' as const});
  return {...doc,tracks:{...doc.tracks,text:hide(doc.tracks.text),captions:hide(doc.tracks.captions)}};
}

/** Overlays (text cards and caption lines) on screen at output second `t`. */
export function overlaysAt(doc:EditDoc,t:number):{id:string;label:string}[] {
  const on=<T extends {start:number;end:number;status:string}>(xs:T[])=>shown(xs).filter(x=>x.start<=t+1e-6&&t<x.end-1e-6);
  return [...on(doc.tracks.text).map(x=>({id:x.id,label:`text "${x.text}"`})),...on(doc.tracks.captions).map(x=>({id:x.id,label:`caption "${x.text}"`}))];
}

export type Ff=(args:string[])=>Promise<void>;

/** A frame (image file) with `ass` drawn at output second `t`, as raw RGB. */
async function drawAt(ff:Ff,frame:string,size:{width:number;height:number},ass:string|null,t:number,out:string,fontsDir?:string):Promise<RGB> {
  const {readFile}=await import('node:fs/promises');
  let vf=`scale=${size.width}:${size.height}`;
  if(ass) {
    const file=`${out}.ass`;
    await writeFile(file,ass);
    vf+=`,setpts=${t.toFixed(3)}/TB,ass=filename='${filterPath(file)}'${fontsDir?`:fontsdir='${filterPath(fontsDir)}'`:''}`;
  }
  await ff(['-i',frame,'-vf',`${vf},format=rgb24`,'-frames:v','1','-f','rawvideo',out]);
  return {...size,data:new Uint8Array(await readFile(out))};
}

/** Draw `doc`'s overlays (all of them) over a frame at `t`, to an image file. */
export async function drawOverlays(ff:Ff,frame:string,doc:EditDoc,t:number,out:string,fontsDir?:string):Promise<void> {
  const ass=assScript(doc,doc.fps.num/doc.fps.den);
  const file=`${out}.ass`;
  await writeFile(file,ass);
  await ff(['-i',frame,'-vf',`setpts=${t.toFixed(3)}/TB,ass=filename='${filterPath(file)}'${fontsDir?`:fontsdir='${filterPath(fontsDir)}'`:''}`,'-frames:v','1',out]);
}

/**
 * Legibility of every overlay on screen at `t`, over `frame` (the picture
 * without text, at `size`). One line per overlay that fails, plus the numbers.
 */
export async function legibilityAt(o:{ff:Ff;doc:EditDoc;t:number;frame:string;size:{width:number;height:number};dir:string;fontsDir?:string}):Promise<{id:string;label:string;m:Legibility}[]> {
  const fps=o.doc.fps.num/o.doc.fps.den,margin=o.doc.styleRef.snapshot.brand.safeMargins;
  const tag=`${Math.round(o.t*100)}`;
  const bare=await drawAt(o.ff,o.frame,o.size,null,o.t,join(o.dir,`bare-${tag}.rgb`));
  const out:{id:string;label:string;m:Legibility}[]=[];
  for(const [k,x] of overlaysAt(o.doc,o.t).entries()) {
    const ass=assScript(only(o.doc,x.id),fps);
    const full=await drawAt(o.ff,o.frame,o.size,ass,o.t,join(o.dir,`full-${tag}-${k}.rgb`),o.fontsDir);
    const clear=await drawAt(o.ff,o.frame,o.size,clearLetters(ass),o.t,join(o.dir,`clear-${tag}-${k}.rgb`),o.fontsDir);
    const m=measure(bare,full,clear,margin);
    if(m)out.push({...x,m});
  }
  return out;
}

/** Warnings for a tool result: low contrast and text at the edge. */
export function legibilityWarnings(rows:{label:string;m:Legibility}[]):string[] {
  return rows.flatMap(({label,m})=>[
    ...(m.ratio<MIN_CONTRAST?[`LOW CONTRAST ${m.ratio.toFixed(1)}:1 (needs ${MIN_CONTRAST}:1): ${label}, ${m.text} on ${m.behind}. Change the text colour, add an outline or a box, or move it`]:[]),
    ...(m.edges.length?[`NEAR THE EDGE (${m.edges.join(', ')}): ${label} reaches into the safe margin that players and phones cover`]:[]),
  ]);
}

/**
 * The changed moments as one sheet with text and captions drawn, plus the
 * legibility of each overlay. `shots` are the bare frames drawPreview left
 * (shot-<k>.jpg in `dir`), one per time in `times`.
 */
export async function textSheet(o:{ff:Ff;doc:EditDoc;times:number[];dir:string;size:{width:number;height:number};fontsDir?:string}):Promise<{sheet:Uint8Array;rows:{t:number;id:string;label:string;m:Legibility}[]}> {
  const {readFile}=await import('node:fs/promises');
  const rows:{t:number;id:string;label:string;m:Legibility}[]=[];
  for(const [k,t] of o.times.entries()) {
    const frame=join(o.dir,`shot-${k}.jpg`);
    for(const r of await legibilityAt({ff:o.ff,doc:o.doc,t,frame,size:o.size,dir:o.dir,...(o.fontsDir?{fontsDir:o.fontsDir}:{})}))rows.push({t,...r});
    await drawOverlays(o.ff,frame,o.doc,t,join(o.dir,`text-${k}.jpg`),o.fontsDir);
  }
  const tall=o.size.height>o.size.width,cols=Math.min(o.times.length,tall?6:3),lines=Math.ceil(o.times.length/cols);
  const sheet=join(o.dir,'changed.jpg');
  await o.ff(['-start_number','0','-i',join(o.dir,'text-%d.jpg'),'-vf',`scale=${tall?320:640}:-2,tile=${cols}x${lines}:padding=4:color=white`,'-frames:v','1',sheet]);
  return {sheet:new Uint8Array(await readFile(sheet)),rows};
}
