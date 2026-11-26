// B-roll stage (P4a): code shortlists usable segments from b-roll clips by
// what the speech mentions, the model matches them to moments, and code
// checks every placement (fits the segment, no reuse, no overlap, clear of
// must-stay moments) before it lands as a policy-checked patch.
import {z} from 'zod';
import type {BRollItem,EditDoc,IndexSegment,SourceWord} from '@voxtale/editdoc';
import {promptText} from '../services/prompts';
import {BROLL_PROMPT_ID,BROLL_REPAIR_PROMPT_ID} from './prompts';
import type {Planner,VideoOutput} from './pipeline';
import type {StoryClip} from './story-edit';

/** Shortest and longest b-roll shot, in seconds. */
export const BROLL_MIN=1.5,BROLL_MAX=6;
/** The speaker stays on screen this long at the start. */
export const HOOK_HOLD=2;
const LIBRARY_LIMIT=120;
const B_ROLES=new Set(['b-roll','screen','other']);

export interface BrollSource {ref:string;clipId:string;kind:'video'|'image';screen:boolean;start:number;length:number;seg:IndexSegment}

const tokens=(s:string)=>s.normalize('NFKD').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(t=>t.length>=4)??[];

/** Usable segments of the non-speaking picture clips, best match to the speech first. */
export function brollLibrary(clips:StoryClip[],speakers:Set<string>,words:SourceWord[],limit=LIBRARY_LIMIT):BrollSource[] {
  const said=new Set(words.flatMap(w=>tokens(w.text)));
  const out:(BrollSource&{score:number})[]=[];
  for(const c of clips) {
    if(speakers.has(c.ref.id)||!c.index||c.ref.kind==='audio'||!B_ROLES.has(c.ref.role))continue;
    for(const seg of c.index.segments) {
      if(seg.usable===false||seg.quality.blur||seg.quality.shaky||seg.quality.exposure!=='ok')continue;
      const image=c.ref.kind==='image';
      const length=image?c.ref.duration:Math.min(seg.end,c.ref.duration)-seg.start;
      if(length<BROLL_MIN)continue;
      const about=new Set(tokens([seg.description,seg.action,seg.setting,...seg.subjects,...seg.onScreenText].join(' ')));
      const score=[...about].filter(t=>said.has(t)).length;
      out.push({ref:`${c.ref.id}/${seg.id}`,clipId:c.ref.id,kind:image?'image':'video',screen:c.ref.role==='screen'||seg.shotType==='screen',
        start:image?0:seg.start,length,seg,score});
    }
  }
  return out.sort((a,b)=>b.score-a.score).slice(0,limit).map(({score:_,...s})=>s);
}

const int=z.number().int().nonnegative();
export const brollPlanSchema=z.object({items:z.array(z.object({shot:z.string().max(200),startWord:int,endWord:int,segment:z.string().max(200),
  alternates:z.array(z.string().max(200)).max(3),confidence:z.number().min(0).max(1),reason:z.string().trim().min(1).max(300)}).strict()).max(200)}).strict();
export type BrollPlan=z.infer<typeof brollPlanSchema>;
const str={type:'string'};
export const BROLL_JSON={type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',items:{type:'object',additionalProperties:false,
  required:['shot','startWord','endWord','segment','alternates','confidence','reason'],
  properties:{shot:str,startWord:{type:'integer'},endWord:{type:'integer'},segment:str,alternates:{type:'array',items:str},confidence:{type:'number'},reason:str}}}}};

type Span={start:number;end:number};
const hits=(a:Span,list:Span[])=>list.some(b=>b.start<a.end-1e-6&&b.end>a.start+1e-6);

/** Timeline ranges that must show the speaker: a-roll moments the index marked must-show. */
export function mustStay(doc:EditDoc,clips:StoryClip[]):Span[] {
  const index=new Map(clips.filter(c=>c.index).map(c=>[c.ref.id,c.index!]));
  return doc.tracks['a-roll'].filter(i=>i.status!=='suggested').flatMap(i=>(index.get(i.clipId)?.segments??[])
    .filter(s=>s.mustShow&&s.start<i.out&&s.end>i.in)
    .map(s=>({start:i.start+Math.max(0,s.start-i.in),end:i.start+Math.min(i.out,s.end)-i.in})));
}

/** B-roll plan → items on the output timeline. `strict` throws on the first bad item; otherwise bad items are skipped. */
export function brollItems(doc:EditDoc,plan:BrollPlan,words:SourceWord[],library:BrollSource[],stay:Span[],strict:boolean):BRollItem[] {
  const shots=new Map(doc.tracks['a-roll'].filter(i=>i.status!=='suggested').map(i=>[i.id,i]));
  const total=Math.max(0,...[...shots.values()].map(i=>i.end));
  const lib=new Map(library.map(s=>[s.ref,s]));
  const creator=doc.tracks['b-roll'].filter(b=>b.owner==='creator');
  const fps=doc.fps.num/doc.fps.den,snap=(t:number)=>Math.round(t*fps)/fps;
  const used:{clipId:string;in:number;out:number}[]=creator.map(b=>({clipId:b.clipId,in:b.in,out:b.out}));
  const reused=(clipId:string,a:number,b:number)=>used.some(u=>u.clipId===clipId&&u.in<b-1e-6&&u.out>a+1e-6);
  // A still image can be held from its start; a video segment plays its middle.
  const range=(s:BrollSource,len:number)=>{const i=snap(s.kind==='image'?0:s.start+Math.max(0,(s.length-len)/2));return {in:i,out:i+len};};
  const out:(BRollItem&{alts:string[]})[]=[];
  for(const g of plan.items) {
    try {
      const shot=shots.get(g.shot);
      if(!shot)throw new Error(`Unknown shot ${g.shot}`);
      const inShot=(id:number)=>words.find(w=>w.clipId===shot.clipId&&w.id===id&&w.start>=shot.in-0.001&&w.end<=shot.out+0.001);
      const a=inShot(g.startWord),b=inShot(g.endWord);
      if(!a||!b)throw new Error(`Words ${g.startWord}-${g.endWord} are not in shot ${g.shot}`);
      if(b.id<a.id)throw new Error(`endWord ${b.id} comes before startWord ${a.id}`);
      const src=lib.get(g.segment);
      if(!src)throw new Error(`Segment ${g.segment} is not in the library`);
      const start=snap(shot.start+(a.start-shot.in));
      if(start<HOOK_HOLD)throw new Error(`B-roll at word ${a.id} covers the speaker in the first ${HOOK_HOLD} seconds`);
      const want=Math.min(BROLL_MAX,Math.max(2,shot.start+(b.end-shot.in)-start),src.length,total-start);
      const end=snap(start+want),len=end-start;
      if(len<BROLL_MIN)throw new Error(`Segment ${g.segment} or the time left is too short for word ${a.id} (${len.toFixed(1)}s)`);
      const span={start,end};
      if(hits(span,stay))throw new Error(`B-roll at word ${a.id} covers a moment that must show the speaker`);
      if(hits(span,[...creator,...out]))throw new Error(`B-roll at word ${a.id} overlaps other b-roll`);
      const r=range(src,len);
      if(reused(src.clipId,r.in,r.out))throw new Error(`Segment ${g.segment} is already used`);
      used.push({clipId:src.clipId,...r});
      out.push({id:`b-${shot.clipId}-${a.id}`,start,end,owner:'agent',stage:'b-roll',status:'applied',clipId:src.clipId,...r,
        fit:src.screen?'contain':'cover',muted:true,opacity:1,confidence:g.confidence,reason:g.reason,alts:g.alternates,
        evidence:[{kind:'word',ref:`${shot.clipId}:${a.id}`},{kind:'word',ref:`${shot.clipId}:${b.id}`},{kind:'segment',ref:g.segment}]});
    } catch(error) {if(strict)throw error;}
  }
  // Alternates come last so they never take a segment a placed shot uses.
  return out.map(({alts,...item})=>{
    const len=item.end-item.start;
    const alternatives=[...new Set(alts)].flatMap(ref=>{
      const s=lib.get(ref);
      if(!s||ref===item.evidence?.[2]?.ref||s.length<len-1e-6)return [];
      const r=range(s,len);
      return reused(s.clipId,r.in,r.out)?[]:[{clipId:s.clipId,...r,reason:s.seg.description.slice(0,300)}];
    }).slice(0,3);
    return alternatives.length?{...item,alternatives}:item;
  });
}

/** Keep the surest shots until the coverage the style asks for (with some slack) is reached. */
export function capCoverage(items:BRollItem[],coverage:number,duration:number):BRollItem[] {
  const room=coverage*duration*1.5+1;
  let spent=0;
  const kept=new Set<string>();
  for(const i of [...items].sort((a,b)=>(b.confidence??1)-(a.confidence??1))) {
    if(spent+(i.end-i.start)>room)continue;
    spent+=i.end-i.start;kept.add(i.id);
  }
  return items.filter(i=>kept.has(i.id));
}

export async function planBroll(doc:EditDoc,clips:StoryClip[],speakers:Set<string>,words:SourceWord[],planner:Planner,output:VideoOutput):Promise<{items:BRollItem[];model?:string;library:number}> {
  const style=doc.styleRef.snapshot;
  const library=brollLibrary(clips,speakers,words);
  const aroll=doc.tracks['a-roll'].filter(i=>i.status!=='suggested');
  const duration=Math.max(0,...aroll.map(i=>i.end));
  if(!library.length||style.pace.brollCoverage<=0||duration<=HOOK_HOLD)return {items:[],library:library.length};
  const shots=aroll.map(i=>({shot:i.id,at:Math.round(i.start*10)/10,
    beat:i.evidence?.find(e=>e.kind==='beat')?.ref??'',
    words:words.filter(w=>w.clipId===i.clipId&&w.start>=i.in-0.001&&w.end<=i.out+0.001).map(w=>`${w.id}:${w.text}`).join(' ')})).filter(s=>s.words);
  if(!shots.length)return {items:[],library:library.length};
  const stay=mustStay(doc,clips);
  const round=(s:Span)=>({start:Math.round(s.start*10)/10,end:Math.round(s.end*10)/10});
  const input={coverage:style.pace.brollCoverage,duration:Math.round(duration),
    beats:doc.brief.beats.map(b=>({id:b.id,title:b.title,content:b.content})),shots,
    library:library.map(s=>({id:s.ref,seconds:s.kind==='image'?null:Math.round(s.length*10)/10,shows:s.seg.description,
      ...(s.seg.onScreenText.length?{text:s.seg.onScreenText}:{}),shot:s.seg.shotType})),
    mustStay:[{start:0,end:HOOK_HOLD},...stay].map(round),
    creatorBroll:doc.tracks['b-roll'].filter(b=>b.owner==='creator').map(round)};
  let r=await planner(promptText(BROLL_PROMPT_ID),input,BROLL_JSON);
  await output.write('broll-response',r);
  let items:BRollItem[];
  try {items=brollItems(doc,brollPlanSchema.parse(r.plan),words,library,stay,true);}
  catch(error) {
    output.progress?.('Repairing b-roll');
    r=await planner(promptText(BROLL_PROMPT_ID),{...input,invalidPlan:r.plan,validationError:String(error),repair:promptText(BROLL_REPAIR_PROMPT_ID)},BROLL_JSON);
    await output.write('broll-repair-response',r);
    const parsed=brollPlanSchema.safeParse(r.plan);
    items=parsed.success?brollItems(doc,parsed.data,words,library,stay,false):[];
  }
  return {items:capCoverage(items,style.pace.brollCoverage,duration),model:r.model,library:library.length};
}
