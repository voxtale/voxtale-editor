// Timed creator notes: "here, cut this", left on the last version at a rough
// output second (a click on the timeline lands anywhere near the words). Code
// moves each note to the nearest word edge of the speech under it, never into
// a word, and ties it to that word's id, so it still points at the same words
// after the agent recuts. The agent answers each note in one line at finish.
// Pure: no I/O.
import {type EditDoc} from '@voxtale/editdoc';

export interface CreatorNote {id:string;at:number;text:string}

export interface PlacedNote extends CreatorNote {
  /** Output second of the last version, on a word edge (or `at` when no speech is near). */
  t:number;
  /** The word the note points at: the one it sits on or before, by clip and word id. */
  clip?:string;
  word?:number;
  /** Words heard around the note, a few before and after. */
  said:string;
  /** No speech within NOTE_REACH: the note stays at its own time. */
  far?:boolean;
}

/** Furthest a note moves to reach speech, seconds. A click lands within a second or two of what it means. */
export const NOTE_REACH=3;
/** Words shown around a note. */
const BEFORE=3,AFTER=5;
/** Longest reply line kept. */
export const REPLY_MAX=200;

type Word={id:number;text:string;start:number;end:number};

/** The creator's own notes on a version: markers of kind note, owned by the creator, shown. */
export function creatorNotes(doc:EditDoc|undefined):CreatorNote[] {
  return (doc?.markers??[]).filter(m=>m.kind==='note'&&m.owner==='creator'&&m.status!=='suggested').map(m=>({id:m.id,at:m.time,text:m.title}));
}

/** Words heard in `doc`, in output seconds, in order. */
function heardWords(doc:EditDoc,wordsOf:(clipId:string)=>Word[]):(Word&{clip:string})[] {
  const out:(Word&{clip:string})[]=[];
  for(const i of doc.tracks['a-roll']) {
    if(i.status==='suggested')continue;
    const speed=(i.out-i.in)/Math.max(1e-6,i.end-i.start);
    // By midpoint, as captions do: in/out sit on frames, a few ms either side of a word edge.
    for(const w of wordsOf(i.clipId))if((w.start+w.end)/2>=i.in&&(w.start+w.end)/2<=i.out)
      out.push({...w,clip:i.clipId,start:i.start+(Math.max(w.start,i.in)-i.in)/speed,end:i.start+(Math.min(w.end,i.out)-i.in)/speed});
  }
  return out.sort((a,b)=>a.start-b.start);
}

/**
 * Move a note to the speech under it. Inside a word: to that word's start.
 * In a pause: to the nearer edge, the end of the word before or the start of
 * the word after. Further than NOTE_REACH from any word: left where it is.
 */
export function placeNote(doc:EditDoc,wordsOf:(clipId:string)=>Word[],n:CreatorNote):PlacedNote {
  const ws=heardWords(doc,wordsOf);
  const r2=(x:number)=>Math.round(x*100)/100;
  const around=(k:number,after:boolean)=>{
    const a=after?k+1:k;
    return [...ws.slice(Math.max(0,a-BEFORE),a).map(w=>w.text),'|',...ws.slice(a,a+AFTER).map(w=>w.text)].join(' ');
  };
  const inside=ws.findIndex(w=>w.start<=n.at&&n.at<w.end);
  if(inside>=0){const w=ws[inside]!;return {...n,t:r2(w.start),clip:w.clip,word:w.id,said:around(inside,false)};}
  let best:{k:number;edge:'start'|'end';d:number}|undefined;
  for(const [k,w] of ws.entries()) {
    for(const edge of ['start','end'] as const) {
      const d=Math.abs(w[edge]-n.at);
      if(d<=NOTE_REACH&&(!best||d<best.d))best={k,edge,d};
    }
  }
  if(!best)return {...n,t:n.at,said:'',far:true};
  const w=ws[best.k]!;
  // After a word's end, the note points at the next word (the line it comes before); else at this one.
  const at=best.edge==='end'?ws[best.k+1]??w:w;
  return {...n,t:r2(w[best.edge]),clip:at.clip,word:at.id,said:around(best.k,best.edge==='end')};
}

export const placeNotes=(doc:EditDoc,wordsOf:(clipId:string)=>Word[],notes:CreatorNote[])=>notes.map(n=>placeNote(doc,wordsOf,n));

/** The notes for the task prompt: one line each, with where code put it. */
export function notesBrief(notes:PlacedNote[]):string {
  if(!notes.length)return '';
  return [`Creator notes on the last version (${notes.length}). Times are rough: code moved each to the nearest word edge, never into a word; the word id follows the words through your recut. Do what each asks, then answer each in finish notes, one line per note:`,
    ...notes.map(n=>`- ${n.id} @${n.t.toFixed(1)}s${n.far?' (no speech near: a picture or music moment)':` at ${n.clip}:${n.word}, "${n.said}"`}${Math.abs(n.t-n.at)>=0.05?` (left at ${n.at.toFixed(1)}s)`:''}: ${n.text}`)].join('\n');
}

export interface NoteReply {id:string;reply:string}

/** Replies as one clean line each; ids not among the notes are dropped. Missing: the note ids with no reply. */
export function noteReplies(notes:CreatorNote[],replies:NoteReply[]|undefined):{replies:NoteReply[];missing:string[]} {
  const ids=new Set(notes.map(n=>n.id)),seen=new Map<string,string>();
  for(const r of replies??[]) {
    const line=r.reply.replace(/\s+/g,' ').trim().slice(0,REPLY_MAX);
    if(ids.has(r.id)&&line&&!seen.has(r.id))seen.set(r.id,line);
  }
  return {replies:notes.filter(n=>seen.has(n.id)).map(n=>({id:n.id,reply:seen.get(n.id)!})),missing:notes.filter(n=>!seen.has(n.id)).map(n=>n.id)};
}
