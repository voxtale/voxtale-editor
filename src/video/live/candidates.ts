// From a whole live's words and signals to a short ranked list of clip
// candidates, locally: signals score 10 s bins, the best bins (spread out,
// and at least one per 20-min block so quiet stretches still get a look)
// become 15-90 s windows snapped to sentence edges. Only those windows go to
// a model (prompt live.scan), never the whole 12 h.
import {hms,type Signal,type SignalKind} from './signals';
import type {LiveWord} from './transcribe';

export interface Candidate {
  id:string;start:number;end:number;
  /** Local score 0-1 from signals and speech. */
  score:number;
  cues:SignalKind[];notes:string[];
  /** From the model pass (live_rate / live.scan): 1-10, one line each. */
  rating?:number;what?:string;why?:string;
}

/** Weight of each kind of clue (a marker the streamer set beats a loud bang). */
export const KIND_WEIGHT:Record<SignalKind,number>={marker:1,replays:0.9,chat:0.8,laugh:0.7,sound:0.5,image:0.3};
export const BIN=10,MIN_LEN=15,MAX_LEN=90,SPREAD=45,BLOCK=20*60;

/**
 * Candidates over a `duration`-second live. `top` caps the list (the
 * coverage picks may add a few). Pure.
 */
export function findCandidates(words:LiveWord[],signals:Signal[],duration:number,o:{top?:number}={}):Candidate[] {
  const n=Math.max(1,Math.ceil(duration/BIN)),score=new Float64Array(n),talk=new Float64Array(n);
  const cues:Map<number,Signal[]>=new Map();
  for(const s of signals) {
    const b=Math.min(n-1,Math.max(0,Math.floor(s.t/BIN)));
    score[b]+=KIND_WEIGHT[s.kind]*s.weight;
    cues.set(b,[...(cues.get(b)??[]),s]);
  }
  for(const w of words)talk[Math.min(n-1,Math.floor(w.start/BIN))]!++;
  // Speech density is a weak clue of its own (a rant, a story), capped.
  const talkMed=[...talk].sort((a,b)=>a-b)[Math.floor(n/2)]||1;
  const raw=Array.from(score,(v,i)=>v+0.15*Math.min(2,talk[i]!/talkMed));
  // Smooth over ±1 bin: a moment spans more than 10 s.
  const smooth=raw.map((v,i)=>v+0.5*((raw[i-1]??0)+(raw[i+1]??0)));
  const order=smooth.map((v,i)=>[v,i] as const).sort((a,b)=>b[0]-a[0]);
  const picked:number[]=[],far=(i:number)=>picked.every(p=>Math.abs(p-i)*BIN>=SPREAD);
  const top=o.top??80;
  for(const [,i] of order){if(picked.length>=top)break;if(far(i))picked.push(i);}
  // Coverage: the best bin of every 20-min block nothing came from.
  for(let from=0;from<duration;from+=BLOCK) {
    const a=Math.floor(from/BIN),b=Math.min(n,Math.ceil((from+BLOCK)/BIN));
    if(picked.some(p=>p>=a&&p<b))continue;
    let best=-1;for(let i=a;i<b;i++)if(best<0||smooth[i]!>smooth[best]!)best=i;
    if(best>=0&&talk.slice(a,b).some(x=>x>0))picked.push(best);
  }
  const max=Math.max(1e-9,...picked.map(i=>smooth[i]!));
  const sentences=sentenceEdges(words);
  return picked.sort((a,b)=>a-b).map((i,k)=>{
    const near=[i-1,i,i+1].flatMap(b=>cues.get(b)??[]);
    const [start,end]=windowAround((i+0.5)*BIN,sentences,duration);
    return {id:`w${String(k+1).padStart(3,'0')}`,start,end,score:Math.round(smooth[i]!/max*1000)/1000,
      cues:[...new Set(near.map(s=>s.kind))],notes:near.map(s=>`${hms(s.t)} ${s.note}`).slice(0,6)};
  });
}

/** Sentence spans [start,end] from the words (a sentence ends on . ! ? or a pause over 1.2 s). */
export function sentenceEdges(words:LiveWord[]):[number,number][] {
  const out:[number,number][]=[];
  let from:number|undefined;
  words.forEach((w,i)=>{
    from??=w.start;
    const next=words[i+1];
    if(/[.!?]["')\]]?$/.test(w.text)||!next||next.start-w.end>1.2){out.push([from,w.end]);from=undefined;}
  });
  return out;
}

/**
 * A window around moment `t`: from 20 s before to 25 s after (setup and
 * payoff), widened to whole sentences, kept 15-90 s. No speech: the plain span.
 */
export function windowAround(t:number,sentences:[number,number][],duration:number):[number,number] {
  let a=Math.max(0,t-20),b=Math.min(duration,t+25);
  const startIn=sentences.find(s=>s[0]<=a&&s[1]>a),endIn=sentences.find(s=>s[0]<b&&s[1]>=b);
  if(startIn&&a-startIn[0]<12)a=startIn[0];
  if(endIn&&endIn[1]-b<12)b=endIn[1];
  if(b-a>MAX_LEN){const c=(a+b)/2;a=Math.max(0,c-MAX_LEN/2);b=a+MAX_LEN;}
  if(b-a<MIN_LEN){b=Math.min(duration,a+MIN_LEN);a=Math.max(0,b-MIN_LEN);}
  return [Math.round(a*100)/100,Math.round(b*100)/100];
}

/**
 * One line per sentence (or every 20 s at most), its time in front; a gap
 * over 20 s shows as "(no speech for N s)"; hints as "▲" lines.
 */
export function lines(words:LiveWord[],hints:{t:number;text:string}[]=[],every=20):{t:number;text:string}[] {
  const out:{t:number;text:string}[]=[];
  let cur:LiveWord[]=[];
  const flush=()=>{if(cur.length)out.push({t:cur[0]!.start,text:cur.map(w=>w.text).join(' ')});cur=[];};
  words.forEach((w,i)=>{
    const prev=words[i-1];
    if(prev&&w.start-prev.end>20){flush();out.push({t:prev.end,text:`(no speech for ${Math.round(w.start-prev.end)} s)`});}
    if(cur.length&&w.start-cur[0]!.start>every)flush();
    cur.push(w);
    if(/[.!?]$/.test(w.text))flush();
  });
  flush();
  return [...out,...hints].sort((a,b)=>a.t-b.t);
}

/** The text a model reads for some candidates: each window with ±15 s of words and its cues. */
export function scanText(cands:Candidate[],words:LiveWord[],pad=15):string {
  return cands.map(c=>{
    const ws=words.filter(w=>w.end>c.start-pad&&w.start<c.end+pad);
    const body=lines(ws).map(l=>`[${hms(l.t)}] ${l.text}`).join('\n')||'(no speech)';
    return `## ${c.id} ${hms(c.start)}-${hms(c.end)}${c.cues.length?` cues: ${c.cues.join(', ')}`:''}\n${c.notes.map(n=>`▲ ${n}`).join('\n')}${c.notes.length?'\n':''}${body}`;
  }).join('\n\n');
}

/** Ratings from the model or the agent, by id; an unknown id is ignored, bounds stay inside the live and 15-90 s. */
export function mergeRatings(cands:Candidate[],ratings:{id:string;rating:number;what?:string;why?:string;start?:number;end?:number}[],duration:number):Candidate[] {
  const by=new Map(ratings.map(r=>[r.id,r]));
  return cands.map(c=>{
    const r=by.get(c.id);
    if(!r)return c;
    let start=r.start??c.start,end=r.end??c.end;
    if(!(end>start)||end-start<MIN_LEN-1e-6||end-start>MAX_LEN+1e-6||start<0||end>duration){start=c.start;end=c.end;}
    return {...c,start,end,rating:Math.max(1,Math.min(10,Math.round(r.rating))),...(r.what?{what:r.what}:{}),...(r.why?{why:r.why}:{})};
  });
}

/** Ranked: rated first by rating, then by local score. */
export function ranked(cands:Candidate[]):Candidate[] {
  return [...cands].sort((a,b)=>(b.rating??0)-(a.rating??0)||b.score-a.score);
}
