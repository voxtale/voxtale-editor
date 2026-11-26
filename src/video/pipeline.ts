import {promptText,promptStamp} from '../services/prompts';
import {TAKE_PROMPT_ID,AUDIT_PROMPT_ID,GRAPHICS_PROMPT_ID,TAKE_REPAIR_PROMPT_ID,AUDIT_REPAIR_PROMPT_ID,GRAPHICS_REPAIR_PROMPT_ID} from './prompts';
import {takePlanSchema,graphicsPlanSchema,TAKE_JSON,GRAPHICS_JSON,type TakePlan} from './planner';
import {eligibleWords,buildTakeEdit,buildGraphicsEdit,validateTakes,reconcileTakes} from './editing';
import {repetitionCandidates,confirmConnectorRestarts,preserveRestartLeadIns,protectDistantRecaps} from './repetitions';
import type {Edit} from './model';
import type {Transcript} from './transcript-model';

export type Planner=(system:string,input:unknown,schema:object)=>Promise<{plan:unknown;model:string;usage:unknown}>;
export interface VideoOutput {
  write(name:string,value:unknown):Promise<void>;
  progress?(message:string):void;
}
export interface VideoDependencies {
  transcribe(edit:Edit):Promise<Transcript>;
  planner:Planner;
  render(edit:Edit):Promise<unknown>;
  output:VideoOutput;
}
/** Core workflow: no file paths, environment reads, console output or provider construction. */
export async function runVideoPipeline(edit:Edit,deps:VideoDependencies) {
  deps.output.progress?.('Transcribing');
  const transcript=await deps.transcribe(edit);
  await deps.output.write('transcript',transcript);
  const selected=await planTakes(edit,transcript,deps.planner,deps.output);
  await deps.output.write('take-plan',selected);
  const takes=buildTakeEdit(edit,transcript,selected.plan).edit;
  await deps.output.write('takes',takes);
  const response=await planGraphics(takes,transcript,deps.planner,deps.output);
  const final=buildGraphicsEdit(takes,transcript,graphicsPlanSchema.parse(response.plan));
  await deps.output.write('edit',final);
  const rendered=await deps.render(final);
  return {edit:final,transcript,rendered};
}
export function videoPromptStamp() {
  const all=promptStamp();
  return Object.fromEntries([TAKE_PROMPT_ID,AUDIT_PROMPT_ID,GRAPHICS_PROMPT_ID,TAKE_REPAIR_PROMPT_ID,AUDIT_REPAIR_PROMPT_ID,GRAPHICS_REPAIR_PROMPT_ID].map(id=>[id,all[id]]));
}
/** Broad selection followed by a separate read of what the viewer would hear. */
export async function planTakes(edit:Edit,t:Transcript,planner:Planner,output:VideoOutput,threshold=0.85) {
  const words=eligibleWords(edit,t);
  if(!words.length)throw new Error('No complete transcript words in the selected footage');
  if(words.length>8000)throw new Error('Split recordings over 8,000 selected words into smaller sections');
  const candidates=repetitionCandidates(words);
  await output.write('repetition-candidates',candidates);
  output.progress?.('Selecting takes and short restarts');
  const input={scenes:edit.scenes,words,candidates};
  let first=await planner(promptText(TAKE_PROMPT_ID),input,TAKE_JSON);
  await output.write('takes-first-response',first);
  let plan:TakePlan;
  try {plan=reconcileTakes(takePlanSchema.parse(first.plan),threshold);validateTakes(edit,t,plan,threshold);}
  catch(error) {
    output.progress?.('Repairing invalid take plan before applying any cuts');
    first=await planner(promptText(TAKE_PROMPT_ID),{...input,invalidPlan:first.plan,validationError:String(error),repair:promptText(TAKE_REPAIR_PROMPT_ID)},TAKE_JSON);
    await output.write('takes-repair-response',first);
    plan=reconcileTakes(takePlanSchema.parse(first.plan),threshold);validateTakes(edit,t,plan,threshold);
  }
  plan=reconcileTakes(protectDistantRecaps(preserveRestartLeadIns(confirmConnectorRestarts(plan,t),t),t),threshold);
  const removed=validateTakes(edit,t,plan,threshold);
  const retained=words.filter(w=>!removed.has(w.id));
  output.progress?.('Auditing retained speech for missed repetitions');
  let audit=await planner(promptText(AUDIT_PROMPT_ID),{words:retained,candidates:repetitionCandidates(retained)},TAKE_JSON);
  await output.write('takes-audit-response',audit);
  function mergeAudit(raw:unknown):TakePlan {
    const extra=protectDistantRecaps(preserveRestartLeadIns(confirmConnectorRestarts(takePlanSchema.parse(raw),t),t),t);
    const ids=new Set(retained.map(w=>w.id));
    for(const r of extra.removals) {
      for(const [a,b] of [[r.startWord,r.endWord],[r.keptStartWord,r.keptEndWord]]) {
        if(a===null||b===null)continue;
        for(let id=a!;id<=b!;id++)if(!ids.has(id))throw new Error('Audit referenced removed or unknown speech');
      }
    }
    const additions=extra.removals;
    const merged={summary:plan.summary+'\nAudit: '+extra.summary,removals:[...plan.removals.filter(r=>r.confidence>=threshold||!additions.some(a=>a.startWord<=r.endWord&&a.endWord>=r.startWord)),...additions]};
    const reconciled=reconcileTakes(merged,threshold);
    validateTakes(edit,t,reconciled,threshold);
    return reconciled;
  }
  try {plan=mergeAudit(audit.plan);}
  catch(error) {
    output.progress?.('Repairing invalid audit before applying any cuts');
    audit=await planner(promptText(AUDIT_PROMPT_ID),{words:retained,candidates:repetitionCandidates(retained),invalidPlan:audit.plan,validationError:String(error),repair:promptText(AUDIT_REPAIR_PROMPT_ID)},TAKE_JSON);
    await output.write('takes-audit-repair-response',audit);
    plan=mergeAudit(audit.plan);
  }
  const applied=plan.removals.filter(r=>r.confidence>=threshold).length;
  plan={...plan,summary:`Selected ${applied} cuts; ${plan.removals.length-applied} proposals kept for review. Raw model summaries remain in the saved responses.`};
  const built=buildTakeEdit(edit,t,plan,threshold,false);
  await output.write('retained-transcript',eligibleWords(built.edit,t));
  await output.write('remaining-repetition-candidates',repetitionCandidates(eligibleWords(built.edit,t)));
  return {plan,model:first.model,usage:{selection:first.usage,audit:audit.usage},prompts:videoPromptStamp()};
}

export async function planGraphics(edit:Edit,t:Transcript,planner:Planner,output:VideoOutput) {
  const words=eligibleWords(edit,t);
  const input={scenes:edit.scenes.map(scene=>({...scene,wordIds:words.filter(w=>w.start>=scene.in-.001&&w.end<=scene.out+.001).map(w=>w.id)})),words};
  let response=await planner(promptText(GRAPHICS_PROMPT_ID),input,GRAPHICS_JSON);
  await output.write('graphics-first-response',response);
  try {buildGraphicsEdit(edit,t,graphicsPlanSchema.parse(response.plan));}
  catch(error) {
    output.progress?.('Repairing graphics that do not fit kept scenes');
    response=await planner(promptText(GRAPHICS_PROMPT_ID),{...input,invalidPlan:response.plan,validationError:String(error),repair:promptText(GRAPHICS_REPAIR_PROMPT_ID)},GRAPHICS_JSON);
    await output.write('graphics-repair-response',response);
    buildGraphicsEdit(edit,t,graphicsPlanSchema.parse(response.plan));
  }
  await output.write('graphics-plan',{...response,prompts:videoPromptStamp()});
  return response;
}
