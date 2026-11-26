// Review counts: four things a viewer feels in an edit, measured from the doc
// and the words, no frames and no model. Information for the agent, never a
// pass or a fail: a long bare stretch can be the right call for a story.
//
// Thresholds are ours:
// - bare stretch > 10 s: the speaker alone, with nothing new on screen (no
//   footage, graphic, text card or zoom). 10 s is well past BROLL_MAX (6 s),
//   the longest shot the cutter plans, so it is a stretch no plan put there.
// - kept pause > 1 s mid-speech: SLOW_PAUSE, the most a slow stretch keeps on
//   purpose. Longer is a gap the cut let through, or a held beat (named).
// - reuse: the same source seconds of one clip, or one graphic, shown twice
//   within 30 s. A viewer still holds the first showing that soon.
// - too brief: footage or a graphic up under BROLL_MIN (1.5 s, the shortest
//   shot the cutter plans); a text card under 0.3 s a word (about 200 words
//   a minute, a common silent reading speed), and never under 1.5 s.
import {shown,type EditDoc} from '@voxtale/editdoc';
import {BROLL_MIN,BROLL_MAX} from './cut';

export const BARE_MAX=10;
export const PAUSE_MAX=1;
export const REUSE_SPAN=30;
const READ_PER_WORD=0.3;

export interface ReviewCount {kind:'bare'|'pause'|'reuse'|'brief';start:number;end:number;seconds:number;what:string}

type Word={start:number;end:number};

const f1=(x:number)=>x.toFixed(1);

/** `wordsOf` gives a clip's words in source seconds. */
export function reviewCounts(doc:EditDoc,wordsOf:(clipId:string)=>Word[]):ReviewCount[] {
  const out:ReviewCount[]=[];
  const a=shown(doc.tracks['a-roll']);
  const end=Math.max(0,...a.map(i=>i.end));
  // Bare: speaker-only spans between visual events.
  const cover=[...shown(doc.tracks['b-roll']),...shown(doc.tracks.graphics),...shown(doc.tracks.text),...shown(doc.tracks.zoom)]
    .map(i=>[i.start,i.end] as const).sort((x,y)=>x[0]-y[0]);
  let t=0;
  const bare=(s:number,e:number)=>{if(e-s>BARE_MAX)out.push({kind:'bare',start:s,end:e,seconds:e-s,what:`speaker alone ${f1(e-s)}s (over ${BARE_MAX}s with nothing new on screen)`});};
  for(const [s,e] of cover){if(s>t)bare(t,s);t=Math.max(t,e);}
  if(end>t)bare(t,end);
  // Pauses: silence between two heard words, in output time, not at the very start or end.
  const heard:{start:number;end:number}[]=[];
  for(const i of a) {
    const speed=(i.out-i.in)/Math.max(1e-6,i.end-i.start);
    for(const w of wordsOf(i.clipId))if(w.end>i.in&&w.start<i.out)
      heard.push({start:i.start+(Math.max(w.start,i.in)-i.in)/speed,end:i.start+(Math.min(w.end,i.out)-i.in)/speed});
  }
  heard.sort((x,y)=>x.start-y.start);
  for(let k=1;k<heard.length;k++) {
    const gap=heard[k]!.start-heard[k-1]!.end;
    if(gap>PAUSE_MAX)out.push({kind:'pause',start:heard[k-1]!.end,end:heard[k]!.start,seconds:gap,what:`pause ${f1(gap)}s kept mid-speech (over ${PAUSE_MAX}s)`});
  }
  // Reuse: same clip seconds or same graphic again soon.
  const shows=[
    ...shown(doc.tracks['b-roll']).map(b=>({key:b.clipId,from:b.in,to:b.out,start:b.start,end:b.end,what:`footage ${b.clipId} ${f1(b.in)}-${f1(b.out)}s`})),
    ...shown(doc.tracks.graphics).map(g=>({key:`g:${g.assetId}`,from:0,to:1,start:g.start,end:g.end,what:`graphic ${g.assetId}`})),
  ].sort((x,y)=>x.start-y.start);
  for(let k=0;k<shows.length;k++)for(let j=k+1;j<shows.length;j++) {
    const p=shows[k]!,q=shows[j]!,apart=q.start-p.end;
    if(apart>REUSE_SPAN)break;
    if(p.key===q.key&&q.from<p.to&&p.from<q.to)
      out.push({kind:'reuse',start:p.start,end:q.end,seconds:Math.max(0,apart),what:`${q.what} shown again ${f1(Math.max(0,apart))}s after ${f1(p.start)}s (within ${REUSE_SPAN}s)`});
  }
  // Brief: on screen too short to take in.
  for(const b of shown(doc.tracks['b-roll']))if(b.end-b.start<BROLL_MIN-1e-3)
    out.push({kind:'brief',start:b.start,end:b.end,seconds:b.end-b.start,what:`footage ${b.id} up ${f1(b.end-b.start)}s (under ${BROLL_MIN}s)`});
  for(const g of shown(doc.tracks.graphics))if(g.end-g.start<BROLL_MIN-1e-3)
    out.push({kind:'brief',start:g.start,end:g.end,seconds:g.end-g.start,what:`graphic ${g.assetId} up ${f1(g.end-g.start)}s (under ${BROLL_MIN}s)`});
  for(const x of shown(doc.tracks.text)) {
    const words=`${x.text} ${x.subtext??''}`.trim().split(/\s+/).filter(Boolean).length;
    const need=Math.max(BROLL_MIN,words*READ_PER_WORD);
    if(x.end-x.start<need-1e-3)out.push({kind:'brief',start:x.start,end:x.end,seconds:x.end-x.start,what:`text "${x.text}" up ${f1(x.end-x.start)}s (${words} words need ${f1(need)}s)`});
  }
  return out.sort((x,y)=>x.start-y.start);
}

/** Lines for a tool result. */
export function reviewText(rows:ReviewCount[]):string {
  const n=(k:ReviewCount['kind'])=>rows.filter(r=>r.kind===k).length;
  return `review counts (information, not problems: bare >${BARE_MAX}s, pause >${PAUSE_MAX}s, reuse within ${REUSE_SPAN}s, brief <${BROLL_MIN}s; longest planned shot ${BROLL_MAX}s): bare ${n('bare')}, pauses ${n('pause')}, reused ${n('reuse')}, brief ${n('brief')}`
    +rows.map(r=>`\n- ${f1(r.start)}-${f1(r.end)}s ${r.what}`).join('');
}
