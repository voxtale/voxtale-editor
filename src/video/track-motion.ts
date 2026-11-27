// Title motion tracking (as After Effects' Track Motion): a text or graphic
// pinned to a spot of the set follows that spot as the camera moves. The spot
// is followed in the a-roll piece under the item (voxtale_native/track.py:
// OpenCV Lucas-Kanade + RANSAC similarity); the keys are made and stored by
// @voxtale/editdoc (motion.ts, the item's `track`), and the render applies
// them.
import {canvasToSource,pieceAt,trackFromFrames,type ARollItem,type EditDoc,type MotionTrack,type TrackFrame} from '@voxtale/editdoc';
import {nativeTrackPoint} from '../native/bridge';

export type PointTracker=(o:{video:string;start:number;end:number;at:number;point:[number,number];zone?:[number,number,number,number]})=>Promise<{frames:TrackFrame[]}>;
const tracker:PointTracker=o=>nativeTrackPoint(o);

type Trackable=EditDoc['tracks']['text'][number]|EditDoc['tracks']['graphics'][number];

/** The text or graphic item `id`, and which track holds it. */
export function trackableItem(doc:EditDoc,id:string):{kind:'text'|'graphics';item:Trackable} {
  const t=doc.tracks.text.find(i=>i.id===id);
  if(t)return {kind:'text',item:t};
  const g=doc.tracks.graphics.find(i=>i.id===id);
  if(g)return {kind:'graphics',item:g};
  throw new Error(`no text or graphic "${id}" on the cut`);
}

export interface TrackPlan {
  item:Trackable;piece:ARollItem;
  /** Source seconds to follow, the anchor's source second, the spot in the source frame (fractions). */
  from:number;to:number;at:number;point:[number,number];
  /** Output second of the anchor. */
  anchor:number;
  /** The item runs past the piece under it: it holds still outside the piece. */
  partial:boolean;
}

/**
 * What to follow for item `id` pinned at canvas `point` (fractions) at output
 * second `at` (default the item's middle): the piece under it, the source span
 * both cover, and the spot in the source frame. Refuses what cannot be followed.
 */
export function planTrack(doc:EditDoc,id:string,point:{x:number;y:number},at?:number):TrackPlan {
  const {item}=trackableItem(doc,id);
  const anchor=at??(item.start+item.end)/2;
  if(!(anchor>=item.start-1e-6&&anchor<=item.end+1e-6))throw new Error(`the anchor ${anchor.toFixed(2)}s is outside ${id} (${item.start.toFixed(2)}-${item.end.toFixed(2)}s)`);
  const piece=pieceAt(doc,anchor);
  if(!piece)throw new Error(`no footage under ${id} at ${anchor.toFixed(2)}s`);
  if(piece.angle||piece.layout==='split'||piece.layout==='pip')throw new Error(`the piece under ${id} shows another angle or a split: tracking those is not supported yet`);
  const clip=doc.clips.find(c=>c.id===piece.clipId);
  if(clip?.kind!=='video')throw new Error(`the piece under ${id} is not video`);
  const a=Math.max(item.start,piece.start),b=Math.min(item.end,piece.end);
  const src=(t:number)=>piece.in+(t-piece.start);
  const p=canvasToSource(doc,piece,anchor,point);
  if(p.x<0||p.x>1||p.y<0||p.y>1)throw new Error('the spot is off the footage at the anchor');
  return {item,piece,from:src(a),to:src(b),at:src(Math.min(b,Math.max(a,anchor))),point:[p.x,p.y],anchor,
    partial:a>item.start+1e-6||b<item.end-1e-6};
}

export interface TrackResult {track:MotionTrack;keys:number;moved:number;scale:[number,number];partial:boolean}

/** Follow the spot for item `id` and return its motion track (the caller stores it on the item). `video` is the clip's file on this machine. */
export async function trackItem(doc:EditDoc,id:string,video:string,o:{point:{x:number;y:number};at?:number;zone?:[number,number,number,number];tracker?:PointTracker}):Promise<TrackResult> {
  const plan=planTrack(doc,id,o.point,o.at);
  const {frames}=await (o.tracker??tracker)({video,start:plan.from,end:plan.to,at:plan.at,point:plan.point,...(o.zone?{zone:o.zone}:{})});
  const track=trackFromFrames(doc,plan.item,plan.piece,frames,plan.anchor,o.point);
  const W=doc.canvas.width,H=doc.canvas.height,ss=track.keys.map(k=>k.s??1);
  const moved=Math.round(Math.max(...track.keys.map(k=>Math.hypot(k.dx*W,k.dy*H))));
  return {track,keys:track.keys.length,moved,scale:[Math.min(...ss),Math.max(...ss)],partial:plan.partial};
}
