// Auto reframe (as Premiere's): a canvas narrower than the footage (16:9 into
// 9:16 or 1:1) crops around the speaker, following them left and right, held
// still through small moves, smoothed so it never jitters. The speaker is the
// YuNet face (voxtale_native/track.py), a HOG person where no face shows; the
// path math is in @voxtale/editdoc (motion.ts). reframePath is the one call a
// caller needs (the editor's set_frame tool, the livestream clipper later).
import {cropWidth,parseAspect,reframeFromFrames,reframeLeft,type EditDoc,type Reframe,type ReframeSpeed,type SubjectFrame} from '@voxtale/editdoc';
import {nativeSubjectPath,type NativeSubjectRow} from '../native/bridge';

export interface ReframeSource {path:string;width:number;height:number}
/** Finds the speaker over a span: the native one by default; tests pass their own. */
export type SubjectFinder=(o:{video:string;start:number;end:number;rate:number})=>Promise<{frames:NativeSubjectRow[]}>;

export interface ReframePath {
  /** Smoothed speaker path (source seconds, centre x): store it as the clip's `reframe`. Null when nobody was seen: crop the middle. */
  reframe:Reframe|null;
  /** Width of the crop as a fraction of the source; 1 means no room to move (the frame is not narrower). */
  width:number;
  /** The crop's left edge (fraction of the source width) at each key, clamped inside the frame. */
  crop:{t:number;left:number}[];
  /** How far the crop travels, in source pixels. */
  moved:number;
  /** Sampled frames, and how many showed a face or only a person. */
  frames:number;faces:number;people:number;
}

const finder:SubjectFinder=o=>nativeSubjectPath(o);

/**
 * The crop path that keeps the speaker in frame over source seconds
 * span.from-span.to of `source` for an `aspect` canvas ("9:16", "1:1" or a
 * number). Pure apart from the subject finder.
 */
export async function reframePath(source:ReframeSource,span:{from:number;to:number},aspect:string|number,
  o:{speed?:ReframeSpeed;rate?:number;subject?:SubjectFinder}={}):Promise<ReframePath> {
  if(!(span.to>span.from))throw new Error('span must end after it starts');
  const a=typeof aspect==='number'?aspect:parseAspect(aspect);
  const width=cropWidth(source,{width:a*1000,height:1000});
  const {frames:rows}=await (o.subject??finder)({video:source.path,start:span.from,end:span.to,rate:o.rate??5});
  const frames=rows.map(r=>r.slice(0,5) as SubjectFrame);
  const reframe=reframeFromFrames(frames,o.speed??'default');
  const crop=reframe?reframe.keys.map(k=>({t:k.t,left:Math.round(reframeLeft(reframe,k.t,width)*1e4)/1e4})):[];
  const lefts=crop.map(c=>c.left*source.width);
  return {reframe,width,crop,moved:lefts.length?Math.round(Math.max(...lefts)-Math.min(...lefts)):0,
    frames:rows.length,faces:rows.filter(r=>r[5]==='face').length,people:rows.filter(r=>r[5]==='person').length};
}

/** Source spans of `clipId` the cut shows (a-roll and b-roll), merged when under a second apart. */
export function shownSpans(doc:Pick<EditDoc,'tracks'>,clipId:string):{from:number;to:number}[] {
  const raw=[...doc.tracks['a-roll'],...doc.tracks['b-roll']].filter(i=>i.clipId===clipId&&i.status!=='suggested')
    .map(i=>({from:i.in,to:i.out})).sort((x,y)=>x.from-y.from);
  const out:{from:number;to:number}[]=[];
  for(const s of raw) {
    const last=out.at(-1);
    if(last&&s.from<=last.to+1)last.to=Math.max(last.to,s.to);
    else out.push({...s});
  }
  return out;
}

/** Several spans' paths as one clip reframe: keys in time order, the speed of the first. */
export function joinReframes(parts:(Reframe|null)[]):Reframe|null {
  const got=parts.filter((p):p is Reframe=>!!p);
  if(!got.length)return null;
  return {speed:got[0]!.speed,keys:got.flatMap(p=>p.keys).sort((a,b)=>a.t-b.t)};
}
