// Where to look after an edit: the output seconds at which the edit now looks
// different from the version the agent last watched. Framing first (a zoom or
// footage shot added or changed: the costliest to get wrong), then text and
// graphics just after their entrance, then the caption look mid-line. Items
// match by what they are and where, not by id, so a rebuild that renames
// items without changing them is not a change. Pure: no I/O.
import {shown,type EditDoc} from '@voxtale/editdoc';

export interface Moment {
  /** Output second. */
  t:number;
  /** 0 framing, 1 text and graphics, 2 captions. */
  rank:0|1|2;
  why:string;
}

/** Most frames one check looks at. */
export const CHANGED_MAX=6;
/** Two moments closer than this are one frame. */
const NEAR=0.3;
/** Seconds after an entrance the frame is taken: the item has finished animating in by then on every template. */
const SETTLED=0.8;

const r2=(x:number)=>Math.round(x*100)/100;
const key=(o:Record<string,unknown>,fields:string[])=>JSON.stringify(fields.map(f=>{const v=o[f];return typeof v==='number'?r2(v):v??null;}));

function fresh<T extends {start:number;end:number;status:string}>(before:T[]|undefined,after:T[],fields:string[]):T[] {
  const was=new Set(shown(before??[]).map(i=>key(i as Record<string,unknown>,fields)));
  return shown(after).filter(i=>!was.has(key(i as Record<string,unknown>,fields)));
}

const ZOOM=['start','end','scale','x','y','panTo','easeIn','easeOut'];
const BROLL=['start','end','clipId','in','fit','crop','pip','speed','opacity'];
const TEXT=['start','end','template','text','subtext','position','look'];
const GRAPHIC=['start','end','assetId','assetRevision','placement'];
const CAPTION=['start','end','text'];

/** The changed moments of `after` against `before` (none = the agent has not watched yet: everything counts). */
export function changedMoments(before:EditDoc|undefined,after:EditDoc,max=CHANGED_MAX):Moment[] {
  const end=Math.max(0,...after.tracks['a-roll'].map(i=>i.end),...after.tracks.voiceover.map(i=>i.end));
  const inCut=(t:number)=>t>=0&&t<end-1e-3;
  const out:Moment[]=[];
  for(const z of fresh(before?.tracks.zoom,after.tracks.zoom,ZOOM)) {
    // Mid-hold: past the ease in, before the ease out.
    const a=z.start+Math.min(z.easeIn,(z.end-z.start)/2),b=z.end-Math.min(z.easeOut,(z.end-z.start)/2);
    out.push({t:(a+b)/2,rank:0,why:`zoom ${z.scale.toFixed(2)}x ${z.start.toFixed(1)}-${z.end.toFixed(1)}s`});
  }
  // A zoom taken away: the wide frame is new there.
  for(const z of fresh(after.tracks.zoom,before?.tracks.zoom??[],ZOOM))out.push({t:(z.start+z.end)/2,rank:0,why:`zoom removed ${z.start.toFixed(1)}-${z.end.toFixed(1)}s`});
  for(const b of fresh(before?.tracks['b-roll'],after.tracks['b-roll'],BROLL))
    out.push({t:(b.start+b.end)/2,rank:0,why:`footage ${b.id}${b.crop?' cropped':''}${b.pip?` with speaker ${b.pip}`:''}`});
  for(const x of fresh(before?.tracks.text,after.tracks.text,TEXT))
    out.push({t:x.start+Math.min(SETTLED,(x.end-x.start)/2),rank:1,why:`text ${x.template} "${x.text}"`});
  for(const g of fresh(before?.tracks.graphics,after.tracks.graphics,GRAPHIC))
    out.push({t:g.start+Math.min(SETTLED,(g.end-g.start)/2),rank:1,why:`graphic ${g.assetId}`});
  const caps=shown(after.tracks.captions);
  const lookChanged=before&&JSON.stringify(before.styleRef.snapshot.brand.captionStyle)!==JSON.stringify(after.styleRef.snapshot.brand.captionStyle);
  // A new look shows on any line: the longest one, mid-sentence.
  const pick=lookChanged?caps:fresh(before?.tracks.captions,after.tracks.captions,CAPTION);
  const line=[...pick].sort((a,b)=>(b.end-b.start)-(a.end-a.start))[0];
  if(line)out.push({t:(line.start+line.end)/2,rank:2,why:lookChanged?'caption look changed':`caption "${line.text}"`});
  const kept:Moment[]=[];
  for(const m of out.filter(m=>inCut(m.t)).sort((a,b)=>a.rank-b.rank||a.t-b.t)) {
    if(kept.length>=max)break;
    if(kept.some(k=>Math.abs(k.t-m.t)<NEAR))continue;
    kept.push({...m,t:r2(m.t)});
  }
  return kept.sort((a,b)=>a.t-b.t);
}
