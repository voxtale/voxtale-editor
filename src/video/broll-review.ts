// B-roll review (P4d): one batched vision call looks at a still of every new
// b-roll shot and its alternatives beside the words it covers, and asks an
// absolute question per shot: major defect or not. A shot with a defect
// swaps to its first clean alternative, or drops below the apply bar so it
// lands as a suggestion. Taste is never judged here.
import {z} from 'zod';
import type {BRollItem,ClipIndex,EditDoc,SourceWord} from '@voxtale/editdoc';
import {promptText} from '../services/prompts';
import type {VisionModel,VisionPart} from './footage-index';
import {BROLL_REVIEW_PROMPT_ID} from './prompts';

/** Most stills sent in one review call. */
export const REVIEW_LIMIT=40;

export interface BrollLook {
  vision:VisionModel;
  /** JPEG of still `i` of a segment of a clip, as the index stored it. */
  still(clipId:string,segmentId:string,i:number):Promise<Uint8Array>;
}

const verdictSchema=z.object({items:z.array(z.object({n:z.number().int(),defect:z.boolean(),
  kind:z.enum(['broken','unrelated','talking','branded','none']).catch('none'),note:z.string().catch('').transform(s=>s.slice(0,200))}).passthrough())}).passthrough();

const segmentAt=(index:ClipIndex|undefined,t:number)=>index?.segments.find(s=>s.start<=t+1e-6&&s.end>t)??index?.segments[0];

/** Reason with the review's note kept whole inside the 300-character limit. */
const withNote=(base:string|undefined,note:string)=>{const tail=` (${note.slice(0,200)})`;return `${(base??'').slice(0,300-tail.length)}${tail}`.trim();};

export interface BrollReview {items:BRollItem[];swapped:number;demoted:number;model?:string;costUsd?:number}

/** Review `fresh` agent b-roll; other items pass through untouched. */
export async function reviewBroll(doc:EditDoc,items:BRollItem[],fresh:Set<string>,words:SourceWord[],indexes:Map<string,ClipIndex>,look:BrollLook):Promise<BrollReview> {
  const shots=new Map(doc.tracks['a-roll'].filter(i=>i.status!=='suggested').map(i=>[i.id,i]));
  const spoken=(item:BRollItem)=>{
    // Words heard on the timeline while the b-roll shows.
    const out:string[]=[];
    for(const s of shots.values()) {
      if(s.end<=item.start||s.start>=item.end)continue;
      const from=s.in+Math.max(0,item.start-s.start),to=s.in+Math.min(s.end,item.end)-s.start;
      out.push(...words.filter(w=>w.clipId===s.clipId&&w.start>=from-0.05&&w.end<=to+0.05).map(w=>w.text));
    }
    return out.join(' ').slice(0,400);
  };
  type Cand={item:string;alt:number;clipId:string;segment:string};
  const cands:Cand[]=[];
  for(const item of items) {
    if(!fresh.has(item.id)||cands.length>=REVIEW_LIMIT)continue;
    const options=[{clipId:item.clipId,in:item.in},...(item.alternatives??[])];
    options.forEach((o,alt)=>{
      const seg=segmentAt(indexes.get(o.clipId),o.in);
      if(seg&&cands.length<REVIEW_LIMIT)cands.push({item:item.id,alt,clipId:o.clipId,segment:seg.id});
    });
  }
  if(!cands.length)return {items,swapped:0,demoted:0};
  const parts:VisionPart[]=[];
  const said=new Map(items.map(i=>[i.id,spoken(i)]));
  for(const [n,c] of cands.entries()) {
    parts.push({type:'text',text:`Candidate ${n}. Words: "${said.get(c.item)}"`});
    parts.push({type:'image',jpeg:await look.still(c.clipId,c.segment,0)});
  }
  const r=await look.vision(promptText(BROLL_REVIEW_PROMPT_ID),parts);
  const verdicts=verdictSchema.parse(r.json).items;
  const bad=new Map<number,{kind:string;note:string}>();
  for(const v of verdicts)if(v.defect&&v.kind!=='none'&&v.n>=0&&v.n<cands.length)bad.set(v.n,{kind:v.kind,note:v.note});
  const verdictOf=(id:string,alt:number)=>{const n=cands.findIndex(c=>c.item===id&&c.alt===alt);return n<0?undefined:{n,bad:bad.get(n)};};
  const bar=doc.styleRef.snapshot.applyConfidence;
  let swapped=0,demoted=0;
  const out=items.map(item=>{
    const main=verdictOf(item.id,0);
    if(!main?.bad)return item;
    const why=`${main.bad.kind}${main.bad.note?`: ${main.bad.note}`:''}`;
    // Only an alternative the review saw and passed replaces the shot.
    const k=(item.alternatives??[]).findIndex((_,i)=>{const v=verdictOf(item.id,i+1);return v&&!v.bad;});
    if(k>=0) {
      const alt=item.alternatives![k]!;
      const seg=cands[verdictOf(item.id,k+1)!.n]!.segment;
      swapped++;
      const rest=item.alternatives!.filter((_,i)=>i!==k&&!verdictOf(item.id,i+1)?.bad);
      const {alternatives:_,...base}=item;
      return {...base,clipId:alt.clipId,in:alt.in,out:alt.out,
        reason:withNote(alt.reason??item.reason,`first pick swapped out: ${why}`),
        evidence:(item.evidence??[]).map(e=>e.kind==='segment'?{...e,ref:`${alt.clipId}/${seg}`}:e),
        ...(rest.length?{alternatives:rest}:{})};
    }
    demoted++;
    return {...item,confidence:Math.min(item.confidence??1,Math.max(0,bar-0.01)),reason:withNote(item.reason,`review: ${why}`)};
  });
  return {items:out,swapped,demoted,model:r.model,...(r.costUsd!==undefined?{costUsd:r.costUsd}:{})};
}
