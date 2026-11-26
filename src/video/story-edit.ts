// Multi-clip agent edit (P3/P4): fine takes inside each a-roll clip, then the
// structure stage orders passages from every clip into beats and drops
// retakes across clips, assembly lays them out by code, the b-roll stage
// covers moments with matching footage, and the text stage adds captions and
// restrained on-screen text. Each stage lands as a
// policy-checked patch, so creator items survive a replan.
import {z} from 'zod';
import {
  STYLE_PRESETS,applyStagePatch,buildCaptions,newEditDoc,packSequence,parseEditDoc,stagePatchBetween,
  type ClipIndex,type ClipRef,type EditDoc,type EditStyle,type Fps,type SourceWord,type StageName,type StagePatch,type TextItem,
  repeatsDeclined,
} from '@voxtale/editdoc';
import {promptStamp,promptText} from '../services/prompts';
import {GRAPHIC_PLAN_PROMPT_ID,GRAPHIC_PLAN_REPAIR_PROMPT_ID,BROLL_PROMPT_ID,BROLL_REPAIR_PROMPT_ID,BROLL_REVIEW_PROMPT_ID,STRUCTURE_PROMPT_ID,STRUCTURE_LENGTH_PROMPT_ID,STRUCTURE_REPAIR_PROMPT_ID,TEXT_PROMPT_ID,TEXT_REPAIR_PROMPT_ID,TAKE_PROMPT_ID,AUDIT_PROMPT_ID,TAKE_REPAIR_PROMPT_ID,AUDIT_REPAIR_PROMPT_ID} from './prompts';
import {planTakes,type Planner,type VideoOutput} from './pipeline';
import {editForClip} from './first-edit';
import {planBroll} from './broll';
import {reviewBroll,type BrollLook} from './broll-review';
import {planZoom} from './zoom';
import {planAudio} from './audio';
import {planMotionGraphics} from './graphics/plan';
import type {GraphicRequest} from './graphics/make';
import type {Transcript} from './transcript-model';
import {
  STRUCTURE_JSON,assembleStory,buildPassages,checkStructure,passageSeconds,passageText,
  type AssembleOptions,type ClipSpeech,type SpeechWord,type StructurePlan,
} from './story';

export interface StoryClip {ref:ClipRef;transcript?:Transcript;index?:ClipIndex}
export interface StoryEditInput {
  id:string;
  name:string;
  clips:StoryClip[];
  instruction?:string;
  targetDuration?:number;
  outline?:AssembleOptions['outline'];
  style?:EditStyle;
  /** The latest revision when replanning; its creator items are kept. */
  previous?:EditDoc;
  /** Revision number the result carries (the cloud's counter). */
  revision?:number;
  planner:Planner;
  /** Vision check of placed b-roll; without it shots land unchecked. */
  look?:BrollLook;
  /** Plan generated graphics (stage 7). Only where a render box will make them. */
  graphics?:boolean;
  output:VideoOutput;
  now?:()=>Date;
}
export interface StoryEditResult {
  doc:EditDoc;
  notes:string[];
  /** Render request behind every agent graphic in the doc, by asset id. */
  graphics:Map<string,GraphicRequest>;
}

export const MAX_STORY_WORDS=20000;
/** A cut within 15% of the target length passes; past that the plan is asked again, at most twice. */
const LENGTH_SLACK=0.15,LENGTH_ROUNDS=2;
const TAKE_WORD_LIMIT=8000;

const stampFor=(ids:string[],at:string,model?:string,note?:string):StagePatch['stamp']=>{
  const all=promptStamp();
  return {at,prompts:Object.fromEntries(ids.map(id=>[id,all[id]!])),...(model?{model:model.slice(0,120)}:{}),...(note?{note:note.slice(0,500)}:{})};
};
const even=(n:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,Math.round(n/2)*2));

/** Clips the agent cuts speech from: creator or index a-roll with a transcript, else the longest spoken video. */
export function speakingClips(clips:StoryClip[]):StoryClip[] {
  const spoken=clips.filter(c=>c.ref.kind==='video'&&c.transcript);
  const aRoll=spoken.filter(c=>c.ref.role==='a-roll');
  if(aRoll.length)return aRoll;
  const longest=[...spoken].sort((a,b)=>b.ref.duration-a.ref.duration)[0];
  return longest?[longest]:[];
}

/** Drop patch parts for tracks the policy has off or locked, instead of failing the whole stage. */
function allowed(doc:EditDoc,patch:StagePatch):StagePatch {
  const open=(k:string)=>{const m=(doc.policy as Record<string,string>)[k];return m!=='off'&&m!=='locked';};
  const tracks=Object.fromEntries(Object.entries(patch.tracks??{}).filter(([k])=>open(k)));
  return {...patch,tracks,...(patch.markers&&!open('markers')?{markers:undefined}:{})};
}
function apply(doc:EditDoc,target:EditDoc,stage:StageName,stamp:StagePatch['stamp'],brief?:StagePatch['brief'],mix?:StagePatch['mix']):EditDoc {
  const patch=allowed(doc,{...stagePatchBetween(doc,target,stage,stamp),...(brief?{brief}:{}),...(mix?{mix}:{})});
  return applyStagePatch(doc,patch).doc;
}

async function fineTakes(c:StoryClip,name:string,o:StoryEditInput,threshold:number,notes:string[]):Promise<SpeechWord[]> {
  const t=c.transcript!;
  const words=(removed=new Set<number>(),flags=new Map<number,string>())=>t.words.filter(w=>!removed.has(w.id))
    .map(w=>({clipId:c.ref.id,id:w.id,text:w.text,start:w.start,end:w.end,...(flags.has(w.id)?{flag:flags.get(w.id)!}:{})}));
  if(t.words.length>TAKE_WORD_LIMIT){notes.push(`${c.ref.name}: over ${TAKE_WORD_LIMIT} words, so stumbles inside it were not checked.`);return words();}
  try {
    const out:VideoOutput={write:(n,v)=>o.output.write(`${c.ref.id}-${n}`,v),progress:m=>o.output.progress?.(`${c.ref.name}: ${m}`)};
    const {plan}=await planTakes(editForClip(c.ref,name),t,o.planner,out,threshold);
    await out.write('take-removals',plan.removals.map(r=>({...r,applied:r.confidence>=threshold})));
    const removed=new Set<number>(),flags=new Map<number,string>();
    for(const r of plan.removals) for(let id=r.startWord;id<=r.endWord;id++) {
      if(r.confidence>=threshold)removed.add(id);else flags.set(id,`${r.kind}: ${r.reason}`.slice(0,300));
    }
    return words(removed,flags);
  } catch(error) {
    notes.push(`${c.ref.name}: stumble check failed (${String(error).slice(0,160)}); kept all its words.`);
    return words();
  }
}

async function planStructure(input:object,passages:ReturnType<typeof buildPassages>,planner:Planner,output:VideoOutput):Promise<{plan:StructurePlan;model:string}> {
  let r=await planner(promptText(STRUCTURE_PROMPT_ID),input,STRUCTURE_JSON);
  await output.write('structure-response',r);
  try {return {plan:checkStructure(r.plan,passages),model:r.model};}
  catch(error) {
    output.progress?.('Repairing the story plan');
    r=await planner(promptText(STRUCTURE_PROMPT_ID),{...input,invalidPlan:r.plan,validationError:String(error),repair:promptText(STRUCTURE_REPAIR_PROMPT_ID)},STRUCTURE_JSON);
    await output.write('structure-repair-response',r);
    return {plan:checkStructure(r.plan,passages),model:r.model};
  }
}

const int=z.number().int().nonnegative();
export const textPlanSchema=z.object({items:z.array(z.object({shot:z.string().max(200),startWord:int,endWord:int,template:z.enum(['lowerThird','callout']),
  text:z.string().trim().min(1).max(90),confidence:z.number().min(0).max(1),reason:z.string().trim().min(1).max(300)}).strict()).max(200)}).strict();
export type TextPlan=z.infer<typeof textPlanSchema>;
const tstr={type:'string'};
export const TEXT_JSON={type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',items:{type:'object',additionalProperties:false,
  required:['shot','startWord','endWord','template','text','confidence','reason'],
  properties:{shot:tstr,startWord:{type:'integer'},endWord:{type:'integer'},template:{type:'string',enum:['lowerThird','callout']},text:tstr,confidence:{type:'number'},reason:tstr}}}}};

/** Text plan → text items on the output timeline. `strict` throws on the first bad item; otherwise bad items are skipped. */
export function textItems(doc:EditDoc,plan:TextPlan,words:SourceWord[],strict:boolean):TextItem[] {
  const shots=new Map(doc.tracks['a-roll'].filter(i=>i.status!=='suggested').map(i=>[i.id,i]));
  const taken=doc.tracks.text.filter(t=>t.owner==='creator').map(t=>[t.start,t.end] as const);
  const out:TextItem[]=[];
  const fps=doc.fps.num/doc.fps.den,snap=(t:number)=>Math.round(t*fps)/fps;
  for(const g of plan.items) {
    try {
      const shot=shots.get(g.shot);
      if(!shot)throw new Error(`Unknown shot ${g.shot}`);
      const inShot=(id:number)=>words.find(w=>w.clipId===shot.clipId&&w.id===id&&w.start>=shot.in-0.001&&w.end<=shot.out+0.001);
      const a=inShot(g.startWord),b=inShot(g.endWord);
      if(!a||!b)throw new Error(`Words ${g.startWord}-${g.endWord} are not in shot ${g.shot}`);
      if(b.id<a.id)throw new Error(`endWord ${b.id} comes before startWord ${a.id}`);
      const start=snap(shot.start+(a.start-shot.in));
      const end=snap(Math.min(shot.end,start+5,Math.max(shot.start+(b.end-shot.in),start+2)));
      if(end-start<0.5)throw new Error(`Text at word ${a.id} has under half a second left in its shot`);
      if([...taken,...out.map(t=>[t.start,t.end] as const)].some(([s,e])=>s<end&&e>start))throw new Error(`Text at word ${a.id} overlaps other text`);
      out.push({id:`t-${shot.clipId}-${a.id}`,start,end,owner:'agent',stage:'text',status:'applied',template:g.template,text:g.text,position:'auto',
        confidence:g.confidence,reason:g.reason,evidence:[{kind:'word',ref:`${shot.clipId}:${a.id}`},{kind:'word',ref:`${shot.clipId}:${b.id}`}]});
    } catch(error) {if(strict)throw error;}
  }
  return out;
}

async function planText(doc:EditDoc,words:SourceWord[],planner:Planner,output:VideoOutput):Promise<{items:TextItem[];model?:string}> {
  const style=doc.styleRef.snapshot;
  const shots=doc.tracks['a-roll'].filter(i=>i.status!=='suggested').map(i=>({shot:i.id,at:Math.round(i.start*10)/10,
    beat:i.evidence?.find(e=>e.kind==='beat')?.ref??'',
    words:words.filter(w=>w.clipId===i.clipId&&w.start>=i.in-0.001&&w.end<=i.out+0.001).map(w=>`${w.id}:${w.text}`).join(' ')})).filter(s=>s.words);
  if(!shots.length)return {items:[]};
  const input={density:style.pace.textDensity,beats:doc.brief.beats.map(b=>({id:b.id,title:b.title,content:b.content})),shots,
    creatorText:doc.tracks.text.filter(t=>t.owner==='creator').map(t=>({start:t.start,end:t.end}))};
  let r=await planner(promptText(TEXT_PROMPT_ID),input,TEXT_JSON);
  await output.write('text-response',r);
  try {return {items:textItems(doc,textPlanSchema.parse(r.plan),words,true),model:r.model};}
  catch(error) {
    output.progress?.('Repairing on-screen text');
    r=await planner(promptText(TEXT_PROMPT_ID),{...input,invalidPlan:r.plan,validationError:String(error),repair:promptText(TEXT_REPAIR_PROMPT_ID)},TEXT_JSON);
    await output.write('text-repair-response',r);
    const parsed=textPlanSchema.safeParse(r.plan);
    return {items:parsed.success?textItems(doc,parsed.data,words,false):[],model:r.model};
  }
}

export async function planStoryEdit(o:StoryEditInput):Promise<StoryEditResult> {
  const notes:string[]=[];
  const at=(o.now?.()??new Date()).toISOString();
  const speakers=speakingClips(o.clips);
  const prev=o.previous;
  const style=o.style??prev?.styleRef.snapshot??STYLE_PRESETS['calm-explainer'];
  const threshold=style.applyConfidence;
  const main=speakers[0]?.ref??prev?.clips[0];
  if(!main)throw new Error('No video clip with speech to cut. Add an a-roll clip.');
  const fps:Fps=prev?.fps??(main.fps&&main.fps.num/main.fps.den<=60?main.fps:{num:30,den:1});

  let doc:EditDoc;
  if(prev) {
    const clips=[...prev.clips,...o.clips.map(c=>c.ref).filter(r=>!prev.clips.some(p=>p.id===r.id))];
    doc=parseEditDoc({...structuredClone(prev),clips,styleRef:o.style?{id:style.id,revision:style.revision,snapshot:style}:prev.styleRef}).doc;
  } else {
    doc=newEditDoc({id:o.id,name:o.name.slice(0,120)||'Untitled edit',fps,clips:o.clips.map(c=>c.ref),style,
      canvas:{width:even(main.width??1920,320,7680),height:even(main.height??1080,240,4320)}});
  }
  const provenanceFrom=doc.provenance.length;
  const creatorCut=doc.tracks['a-roll'].some(i=>i.owner==='creator')||doc.tracks.voiceover.some(i=>i.owner==='creator');
  if(creatorCut) {
    doc={...doc,policy:{...doc.policy,'a-roll':'locked',voiceover:'locked'}};
    notes.push('You edited the cut, so it stays as you left it; only b-roll, captions and text were redone.');
  }

  // What the creator deleted or turned down stays out, even when the plan comes up with it again.
  const declined=new Set(doc.declined);
  const fresh=(x:{id:string})=>!declined.has(x.id);
  const speech=new Map<string,ClipSpeech>(speakers.map(c=>[c.ref.id,{duration:c.ref.duration,words:c.transcript!.words}]));
  const allWords:SourceWord[]=o.clips.filter(c=>c.transcript).flatMap(c=>c.transcript!.words.map(w=>({clipId:c.ref.id,id:w.id,text:w.text,start:w.start,end:w.end})));

  if(!creatorCut&&doc.policy['a-roll']!=='off') {
    if(!speakers.length)throw new Error('No video clip with speech to cut. Add an a-roll clip.');
    if(!speakers.some(c=>c.ref.role==='a-roll'))notes.push(`No clip is marked a-roll, so the cut uses ${main.name}.`);
    const total=speakers.reduce((n,c)=>n+c.transcript!.words.length,0);
    if(total>MAX_STORY_WORDS)throw new Error(`Too much speech for one edit (${total} words, limit ${MAX_STORY_WORDS}). Split it into shorter edits.`);
    o.output.progress?.('Checking stumbles and retakes');
    const kept=await Promise.all(speakers.map(async c=>({clipId:c.ref.id,words:await fineTakes(c,o.name,o,threshold,notes)})));
    const passages=buildPassages(kept);
    await o.output.write('passages',passages.map(p=>({id:p.id,clipId:p.clipId,text:passageText(p)})));
    o.output.progress?.('Planning the story');
    const input={
      clips:speakers.map(c=>({id:c.ref.id,name:c.ref.name,duration:Math.round(c.ref.duration),summary:c.index?.summary??''})),
      passages:passages.map(p=>({id:p.id,clip:p.clipId,at:Math.round(p.words[0]!.start*10)/10,seconds:passageSeconds(p),text:passageText(p)})),
      totalSeconds:Math.round(passages.reduce((n,p)=>n+passageSeconds(p),0)),
      instruction:o.instruction??'',targetDuration:o.targetDuration??null,
      outline:o.outline?.beats.map(b=>({id:b.id,role:b.role,title:b.title,content:b.content}))??null,
    };
    const assemble=(plan:StructurePlan)=>assembleStory(plan,passages,{fps,clips:speech,maxPause:style.pace.maxPauseSeconds,threshold,
      ...(o.instruction?{instruction:o.instruction}:{}),...(o.targetDuration?{targetDuration:o.targetDuration}:{}),...(o.outline?{outline:o.outline}:{})});
    let structure=await planStructure(input,passages,o.planner,o.output);
    let built=assemble(structure.plan);
    // The model cannot add up seconds reliably: measure the cut and ask again when it runs long.
    const goal=o.targetDuration;
    const length=(b:typeof built)=>b.items.at(-1)!.end;
    for(let round=1;goal&&round<=LENGTH_ROUNDS&&length(built)>goal*(1+LENGTH_SLACK);round++) {
      o.output.progress?.('Trimming to the target length');
      const kept=Math.round(length(built));
      try {
        const next=await planStructure({...input,previousPlan:structure.plan,
          lengthCheck:{keptSeconds:kept,targetSeconds:goal,overBySeconds:kept-goal,note:promptText(STRUCTURE_LENGTH_PROMPT_ID)}},passages,o.planner,o.output);
        const again=assemble(next.plan);
        if(Math.abs(length(again)-goal)>=Math.abs(length(built)-goal))break;
        structure=next;built=again;
      } catch(error) {
        notes.push(`Could not shorten the story plan (${String(error).slice(0,160)}).`);
        break;
      }
    }
    if(goal&&Math.abs(length(built)-goal)>goal*LENGTH_SLACK) {
      const kept=Math.round(length(built));
      notes.push(kept>goal
        ? `The cut runs ${kept} s against your ${goal} s target. Delete beats or replan with a new instruction to shorten it.`
        : `The cut runs ${kept} s, under your ${goal} s target.`);
    }
    await o.output.write('structure-plan',structure.plan);
    if(built.restored.length)notes.push(`${built.restored.length} passages the story plan skipped were put back in recording order.`);
    const structureStamp=stampFor([STRUCTURE_PROMPT_ID,STRUCTURE_REPAIR_PROMPT_ID,...(goal?[STRUCTURE_LENGTH_PROMPT_ID]:[])],at,structure.model,structure.plan.summary);
    const survivors=built.items.filter(fresh);
    const items=survivors.length<built.items.length?packSequence(survivors,fps):built.items;
    // Chapters follow their first surviving item when a declined run closes up.
    const moved=(t:number)=>{const i=survivors.findIndex(k=>k.start>=t-1e-6);return i<0?undefined:items[i]!.start;};
    const markers=built.markers.filter(fresh).flatMap(m=>{const t=items===built.items?m.time:moved(m.time);return t===undefined?[]:[{...m,time:t}];});
    doc=apply(doc,{...doc,markers:[...doc.markers.filter(m=>m.owner==='creator'),...markers]},'structure',structureStamp,built.brief);
    const target={...doc,tracks:{...doc.tracks,'a-roll':items,voiceover:doc.tracks.voiceover.filter(i=>i.owner==='creator')}};
    doc=apply(doc,target,'assembly',stampFor([TAKE_PROMPT_ID,AUDIT_PROMPT_ID,TAKE_REPAIR_PROMPT_ID,AUDIT_REPAIR_PROMPT_ID],at));
  }

  // Zoom: punch-ins across jump cuts and push-ins, by code. Only on an agent-run cut;
  // in suggest mode each zoom would become a review item of its own.
  if(doc.policy.zoom==='auto') {
    const zoomed=planZoom(doc,o.clips);
    if(JSON.stringify(zoomed)!==JSON.stringify(doc.tracks.zoom))
      doc=apply(doc,{...doc,tracks:{...doc.tracks,zoom:zoomed}},'zoom',stampFor([],at,undefined,`zoom ${style.pace.zoomFrequency}`));
  }

  // B-roll: matching footage from the non-speaking clips over what is said.
  if(doc.policy['b-roll']!=='off'&&doc.policy['b-roll']!=='locked') {
    o.output.progress?.('Placing b-roll');
    const broll=await planBroll(doc,o.clips,new Set(speakers.map(c=>c.ref.id)),allWords,o.planner,o.output);
    const agentBefore=doc.tracks['b-roll'].some(b=>b.owner==='agent');
    if(broll.library||agentBefore) {
      let items=broll.items.filter(fresh);
      const ids=[BROLL_PROMPT_ID,BROLL_REPAIR_PROMPT_ID];
      // Only shots the last revision did not already show get looked at.
      const seen=new Set(doc.tracks['b-roll'].map(b=>`${b.id}|${b.clipId}|${b.in}`));
      const unseen=new Set(items.filter(b=>!seen.has(`${b.id}|${b.clipId}|${b.in}`)).map(b=>b.id));
      if(o.look&&unseen.size) {
        o.output.progress?.('Checking b-roll shots');
        try {
          const review=await reviewBroll(doc,items,unseen,allWords,new Map(o.clips.filter(c=>c.index).map(c=>[c.ref.id,c.index!])),o.look);
          items=review.items;ids.push(BROLL_REVIEW_PROMPT_ID);
          await o.output.write('broll-review',{swapped:review.swapped,demoted:review.demoted,model:review.model,costUsd:review.costUsd});
          if(review.swapped)notes.push(`Swapped ${review.swapped} b-roll shot${review.swapped>1?'s':''} for a better take after checking the frames.`);
          if(review.demoted)notes.push(review.demoted>1?`${review.demoted} b-roll shots are left as suggestions: the frame check found a problem.`:'1 b-roll shot is left as a suggestion: the frame check found a problem.');
        } catch(error) {
          notes.push('B-roll shots were not checked by eye this time; look them over.');
          await o.output.write('broll-review-error',String(error).slice(0,1000));
        }
      }
      const target={...doc,tracks:{...doc.tracks,'b-roll':[...doc.tracks['b-roll'].filter(b=>b.owner==='creator'),...items]}};
      doc=apply(doc,target,'b-roll',stampFor(ids,at,broll.model));
    }
    if(!broll.library&&o.clips.some(c=>c.ref.role==='b-roll'&&c.index))notes.push('No usable b-roll segment was found in the b-roll clips.');
  }

  // Text: captions by code, on-screen text by the model. Agent items that would land on creator items are left out.
  o.output.progress?.('Adding captions and text');
  const overlaps=(a:{start:number;end:number},list:{start:number;end:number}[])=>list.some(b=>b.start<a.end&&b.end>a.start);
  const creatorCaps=doc.tracks.captions.filter(c=>c.owner==='creator');
  const captions=style.pace.captions==='off'?[]:buildCaptions(doc,allWords,style.brand.captionStyle).filter(c=>fresh(c)&&!overlaps(c,creatorCaps));
  const text=doc.policy.text==='off'||doc.policy.text==='locked'?{items:doc.tracks.text.filter(t=>t.owner==='agent')}:await planText(doc,allWords,o.planner,o.output);
  const target={...doc,tracks:{...doc.tracks,captions:[...creatorCaps,...captions],text:[...doc.tracks.text.filter(t=>t.owner==='creator'),...text.items.filter(t=>fresh(t)&&!repeatsDeclined(t.text,doc.declinedText))]}};
  doc=apply(doc,target,'text',stampFor([TEXT_PROMPT_ID,TEXT_REPAIR_PROMPT_ID],at,'model' in text?text.model:undefined));

  // Graphics: the few moments a picture explains better than a sentence. The
  // render box makes each one later; the doc names it by asset id.
  const requests=new Map<string,GraphicRequest>();
  if(o.graphics&&doc.policy.graphics!=='off'&&doc.policy.graphics!=='locked') {
    o.output.progress?.('Planning graphics');
    try {
      const planned=await planMotionGraphics(doc,allWords,o.planner,o.output);
      const items=planned.graphics.filter(p=>fresh(p.item));
      // A graphic replaces the agent callouts it covers.
      const covered=(t:{start:number;end:number})=>items.some(p=>p.item.start<t.end-1e-6&&p.item.end>t.start+1e-6);
      const text=doc.tracks.text.filter(t=>t.owner==='creator'||!covered(t));
      if(text.length<doc.tracks.text.length)notes.push(`${doc.tracks.text.length-text.length} text callout${doc.tracks.text.length-text.length>1?'s were':' was'} replaced by a graphic.`);
      const target={...doc,tracks:{...doc.tracks,text,graphics:[...doc.tracks.graphics.filter(g=>g.owner==='creator'),...items.map(p=>p.item)]}};
      doc=apply(doc,target,'graphics',stampFor([GRAPHIC_PLAN_PROMPT_ID,GRAPHIC_PLAN_REPAIR_PROMPT_ID],at,planned.model));
      for(const p of items)requests.set(p.item.assetId,p.request);
    } catch(error) {
      notes.push('Graphics were skipped this time; the rest of the edit is done.');
      await o.output.write('graphics-error',String(error).slice(0,1000));
    }
  }
  const graphics=new Map([...requests].filter(([id])=>doc.tracks.graphics.some(g=>g.owner==='agent'&&g.assetId===id)));

  // Audio: the creator's music and effects, placed and levelled by code.
  const open=(k:'music'|'sfx')=>doc.policy[k]!=='off'&&doc.policy[k]!=='locked';
  if(open('music')||open('sfx')) {
    const audio=planAudio(doc);
    notes.push(...audio.notes);
    // Music the creator placed themselves replaces ours; their effects keep ours off the same moment.
    const mineMusic=doc.tracks.music.filter(m=>m.owner==='creator'),mineSfx=doc.tracks.sfx.filter(s=>s.owner==='creator');
    const clear=(x:{start:number;end:number})=>!mineSfx.some(s=>s.start<x.end&&s.end>x.start);
    const target={...doc,tracks:{...doc.tracks,
      music:[...mineMusic,...(mineMusic.length?[]:audio.music.filter(fresh))],
      sfx:[...mineSfx,...audio.sfx.filter(s=>fresh(s)&&clear(s))]}};
    const mix=Object.entries(audio.mix).some(([k,v])=>doc.mix[k as keyof typeof doc.mix]!==v);
    if(mix||JSON.stringify([doc.tracks.music,doc.tracks.sfx])!==JSON.stringify([target.tracks.music,target.tracks.sfx]))
      doc=apply(doc,target,'audio',stampFor([],at,undefined,`music ${target.tracks.music.length}, sfx ${target.tracks.sfx.length}`),undefined,mix?audio.mix:undefined);
  }

  if(o.revision!==undefined) {
    doc={...doc,revision:o.revision,provenance:doc.provenance.map((p,i)=>i>=provenanceFrom?{...p,revision:o.revision!}:p)};
  }
  if(notes.length)await o.output.write('notes',notes);
  return {doc:parseEditDoc(doc).doc,notes,graphics};
}
