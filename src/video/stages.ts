import {askPlanner} from './openrouter';
import {promptText} from '../services/prompts';
import {planTakes,planGraphics,videoPromptStamp,type Planner} from './pipeline';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {digest,locked,maybeJson,readJson,writeJson} from './artifacts';
import {editSchema,durationFrames,type Edit} from './model';
import {type Transcript,loadTranscript} from './transcript';
import {TAKE_JSON,TAKE_PROMPT_ID,GRAPHICS_JSON,GRAPHICS_PROMPT_ID,takePlanSchema,graphicsPlanSchema,type TakePlan,type GraphicsPlan} from './planner';

import {eligibleWords,buildTakeEdit,buildGraphicsEdit} from './editing';
import {parseEditDoc,type ClipRef,type EditDoc} from '@voxtale/editdoc';
import {applyEditStage,clipFromTranscript,editDocFromEdit} from './editdoc';
export {eligibleWords,buildTakeEdit,buildGraphicsEdit,validateTakes} from './editing';
export type Options={progress?:(message:string)=>void;planner?:Planner;model?:string;plan?:string;confidence?:number;keepPauses?:boolean;
  /** EditDoc v2 the input edit came from (the previous stage's editdoc.json); built from the edit when absent. */
  inputDoc?:EditDoc};
// B-roll and music paths have no transcript; hash the path so their clip ids stay stable.
const legacyClip=(path:string,kind:'image'|'video'|'audio'):ClipRef=>({id:`media-${digest(path).slice(0,12)}`,hash:digest(path),name:path.split('/').pop()||path,
  kind,role:kind==='audio'?'music':'b-roll',roleSource:'creator',duration:6*3600,hasAudio:kind!=='image',timecodeStart:0});
async function runStage(kind:'takes'|'graphics',edit:Edit,transcriptPath:string,out:string,options:Options={}) {
  if(options.confidence!==undefined&&(!Number.isFinite(options.confidence)||options.confidence<0||options.confidence>1))throw new Error('Confidence must be between 0 and 1');
  const t=await loadTranscript(transcriptPath,edit);
  const words=eligibleWords(edit,t);
  if(!words.length)throw new Error('No complete transcript words in the selected footage');
  if(words.length>8000)throw new Error('This first planner supports up to 8,000 selected words; split the edit into smaller sections');
  const inputHash=digest({stageVersion:5,prompts:videoPromptStamp(),edit,transcript:t,kind,prompt:promptText(kind==='takes'?TAKE_PROMPT_ID:GRAPHICS_PROMPT_ID),model:options.model??process.env.VIDEO_EDIT_MODEL??'anthropic/claude-sonnet-4.6',confidence:options.confidence??0.85,keepPauses:options.keepPauses??false,plan:options.plan?await readJson(options.plan):null});
  out=resolve(out);
  const prior=await maybeJson(join(out,'stage.json'));
  if(prior) {
    if(prior.inputHash!==inputHash)throw new Error('Stage inputs changed: choose a new --out folder');
    const saved=editSchema.parse(await readJson(join(out,'edit.json')));
    if(digest(saved)!==prior.outputHash)throw new Error('Saved stage edit changed: use it as input to the next stage, or choose a new folder');
    options.progress?.(`Using saved ${kind} stage`);return saved;
  }
  await mkdir(out,{recursive:true});
  // Retain the provider response before applying it. A failed validation is
  // inspectable and can be corrected via --plan without paying for another call.
  let response=await maybeJson(join(out,'response.json'));
  if(response && response.inputHash!==inputHash)throw new Error('Stage inputs changed: choose a new --out folder');
  if(!response) {
    const marker=await maybeJson(join(out,'request.json'));
    if(marker?.inputHash!==inputHash&&(await readdir(out)).length)throw new Error('Output folder contains files from another task; choose a new --out folder');
    await writeJson(join(out,'request.json'),{inputHash});
    options.progress?.(`Planning ${kind}`);
    const input={scenes:edit.scenes.map(s=>({id:s.id,in:s.in,out:s.out,title:s.title,graphics:s.graphics})),words};
    const providerCall:Planner=options.planner??((system,input,schema)=>askPlanner(system,input,schema,options.model));
    let call=0;
    const planner:Planner=async(system,input,schema)=>{
      const path=join(out,`planner-call-${++call}.json`),hash=digest({system,input,schema});
      const saved=await maybeJson(path);if(saved){if(saved.hash!==hash)throw new Error('Planner request changed; choose a new folder');return saved.response;}
      const response=await providerCall(system,input,schema);await writeJson(path,{hash,response});return response;
    };
    const provider=options.plan?{plan:await readJson(options.plan),model:'manual',usage:null}:kind==='takes'?await planTakes(edit,t,planner,{write:(name,value)=>writeJson(join(out,`${name}.json`),value),progress:options.progress},options.confidence??0.85):await planGraphics(edit,t,planner,{write:(name,value)=>writeJson(join(out,`${name}.json`),value),progress:options.progress});
    response={inputHash,...provider};await writeJson(join(out,'response.json'),response);
  }
  let final:Edit,details:unknown;
  if(kind==='takes') {
    const plan=takePlanSchema.parse(response.plan);const built=buildTakeEdit(edit,t,plan,options.confidence??0.85,!options.keepPauses);
    final=built.edit;details={summary:plan.summary,decisions:built.decisions,cuts:built.cuts};
    await writeJson(join(out,'plan.json'),plan);
    await writeFile(join(out,'review.txt'),[plan.summary,...built.decisions.map(d=>`${d.applied?'REMOVE':'KEEP FOR REVIEW'} [${t.words[d.startWord]!.start.toFixed(2)}s] ${d.removedText}\nReason: ${d.reason}\nSelected: ${d.keptText??'(setup chatter)'}`),`Duration: ${(durationFrames(edit)/edit.fps).toFixed(2)}s → ${(durationFrames(final)/final.fps).toFixed(2)}s`,`${built.cuts.filter(c=>c.reason==='pause').length} pause cuts proposed (see decisions.json)`].join('\n\n')+'\n');
  }else {
    const plan=graphicsPlanSchema.parse(response.plan);final=buildGraphicsEdit(edit,t,plan);details=plan;
    await writeJson(join(out,'plan.json'),plan);
    await writeFile(join(out,'review.txt'),plan.graphics.map(g=>`${g.sceneId}: ${g.text}\n${g.reason}`).join('\n\n')+'\n');
  }
  await writeJson(join(out,'decisions.json'),details);
  const from=options.inputDoc??editDocFromEdit(edit,{clip:clipFromTranscript(edit,t),transcript:t,mediaClip:legacyClip});
  const doc=applyEditStage(from,final,kind==='takes'?['assembly','text']:['text'],
    {at:new Date().toISOString(),prompts:videoPromptStamp(),model:String(response.model??'unknown').slice(0,120)},{transcript:t,mediaClip:legacyClip});
  await writeJson(join(out,'editdoc.json'),doc);
  await writeJson(join(out,'edit.json'),final);
  await writeJson(join(out,'stage.json'),{version:1,kind,inputHash,outputHash:digest(final),model:response.model,usage:response.usage,prompts:videoPromptStamp()});
  return final;
}

/** The EditDoc v2 a finished stage wrote, if any. */
export async function stageDoc(out:string):Promise<EditDoc|undefined> {
  const raw=await maybeJson(join(resolve(out),'editdoc.json'));
  return raw?parseEditDoc(raw).doc:undefined;
}

export async function stage(kind:'takes'|'graphics',edit:Edit,transcriptPath:string,out:string,options:Options={}) {
  return locked(`${resolve(out)}.lock`,()=>runStage(kind,edit,transcriptPath,out,options));
}
