// Zoom stage (P4b), by code: a jump cut inside one clip alternates between
// the wide frame and a punch-in so the cut reads as intended, the hook gets a
// slow push-in, and fast styles push in at each new beat. The agent editor
// instead names the few lines to stress, and only those punch in. Each zoom aims its
// focus so the speaker's eyes land on screen where they were just before the
// cut (an editor's eye-trace match), which makes the cut far less jarring.
import type {ARollItem,EditDoc,IndexSegment,ZoomItem} from '@voxtale/editdoc';
import type {StoryClip} from './story-edit';

export const PUNCH=1.12,HOOK_PUSH=1.08,BEAT_PUSH=1.05,LINE_PUSH=1.1;
/** Most a reframe crops in to move the speaker clear of a side panel, and how fast it gets there. */
export const REFRAME_MAX=1.3,REFRAME_EASE=0.4;
/** A face this far to the free side of centre needs no reframe. */
const REFRAME_CLEAR=0.12;
/** A push-in needs this long to read as movement, not a jolt. */
const MIN_PUSH_SECONDS=2.5;
/** A source gap longer than this between two pieces of one clip is a jump cut. */
const JUMP_GAP=0.05;
/** A punch shorter than this holds one framing; longer ones may drift to match both cuts. */
const MIN_DRIFT_SECONDS=1.5;

export interface Point {x:number;y:number}
/** Where the speaker's eyes are at a source time, or undefined when unknown. */
export type EyesAt=(clipId:string,t:number)=>Point|undefined;

const r3=(n:number)=>Math.round(n*1000)/1000;
const clamp=(n:number)=>Math.min(1,Math.max(0,n));

/** Face centre at an item's source start, else frame centre. */
function focus(item:ARollItem,segments:IndexSegment[]|undefined):Point {
  const seg=segments?.find(s=>s.face&&s.start<=item.in+1e-6&&s.end>item.in)??segments?.find(s=>s.face&&s.start<item.out&&s.end>item.in);
  return seg?.face?{x:seg.face.x,y:seg.face.y}:{x:0.5,y:0.5};
}

/** Screen position of source point e under scale s about focus f. */
const onScreen=(e:Point,s:number,f:Point):Point=>({x:f.x+s*(e.x-f.x),y:f.y+s*(e.y-f.y)});
/**
 * Focus that puts source point e at screen point p under scale s. The crop
 * stays inside the frame only for a focus in [0,1], so the match is clamped:
 * a 12% punch can move the eyes about 6% of the frame each way.
 */
const aim=(e:Point,p:Point,s:number):Point=>({x:(s*e.x-p.x)/(s-1),y:(s*e.y-p.y)/(s-1)});
const mean=(ps:Point[]):Point=>({x:ps.reduce((n,p)=>n+p.x,0)/ps.length,y:ps.reduce((n,p)=>n+p.y,0)/ps.length});

/**
 * The zoom track for the style: the creator's zooms kept, agent zooms planned
 * around them. Each agent zoom spans one a-roll item, so it starts and ends on
 * a cut (no ease: the cut hides the jump). Items the creator owns or the agent
 * is unsure of get none. eyesAt gives the eyes on the exact frames each side
 * of a cut; without it, the index's face at the item's start stands in.
 */
export function planZoom(doc:EditDoc,clips:StoryClip[],eyesAt?:EyesAt,o:{stress?:(item:ARollItem)=>string|undefined;
  /** A stressed item that pushes in slowly over the line instead of cutting in. */
  push?:(item:ARollItem)=>boolean}={}):ZoomItem[] {
  const freq=doc.styleRef.snapshot.pace.zoomFrequency;
  const index=new Map(clips.filter(c=>c.index).map(c=>[c.ref.id,c.index!.segments]));
  const live=doc.tracks['a-roll'].filter(i=>i.status==='applied').sort((a,b)=>a.start-b.start);
  const planned:ZoomItem[]=[];
  if(freq!=='none') {
    // Pass 1: which items zoom, and how.
    type Move={kind:'punch'|'push';to:number;why?:string}|undefined;
    const moves:Move[]=[];
    let punched=false,beat:string|undefined;
    live.forEach((item,k)=>{
      const prev=live[k-1];
      const len=item.end-item.start;
      const beatOf=item.evidence?.find(e=>e.kind==='beat')?.ref;
      const newBeat=k>0&&beatOf!==undefined&&beatOf!==beat;
      beat=beatOf??beat;
      const jump=!!prev&&prev.clipId===item.clipId&&Math.abs(item.in-prev.out)>JUMP_GAP&&Math.abs(item.start-prev.end)<JUMP_GAP;
      let move:Move;
      const why=o.stress?.(item);
      if(k===0&&freq!=='low'&&len>=MIN_PUSH_SECONDS){move={kind:'push',to:HOOK_PUSH};punched=true;}
      // Stressed lines replace the jump-cut rhythm: a punch on every other cut reads as a tic, not emphasis.
      else if(o.stress){move=why===undefined?undefined:o.push?.(item)&&len>=MIN_PUSH_SECONDS?{kind:'push',to:LINE_PUSH,why}:{kind:'punch',to:PUNCH,why};punched=move?.kind==='punch';}
      else if(jump){punched=!punched;move=punched?{kind:'punch',to:PUNCH}:undefined;}
      else if(freq==='high'&&newBeat&&len>=MIN_PUSH_SECONDS){move={kind:'push',to:BEAT_PUSH};punched=false;}
      else punched=false;
      moves.push(move);
    });
    // Pass 2: aim each zoom so the eyes do not jump across its cuts.
    const eyes=(item:ARollItem,t:number)=>eyesAt?.(item.clipId,t)??focus(item,index.get(item.clipId));
    const inOf=(item:ARollItem)=>eyes(item,item.in);
    const outOf=(item:ARollItem)=>eyes(item,Math.max(item.in,item.out-0.05));
    // Scale and focus each item ends on, for the next item's match.
    let last:{s:number;f:Point}={s:1,f:{x:0.5,y:0.5}};
    live.forEach((item,k)=>{
      const move=moves[k],prev=live[k-1],next=live[k+1];
      const joinedPrev=!!prev&&Math.abs(item.start-prev.end)<JUMP_GAP;
      const joinedNext=!!next&&Math.abs(next.start-item.end)<JUMP_GAP&&moves[k+1]?.kind!=='punch';
      const eIn=inOf(item),eOut=outOf(item);
      if(move&&item.owner==='agent'&&(item.confidence??1)>=doc.styleRef.snapshot.applyConfidence) {
        const s=move.to,len=item.end-item.start;
        const fit=(p:Point)=>({x:r3(clamp(p.x)),y:r3(clamp(p.y))});
        // In: a punch starts zoomed, so its start can meet the eyes of the frame before.
        const fIn=move.kind==='punch'&&joinedPrev?fit(aim(eIn,onScreen(outOf(prev),last.s,last.f),s)):undefined;
        // Out: the next item starts wide, so end where its eyes will be.
        const fOut=joinedNext?fit(aim(eOut,inOf(next!),s)):undefined;
        let f=fit(eIn),panTo:Point|undefined;
        if(move.kind==='push')f=fOut??f;
        else if(fIn&&fOut&&len>=MIN_DRIFT_SECONDS&&Math.hypot(fIn.x-fOut.x,fIn.y-fOut.y)>0.005) {
          // One framing cannot match both cuts: drift between the two, slowly enough to read as a reframe.
          f=fIn;panTo=fOut;
        } else f=fIn&&fOut?fit(mean([fIn,fOut])):fIn??fOut??f;
        planned.push({
          id:`zoom-${item.id}`,start:item.start,end:item.end,owner:'agent',stage:'zoom',status:'applied',
          reason:(move.why!==undefined?`${move.kind==='push'?'slow push':'punch-in'} on a key line${move.why?`: ${move.why}`:''}`:move.kind==='punch'?'punch-in hides the jump cut':'push-in on the line').slice(0,300),
          scale:s,...f,target:'face',easeIn:move.kind==='push'?r3(len):0,easeOut:0,...(panTo?{panTo}:{}),
        });
        last={s,f:panTo??f};
      } else last={s:1,f:{x:0.5,y:0.5}};
    });
  }
  // The creator's zooms stay; agent zooms give way to them.
  const mine=doc.tracks.zoom.filter(z=>z.owner==='creator');
  return [...mine,...planned.filter(z=>!mine.some(c=>c.start<z.end&&z.start<c.end))].sort((a,b)=>a.start-b.start);
}

/**
 * A side panel shares the frame with the speaker: crop in and slide them to
 * the free side while it is up, easing there and back. Undefined when the
 * face already sits clear of the panel. `face`: where the speaker is as the
 * panel comes in.
 */
export function reframeFor(g:{id:string;start:number;end:number;placement:string},face:Point):ZoomItem|undefined {
  if(g.placement!=='left'&&g.placement!=='right')return undefined;
  const left=g.placement==='left';
  if(left?face.x>=0.5+REFRAME_CLEAR:face.x<=0.5-REFRAME_CLEAR)return undefined;
  if(g.end-g.start<REFRAME_EASE*3)return undefined;
  // The middle of the free side, as far as the crop allows without showing an edge.
  const want=left?0.72:0.28;
  const need=left?want/Math.max(face.x,0.05):(1-want)/Math.max(1-face.x,0.05);
  const s=Math.min(REFRAME_MAX,Math.max(1.05,need));
  return {id:`zoom-${g.id}`,start:g.start,end:g.end,owner:'agent',stage:'zoom',status:'applied',
    reason:`speaker moves ${left?'right':'left'}, clear of the panel`,
    scale:r3(s),x:left?0:1,y:r3(clamp(face.y)),target:'face',easeIn:REFRAME_EASE,easeOut:REFRAME_EASE};
}
