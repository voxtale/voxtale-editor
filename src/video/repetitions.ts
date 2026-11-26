import type {Transcript} from './transcript-model';
export interface RepetitionCandidate {
  first: [number, number]; second: [number, number]; text: string;
}
const normalize=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}']/gu,'');
/** Evidence only. A language model decides whether a repeat is a retake or intentional. */
export function repetitionCandidates(words:Transcript['words']):RepetitionCandidate[] {
  const tokens=words.map(w=>normalize(w.text));
  const results:RepetitionCandidate[]=[];
  for(let i=0;i<words.length;i++) {
    for(let j=i+1;j<words.length&&j<=i+100;j++) {
      if(!tokens[i]||tokens[i]!==tokens[j])continue;
      let length=0;
      while(i+length<j&&j+length<words.length&&tokens[i+length]===tokens[j+length]&&
        words[i+length]!.id===words[i]!.id+length&&words[j+length]!.id===words[j]!.id+length)length++;
      if(length<2&&j!==i+1)continue;
      if(results.some(r=>r.first[0]<=words[i]!.id&&r.first[1]>=words[i+length-1]!.id&&r.second[0]<=words[j]!.id&&r.second[1]>=words[j+length-1]!.id))continue;
      results.push({first:[words[i]!.id,words[i+length-1]!.id],second:[words[j]!.id,words[j+length-1]!.id],text:words.slice(i,i+length).map(w=>w.text).join(' ')});
    }
  }
  return results;
}

/** Resolve a model-confirmed single connector restart using timing and grammar.
 * Never promotes adjective/adverb emphasis (very very, so so good), valid verb
 * repetition (had had), or a whole phrase. Provider scores remain in raw artifacts.
 */
export function confirmConnectorRestarts<T extends {removals:import('./planner').TakePlan['removals']}>(plan:T,t:Transcript):T {
  return {...plan,removals:plan.removals.map(r=>{
    if(r.startWord!==r.endWord||r.keptStartWord!==r.startWord+1||r.keptEndWord!==r.keptStartWord||r.kind==='setup')return r;
    const a=t.words[r.startWord],b=t.words[r.keptStartWord],next=t.words[r.keptEndWord+1];
    if(!a||!b||normalize(a.text)!==normalize(b.text)||b.start-a.end<0.15||b.start-a.end>6)return r;
    const token=normalize(a.text);
    const connector=['for','and','but','or','the','a','an','to','of'].includes(token)||
      (token==='so'&&next&&['i','we','you','he','she','they','it'].includes(normalize(next.text)));
    if(!connector)return r;
    return {...r,confidence:1,reason:`Confirmed adjacent connector restart (${(b.start-a.end).toFixed(2)}s gap; model score ${r.confidence}). ${r.reason.slice(0,480)}`};
  })};
}

/** Keep a lead-in when a model includes it in a repeated clause's removal.
 * Only moves the cut forward, never deletes additional speech.
 */
export function preserveRestartLeadIns<T extends {removals:import('./planner').TakePlan['removals']}>(plan:T,t:Transcript):T {
  return {...plan,removals:plan.removals.map(r=>{
    if(r.keptStartWord===null||r.keptEndWord===null||r.keptEndWord<=r.keptStartWord)return r;
    const a=t.words[r.keptStartWord],b=t.words[r.keptStartWord+1];
    if(!a||!b)return r;
    for(let i=r.startWord;i<r.endWord;i++) {
      if(normalize(t.words[i]?.text??'')===normalize(a.text)&&normalize(t.words[i+1]?.text??'')===normalize(b.text)) {
        return {...r,startWord:i};
      }
    }
    return r;
  })};
}

/** A later recap is not evidence that an earlier setup is disposable.
 * Distant alternatives remain visible for review, even with a high model score.
 */
export function protectDistantRecaps<T extends {removals:import('./planner').TakePlan['removals']}>(plan:T,t:Transcript):T {
  return {...plan,removals:plan.removals.map(r=>{
    if(r.keptStartWord===null||r.keptEndWord===null||r.kind==='setup')return r;
    const intervening=r.keptStartWord>r.endWord?r.keptStartWord-r.endWord-1:r.startWord-r.keptEndWord-1;
    if(intervening<=8)return r;
    return {...r,confidence:0,reason:`Review only: ${intervening} words separate this passage from its replacement; it may be a recap, not a restart. ${r.reason.slice(0,430)}`};
  })};
}
