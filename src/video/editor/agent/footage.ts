// What each clip shows, as compact lines the agent can search: its moments
// (every visible change, described) when the clip has them, else its footage
// index (shot segments labelled by the vision model at ingest).
import type {Job,JobClip} from './cut';

const sec=(x:number)=>x.toFixed(1);

export interface FootageQuery {query?:string;start?:number;end?:number}

/** Words that say nothing about what a picture shows. */
const STOP=new Set('the and for that this with you your are was were have has had not but they them their there here what when where which who how why can could would should will just like really very about into over from then than also been being its our out all any some more most much many one two get got going gonna thing things kind sort lot yeah okay right well actually basically because so'.split(' '));
/** A word cut back to its stem, roughly: plural and verb endings off. */
export const stem=(w:string)=>w.length>3?w.replace(/(ing|ed|es|s|e)$/,'').replace(/(.)\1$/,'$1'):w;
/** The words of a text that could name what is on screen. */
export const terms=(text:string):string[]=>[...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>2&&!STOP.has(w)).map(stem))];

export interface FootageHit {clip:string;id:string;start:number;end:number;score:number;line:string;shared:string[]}

/**
 * Footage ranked against some words (a query, or what the speaker says over a
 * stretch). A shared word counts for more the fewer entries hold it: "chart"
 * in two moments out of ninety says more than "screen" in sixty. Score is the
 * share of the query's weight an entry covers, 0-1.
 */
export function rankFootage(clips:JobClip[],text:string):FootageHit[] {
  const want=terms(text);
  const entries=clips.flatMap(c=>c.moments?.moments.length
    ?c.moments.moments.map(m=>({clip:c.ref.id,id:m.id,start:m.start,end:m.end,line:m.description,hay:terms([m.description,m.changed,...m.subjects,...m.onScreenText].join(' '))}))
    :(c.index?.segments??[]).filter(s=>s.usable!==false).map(s=>({clip:c.ref.id,id:s.id,start:s.start,end:s.end,line:s.description,hay:terms([s.description,s.action,s.setting,...s.subjects,...s.onScreenText].join(' '))})));
  if(!want.length||!entries.length)return [];
  const df=new Map<string,number>();
  for(const e of entries)for(const t of e.hay)df.set(t,(df.get(t)??0)+1);
  // A query word no entry holds still weighs in: footage that misses it covers less of what was asked.
  const idf=(t:string)=>Math.log(1+entries.length/(1+(df.get(t)??0)));
  const total=want.reduce((s,t)=>s+idf(t),0);
  return entries.map(e=>{
    const have=new Set(e.hay),shared=want.filter(t=>have.has(t));
    return {clip:e.clip,id:e.id,start:e.start,end:e.end,line:e.line,shared,score:Math.round(shared.reduce((s,t)=>s+idf(t),0)/total*100)/100};
  }).filter(h=>h.score>0).sort((a,b)=>b.score-a.score||a.start-b.start);
}

/** Most ranked hits listed; the rest are counted. */
const RANK_SHOWN=12;
/** Under this share of the words covered, a match is chance: one common word. */
const RANK_MIN=0.15;
export function rankText(hits:FootageHit[],asked:string):string {
  hits=hits.filter(h=>h.score>=RANK_MIN);
  if(!hits.length)return `no footage covers much of "${asked.slice(0,80)}" by its words. Read find_footage without a query, or look with timeline_view.`;
  return [`best matches for "${asked.slice(0,80)}" (score = share of those words the entry covers; a word match is a lead, confirm with timeline_view):`,
    ...hits.slice(0,RANK_SHOWN).map(h=>`  ${h.score.toFixed(2)} ${h.clip} ${h.id} ${sec(h.start)}-${sec(h.end)}s: ${h.line.slice(0,160)} (shares: ${h.shared.join(', ')})`),
    ...(hits.length>RANK_SHOWN?[`  and ${hits.length-RANK_SHOWN} weaker matches`]:[])].join('\n');
}

interface Shown {start:number;end:number;clipId:string}
interface Kept {start:number;end:number;in:number;clipId:string}

/**
 * What a clip recorded with the speaker did while the kept words were said:
 * every change on it that falls under kept speech, at its second of the cut,
 * with the word being said and whether the cut is showing that clip then.
 * These are the points to cut to the screen: the picture changes as the
 * speaker talks about it.
 */
export function screenActivity(job:Job,doc:{tracks:{'a-roll':Kept[];'b-roll':Shown[]}}):string {
  const out=screenChanges(job,doc).flatMap(c=>[
    `${c.clip} "${c.name}" (same clock as ${c.with}): ${c.under} changes under kept speech, ${c.shown} of them on screen in the cut`,
    ...c.lines,...(c.still.length?[`  shots where nothing on it changes (a still picture: shorten, or crop in on what is being talked about): ${c.still.join(', ')}`]:[])]);
  return out.join('\n')||'no clip here was recorded with the speaker and described change by change';
}

/** One line for the cut report per synced clip, pointing at screen_activity. */
export const screenSummary=(job:Job,doc:{tracks:{'a-roll':Kept[];'b-roll':Shown[]}}):string[]=>
  screenChanges(job,doc).filter(c=>c.under).map(c=>`${c.clip}: ${c.under} changes on it while kept words are said, ${c.shown} shown`);

/** The model's own word that the picture held: "None", "remains…", "unchanged". Not a change to cut on. */
export const held=(m:{changed:string})=>!m.changed.trim()||/^(none|no (visible |notable )?changes?)\b|\b(remains?|unchanged|unaltered|without (alterations?|changes?)|continues to (be|show|display))\b/i.test(m.changed.trim());

function screenChanges(job:Job,doc:{tracks:{'a-roll':Kept[];'b-roll':Shown[]}}) {
  const out:{clip:string;name:string;with:string;under:number;shown:number;lines:string[];still:string[]}[]=[];
  for(const s of job.sync??[]) {
    const c=job.clips.find(x=>x.ref.id===s.clip),voice=job.clips.find(x=>x.ref.id===s.with);
    const ms=c?.moments?.moments;
    if(!c||!voice||!ms?.length)continue;
    const lines:string[]=[];
    let shown=0,under=0;
    for(const a of doc.tracks['a-roll'].filter(x=>x.clipId===s.with)) {
      const len=a.end-a.start;
      // The first moment is the clip's opening picture, not a change.
      for(const m of ms.slice(1)) {
        if(held(m))continue;
        const src=m.start-s.offset;
        if(src<a.in||src>=a.in+len)continue;
        const t=a.start+(src-a.in),word=voice.words.filter(w=>w.start<=src+0.25).at(-1);
        const on=doc.tracks['b-roll'].some(b=>b.clipId===c.ref.id&&b.start<=t+0.05&&t<b.end);
        under++;if(on)shown++;
        lines.push(`  @${sec(t)}s${word?` word ${word.id} "${word.text}"`:''} ${m.id}: ${m.changed.slice(0,140)}${on?'':' | not shown'}`);
      }
    }
    // Shots of this clip that sit on one unchanging picture.
    const still:string[]=[];
    for(const b of doc.tracks['b-roll'].filter(x=>x.clipId===c.ref.id)) {
      const a=doc.tracks['a-roll'].find(x=>x.clipId===s.with&&x.start<=b.start+0.05&&b.start<x.end);
      if(!a)continue;
      const from=a.in+(b.start-a.start)+s.offset,to=from+(b.end-b.start);
      if(!ms.some(m=>!held(m)&&m.start>from&&m.start<to)&&b.end-b.start>=STILL_MIN)still.push(`${sec(b.start)}-${sec(b.end)}s`);
    }
    out.push({clip:c.ref.id,name:c.ref.name,with:s.with,under,shown,lines,still});
  }
  return out;
}

/** What a clip recorded with `speaker` showed while source seconds [start,end] of the speaker ran. */
export function shownMeanwhile(job:Job,speaker:string,start:number,end:number):string[] {
  return (job.sync??[]).filter(s=>s.with===speaker).flatMap(s=>{
    const c=job.clips.find(x=>x.ref.id===s.clip);
    const ms=(c?.moments?.moments??[]).filter(m=>m.end>start+s.offset&&m.start<end+s.offset);
    return ms.length?[`on ${s.clip} while these words were said (same clock; show it with sync:true):`,...ms.map(m=>`  ${m.id} ${sec(m.start)}-${sec(m.end)}s: ${m.description.slice(0,160)}`)]:[];
  });
}
/** A shot of a synced clip this long with no change in it is called out. */
const STILL_MIN=6;

/** The clips as compact lines; `query` keeps entries sharing a word with it, `start`/`end` a window of source seconds. */
export function footageText(clips:JobClip[],q:FootageQuery={},job?:Job):string {
  const want=(q.query??'').toLowerCase().split(/\W+/).filter(w=>w.length>2);
  const keep=(hay:string,start:number,end:number)=>(q.start===undefined||end>q.start)&&(q.end===undefined||start<q.end)
    &&(!want.length||want.some(t=>hay.toLowerCase().includes(t)));
  const out:string[]=[];
  for(const c of clips) {
    const sync=job?.sync?.find(x=>x.clip===c.ref.id);
    const head=`${c.ref.id} "${c.ref.name}" ${c.ref.role}, ${sec(c.ref.duration)}s`
      +(sync?` (recorded with ${sync.with}: same clock${sync.offset?`, offset ${sec(sync.offset)}s`:''})`:'');
    if(c.moments?.moments.length) {
      const ms=c.moments.moments.filter(m=>keep([m.description,m.changed,...m.subjects,...m.onScreenText].join(' '),m.start,m.end));
      if(!ms.length)continue;
      out.push(`${head}: ${c.moments.moments.length} moments`);
      for(const m of ms)out.push(`  ${m.id} ${sec(m.start)}-${sec(m.end)}s: ${m.description}`
        +(m.changed?` | changed: ${m.changed}`:'')+(m.onScreenText.length?` | text: "${m.onScreenText.join(' / ')}"`:'')
        +(m.subjects.length?` [${m.subjects.join(', ')}]`:''));
      continue;
    }
    const ix=c.index;
    if(!ix){if(c.ref.kind==='video')out.push(`${head}: no index`);continue;}
    const segs=ix.segments.filter(s=>keep([s.description,s.action,s.setting,...s.subjects,...s.onScreenText,s.words??''].join(' '),s.start,s.end));
    if(!segs.length)continue;
    out.push(`${head}: ${ix.summary}`);
    for(const s of segs) {
      const qual=[s.quality.blur&&'blurry',s.quality.shaky&&'shaky',s.quality.exposure!=='ok'&&s.quality.exposure,s.usable===false&&'UNUSABLE'].filter(Boolean);
      out.push(`  ${s.id} ${sec(s.start)}-${sec(s.end)}s ${s.shotType}: ${s.description}`
        +(s.subjects.length?` [${s.subjects.join(', ')}]`:'')+(s.onScreenText.length?` text: "${s.onScreenText.join(' / ')}"`:'')
        +(qual.length?` (${qual.join(', ')})`:''));
    }
  }
  return out.join('\n')||(want.length?`nothing matches "${q.query}"`:'no indexed clips');
}
