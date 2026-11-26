// Graphics stage (plan §4 stage 7): the model picks the few moments a
// picture explains better than a sentence and lists the facts from the
// words; code checks every pick (words in the shot, clear of the creator's
// text and other graphics, within the per-minute cap) and names each render by a hash of
// what it shows, so a replan that lands on the same moment reuses the render.
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {EditDoc,GraphicItem,SourceWord} from '@voxtale/editdoc';
import {promptText} from '../../services/prompts';
import {GRAPHIC_PLAN_PROMPT_ID,GRAPHIC_PLAN_REPAIR_PROMPT_ID} from '../prompts';
import type {Planner,VideoOutput} from '../pipeline';
import {GRAPHIC_KINDS,GRAPHIC_PLACEMENTS,type GraphicRequest} from './make';

/** Shortest and longest graphic on screen, in seconds. */
export const GRAPHIC_MIN=3,GRAPHIC_MAX=8;
const PER_MINUTE={minimal:0.5,normal:1,dense:2} as const;
const CAP=8;

const int=z.number().int().nonnegative();
export const graphicPlanSchema=z.object({items:z.array(z.object({shot:z.string().max(200),startWord:int,endWord:int,kind:z.enum(GRAPHIC_KINDS),
  title:z.string().trim().max(80),facts:z.array(z.object({label:z.string().trim().max(80),value:z.string().trim().max(40)}).strict()).max(12),
  placement:z.enum(GRAPHIC_PLACEMENTS),confidence:z.number().min(0).max(1),reason:z.string().trim().min(1).max(300)}).strict()).max(40)}).strict();
export type GraphicPlan=z.infer<typeof graphicPlanSchema>;
const str={type:'string'};
export const GRAPHIC_PLAN_JSON={type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',items:{type:'object',additionalProperties:false,
  required:['shot','startWord','endWord','kind','title','facts','placement','confidence','reason'],
  properties:{shot:str,startWord:{type:'integer'},endWord:{type:'integer'},kind:{type:'string',enum:[...GRAPHIC_KINDS]},title:str,
    facts:{type:'array',items:{type:'object',additionalProperties:false,required:['label','value'],properties:{label:str,value:str}}},
    placement:{type:'string',enum:[...GRAPHIC_PLACEMENTS]},confidence:{type:'number'},reason:str}}}}};

/** Most graphics for an edit this long at this text density. */
export function graphicCap(seconds:number,density:keyof typeof PER_MINUTE):number {
  const n=Math.floor(seconds/60*PER_MINUTE[density]);
  return Math.min(CAP,density!=='minimal'&&seconds>=20?Math.max(1,n):n);
}

/** Same edit, moment and content → same asset id, so the render is reused. */
export function graphicAssetId(docId:string,r:GraphicRequest):string {
  const key=JSON.stringify([docId,r.kind,r.title,r.facts,r.placement,r.width,r.height,r.fps,r.durationInFrames]);
  return `ga-${createHash('sha256').update(key).digest('hex').slice(0,24)}`;
}

export interface PlannedGraphic {item:GraphicItem;request:GraphicRequest}

/** Graphics plan → items plus the render request behind each. `strict` throws on the first bad item. */
export function graphicItems(doc:EditDoc,plan:GraphicPlan,words:SourceWord[],cap:number,strict:boolean):PlannedGraphic[] {
  const shots=new Map(doc.tracks['a-roll'].filter(i=>i.status!=='suggested').map(i=>[i.id,i]));
  const total=Math.max(0,...[...shots.values()].map(i=>i.end));
  const fps=doc.fps.num/doc.fps.den,snap=(t:number)=>Math.round(t*fps)/fps;
  // Agent callouts give way to a graphic (the text stage drops them); the creator's items never do.
  const textOpen=doc.policy.text!=='off'&&doc.policy.text!=='locked';
  const taken=[...doc.tracks.text.filter(t=>(t.owner==='creator'||!textOpen)&&t.status!=='remove-suggested'),...doc.tracks.graphics.filter(g=>g.owner==='creator')].map(t=>[t.start,t.end] as const);
  const out:PlannedGraphic[]=[];
  // Most sure first, so the cap drops the weakest.
  for(const g of [...plan.items].sort((a,b)=>b.confidence-a.confidence)) {
    if(out.length>=cap)break;
    try {
      const shot=shots.get(g.shot);
      if(!shot)throw new Error(`Unknown shot ${g.shot}`);
      const inShot=(id:number)=>words.find(w=>w.clipId===shot.clipId&&w.id===id&&w.start>=shot.in-0.001&&w.end<=shot.out+0.001);
      const a=inShot(g.startWord),b=inShot(g.endWord);
      if(!a||!b)throw new Error(`Words ${g.startWord}-${g.endWord} are not in shot ${g.shot}`);
      if(b.id<a.id)throw new Error(`endWord ${b.id} comes before startWord ${a.id}`);
      if(!g.facts.length&&!g.title)throw new Error(`Graphic at word ${a.id} has nothing to show`);
      const start=snap(shot.start+(a.start-shot.in));
      const spoken=shot.start+(b.end-shot.in);
      // Half-second steps keep the length (and so the asset id) stable across small retimes.
      const len=Math.min(GRAPHIC_MAX,Math.max(GRAPHIC_MIN,Math.ceil((spoken-start+0.5)*2)/2));
      const end=snap(Math.min(total,start+len));
      if(end-start<GRAPHIC_MIN-1e-6)throw new Error(`Graphic at word ${a.id} has under ${GRAPHIC_MIN}s before the video ends`);
      if([...taken,...out.map(p=>[p.item.start,p.item.end] as const)].some(([s,e])=>s<end-1e-6&&e>start+1e-6))throw new Error(`Graphic at word ${a.id} overlaps the creator's text or another graphic`);
      const anchor=words.filter(w=>w.clipId===shot.clipId&&w.id>=a.id&&w.id<=b.id).map(w=>w.text).join(' ').slice(0,600);
      const request:GraphicRequest={purpose:g.reason,kind:g.kind,title:g.title,facts:g.facts,anchorWords:anchor,placement:g.placement,
        width:doc.canvas.width,height:doc.canvas.height,fps:Math.round(fps*1000)/1000,durationInFrames:Math.round((end-start)*fps)};
      const assetId=graphicAssetId(doc.id,request);
      out.push({request,item:{id:`g-${shot.clipId}-${a.id}`,start,end,owner:'agent',stage:'graphics',status:'applied',assetId,assetRevision:0,placement:g.placement,
        confidence:g.confidence,reason:g.reason,evidence:[{kind:'word',ref:`${shot.clipId}:${a.id}`},{kind:'word',ref:`${shot.clipId}:${b.id}`}]}});
    } catch(error) {if(strict)throw error;}
  }
  return out.sort((x,y)=>x.item.start-y.item.start);
}

export async function planMotionGraphics(doc:EditDoc,words:SourceWord[],planner:Planner,output:VideoOutput):Promise<{graphics:PlannedGraphic[];model?:string}> {
  const style=doc.styleRef.snapshot;
  const live=doc.tracks['a-roll'].filter(i=>i.status!=='suggested');
  const total=Math.max(0,...live.map(i=>i.end));
  const cap=graphicCap(total,style.pace.textDensity);
  const textOpen=doc.policy.text!=='off'&&doc.policy.text!=='locked';
  const shots=live.map(i=>({shot:i.id,at:Math.round(i.start*10)/10,beat:i.evidence?.find(e=>e.kind==='beat')?.ref??'',
    words:words.filter(w=>w.clipId===i.clipId&&w.start>=i.in-0.001&&w.end<=i.out+0.001).map(w=>`${w.id}:${w.text}`).join(' ')})).filter(s=>s.words);
  if(!shots.length||cap<1)return {graphics:[]};
  const input={maxGraphics:cap,beats:doc.brief.beats.map(b=>({id:b.id,title:b.title,content:b.content})),shots,
    textTaken:doc.tracks.text.filter(t=>t.owner==='creator'||!textOpen).map(t=>({start:t.start,end:t.end})),
    callouts:textOpen?doc.tracks.text.filter(t=>t.owner==='agent').map(t=>({start:t.start,end:t.end,text:t.text})):[]};
  let r=await planner(promptText(GRAPHIC_PLAN_PROMPT_ID),input,GRAPHIC_PLAN_JSON);
  await output.write('graphics-response',r);
  try {return {graphics:graphicItems(doc,graphicPlanSchema.parse(r.plan),words,cap,true),model:r.model};}
  catch(error) {
    output.progress?.('Repairing the graphics plan');
    r=await planner(promptText(GRAPHIC_PLAN_PROMPT_ID),{...input,invalidPlan:r.plan,validationError:String(error),repair:promptText(GRAPHIC_PLAN_REPAIR_PROMPT_ID)},GRAPHIC_PLAN_JSON);
    await output.write('graphics-repair-response',r);
    const parsed=graphicPlanSchema.safeParse(r.plan);
    return {graphics:parsed.success?graphicItems(doc,parsed.data,words,cap,false):[],model:r.model};
  }
}
