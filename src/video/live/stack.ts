// Livestream clips: where the streamer's webcam sits in a corner, the piece
// shows as a stack (EditDoc v9): webcam band on top, game below, both from
// the same picture. The cut is built as usual; this splits each a-roll piece
// where the layout changes (by source time) and marks the stacked parts.
// Full-screen webcam and game-only spans are not touched: the clip's reframe
// path (reframe.ts) crops them.
import type {ARollItem,EditDoc,Stack} from '@voxtale/editdoc';

/** A source-time span of one clip shown as a stack. */
export interface StackSpan {from:number;to:number;stack:Stack}

const EPS=1e-6;

/**
 * Split a-roll pieces of each clip at its stack spans' edges and lay those
 * parts out as stacks. Cuts land on frames; parts under one frame are kept
 * whole. Zoom over a stacked part is dropped (the bands are their own crops).
 */
export function applyStacks(doc:EditDoc,stacks:Record<string,StackSpan[]>|undefined):EditDoc {
  if(!stacks||!Object.values(stacks).some(s=>s.length))return doc;
  const f=doc.fps.num/doc.fps.den,snap=(t:number)=>Math.round(t*f)/f;
  const out:ARollItem[]=[];
  for(const item of doc.tracks['a-roll']) {
    const spans=(stacks[item.clipId]??[]).filter(s=>s.to>item.in+EPS&&s.from<item.out-EPS);
    if(!spans.length||item.layout==='split'||item.layout==='pip'||item.angle) {out.push(item);continue;}
    // Edges inside the piece, in timeline time on frames.
    const cuts=[...new Set(spans.flatMap(s=>[s.from,s.to]).filter(t=>t>item.in+EPS&&t<item.out-EPS)
      .map(t=>snap(item.start+(t-item.in))).filter(t=>t>item.start+0.5/f&&t<item.end-0.5/f))].sort((a,b)=>a-b);
    const edges=[item.start,...cuts,item.end];
    for(let k=0;k+1<edges.length;k++) {
      const s=edges[k]!,e=edges[k+1]!,inS=item.in+(s-item.start),outS=item.in+(e-item.start);
      const mid=(inS+outS)/2,hit=spans.find(x=>mid>=x.from&&mid<x.to);
      const {transition,fadeIn,fadeOut,audioLead,audioLag,...rest}=item;
      const piece:ARollItem={...rest,id:edges.length>2?`${item.id}-l${k+1}`.slice(0,120):item.id,start:s,end:e,in:inS,out:outS,
        ...(k===0&&transition?{transition}:{}),...(k===0&&fadeIn!==undefined?{fadeIn}:{}),...(k===0&&audioLead!==undefined?{audioLead}:{}),
        ...(k===edges.length-2&&fadeOut!==undefined?{fadeOut}:{}),...(k===edges.length-2&&audioLag!==undefined?{audioLag}:{})};
      if(hit) {piece.layout='stack';piece.stack=hit.stack;delete piece.companions;delete piece.pipCorner;}
      out.push(piece);
    }
  }
  const stacked=out.filter(i=>i.layout==='stack');
  const zoom=doc.tracks.zoom.filter(z=>!stacked.some(i=>i.start<z.end-EPS&&i.end>z.start+EPS));
  return {...doc,tracks:{...doc.tracks,'a-roll':out,zoom}};
}
