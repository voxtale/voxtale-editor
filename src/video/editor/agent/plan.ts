// The agent planner: one edit made by an agent harness working the editor
// tools, as an alternative to the story stages (../../story-edit). Same input
// (story clips with transcript and index), same output (an EditDoc), plus the
// graphics it rendered. The agent looks at frames through a frame host: this
// machine's files by default, or the creator's desktop on a cloud run.
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

import {type EditDoc,type EditStyle,type MixSettings} from '@voxtale/editdoc';
import type {BrandKit} from '../state';
import {projectLines,type ProjectBrief} from '../project';
import {asksToLast,rulesBrief} from '../rules';
import type {StoryClip} from '../../story-edit';
import {promptText} from '../../../services/prompts';
import {type ClipMoments} from '../../moments';
import {beatsOfFile,findBeats} from '../../beats';
import {checkCut,type Job,type JobClip} from './cut';
import {eyeFinder,type EyeFinder} from './eyes';
import {AUDIO_MAX_SECONDS,AUDIO_RATE,localFrames,type FrameHost,type HtmlRenderer} from './frames';
import {dockerGraphicsRenderer} from './remotion';
import {ff} from './look';
import {serveTools} from './mcp-http';
import {instrument,type AgentRun,type AgentRunner} from './port';
import {footageClips,newJob,newWorkspace,styleFor,understandClips,type UnderstandClip} from './session';
import {stepRecorder,type AgentStep} from './steps';
import {AGENT_SKILL_PROMPT_ID} from './skill';
import {editorTools,save} from './tools';

export interface AgentPlanInput {
  id:string;
  name:string;
  revision:number;
  clips:StoryClip[];
  /** Full file per clip hash, when they are on this machine; else give `frames`. */
  sources?:Record<string,string>;
  /** Where frames and graphic renders come from; default: `sources` on this machine. */
  frames?:FrameHost;
  /** Graphics renderer for local frames; default: Docker. */
  html?:HtmlRenderer;
  style?:string;
  /** The creator's brand kit, laid over the preset (not over a kept look). */
  brand?:BrandKit;
  /** The last cut's look and mix, kept over the preset on a replan. */
  look?:{style:EditStyle;mix:MixSettings};
  /** The last version on a replan: the creator's own items and locked tracks in it survive. */
  previous?:EditDoc;
  targetDuration?:number;
  instruction?:string;
  /** The VoxTale web project the edit is for. */
  project?:ProjectBrief;
  /** The creator's accepted standing rules (../rules.ts acceptedRules), text only. */
  rules?:string[];
  /** HyperFrames graphics (the frame host renders them). */
  graphics:boolean;
  runner:AgentRunner;
  /** Per-job folder for the workspace (state, looks, graphic renders). */
  workspace:string;
  model?:string;
  maxTurns?:number;
  maxBudgetUsd?:number;
  log?:(line:string)=>void;
  /** Filled with one record per tool call as the agent works, kept even when the plan fails. */
  steps?:AgentStep[];
  /**
   * Describes what each clip shows, change by change (../../moments.ts), keyed
   * by clip id. Given the footage clips that do not speak, with the words heard
   * while they ran; a clip it leaves out falls back to its index.
   */
  understand?:(clips:UnderstandClip[],frames:FrameHost)=>Promise<Record<string,ClipMoments>>;
  /** Finds the speaker's eyes at cut frames for zoom; false = use the index's faces only. */
  eyes?:EyeFinder|false;
  signal?:AbortSignal;
}

export type {UnderstandClip} from './session';
export {footageClips};

export interface AgentPlan {
  doc:EditDoc;
  notes:string[];
  /** Graphics on the timeline: transparent WebM files in the workspace. */
  graphics:{assetId:string;webm:string;seconds:number}[];
  run:AgentRun;
  problems:string[];
  metrics:Record<string,number|string>;
  /** Standing rules the agent proposed from the creator's words: the host stores them as proposed, for the creator to accept, edit or refuse. */
  proposedRules?:{text:string;said:string}[];
}

/** Clips a plan needs on disk: every video the agent may look at or show. */
export const agentClipHashes=(clips:StoryClip[])=>clips.filter(c=>c.ref.kind==='video'&&c.ref.role!=='music'&&c.ref.role!=='sfx').map(c=>c.ref.hash);

/** Music whose beat is not measured yet. */
export const musicClipHashes=(clips:StoryClip[])=>clips.filter(c=>c.ref.role==='music'&&c.ref.hasAudio&&!c.ref.beats).map(c=>c.ref.hash);

/** Video the agent can show over the voice: every clip that does not speak. */

export function taskPrompt(job:Job,graphics:boolean,kept=false):string {
  const of=(role:string)=>job.clips.filter(c=>c.ref.role===role);
  const speakers=of('a-roll');
  const v=(speakers[0]??job.clips.find(c=>c.ref.kind==='video')??job.clips[0]!).ref,p=job.style.pace;
  return [
    `Edit this footage into one video.`,
    `Clips: ${speakers.length?'':'none speak; place footage with set_cut shot segments.'}${speakers.map(c=>`${c.ref.id} "${c.ref.name}" ${c.ref.duration.toFixed(1)}s ${c.ref.width}x${c.ref.height}`).join('; ')}.`,
    job.targetSeconds?`Target length: ${job.targetSeconds}s (85-115% is fine).`:`No target length: cut everything that does not earn its place.`,
    `Style "${job.style.id}": about ${p.targetCutsPerMinute} cuts/min, pauses over ${p.maxPauseSeconds}s trimmed, shots at least ${p.minShotSeconds}s.`,
    ...(job.styleUse?.lines??[]),
    p.captions==='off'?`Captions: off for this style.`:`Captions: on, but only for the spans you set with set_captions.${kept?' The creator chose their look: do not pass look.':' Pick their look too.'}`,
    graphics?`Graphics: on. Canvas ${v.width}x${v.height}. Design each one with render_graphic (see the skill).`:`Graphics: off (no graphics tools).`,
    footageClips(job).length?`Other footage (find_footage for what each shows when; survey_clips to look at each before you choose or place it; show_footage lays it over the voice, a set_cut shot segment places it as its own stretch of the cut with its own sound):\n${footageClips(job).map(c=>{
      const sync=job.sync?.find(x=>x.clip===c.ref.id);
      return `- ${c.ref.id} "${c.ref.name}" ${c.ref.role} ${c.ref.duration.toFixed(1)}s ${c.ref.width??'?'}x${c.ref.height??'?'}`
        +(sync?`, recorded with ${sync.with} (same clock: sync:true)`:'')
        +(c.moments?`, ${c.moments.moments.length} described moments`:c.index?` — ${c.index.summary}`:'');
    }).join('\n')}`:'Other footage: none.',
    of('music').length?`Music (${of('music').length} file): set_music says where it comes in, from which second of the track, and which lines it leaves bare. Where its beat is firm, code starts footage, graphics and text on the beat; speech joins stay on the words.`:'',
    `Sound effects: set_sfx places hits on gestures, from a built-in library (whoosh, impact, riser, click, pop)${of('sfx').length?` or the creator's ${of('sfx').length} effect file(s)`:''}; without it code places a few.`,
    `Colour: set_look corrects exposure and white balance from measured frames, then at most a light look.`,
    ...rulesBrief(job.rules??[]),
    asksToLast(job.instruction)?`The instruction asks for something to last past this edit: after doing it here, call propose_rule once with the rule in one plain sentence.`:'',
    ...(job.project?projectLines(job.project):[]),
    job.instruction?`Creator's instruction: ${job.instruction}`:'',
    `Call finish when done.`,
  ].filter(Boolean).join('\n');
}

export async function planWithAgent(o:AgentPlanInput):Promise<AgentPlan> {
  const clips:JobClip[]=o.clips.map(c=>({ref:c.ref,
    words:(c.transcript?.words??[]).map(w=>({id:w.id,text:w.text,start:w.start,end:w.end})),...(c.index?{index:c.index}:{})}));
  if(!o.frames) {
    const missing=o.clips.filter(c=>!o.sources?.[c.ref.hash]&&agentClipHashes([c]).length);
    if(missing.length)throw new Error(`The agent editor needs these clips on this computer: ${missing.map(c=>c.ref.name).join(', ')}`);
  }
  if(!clips.some(c=>c.ref.role==='a-roll'&&c.words.length))throw new Error('The agent editor needs at least one a-roll clip with speech.');
  const job=newJob({id:o.id,name:o.name,clips,style:o.look?.style??styleFor(o.style,o.brand),
    ...(o.targetDuration?{targetSeconds:o.targetDuration}:{}),...(o.instruction?{instruction:o.instruction}:{}),...(o.project?{project:o.project}:{}),...(o.rules?.length?{rules:o.rules}:{})});
  await mkdir(o.workspace,{recursive:true});
  // Music: find its beat, so cuts and picture changes can land on it.
  for(const c of clips) {
    const path=o.sources?.[c.ref.hash],far=o.frames?.audio;
    // Beats found before v5 carry no confidence or lively point: find them again.
    if(c.ref.role!=='music'||c.ref.beats?.confidence!==undefined||!c.ref.hasAudio||!(path||far))continue;
    // No file here: the frame host reads its sound where the file is.
    const beats=await (path?beatsOfFile(path,ff):far!(c.ref.hash,0,Math.min(c.ref.duration,AUDIO_MAX_SECONDS))
      .then(b=>findBeats(new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+Math.floor(b.byteLength/4)*4)),AUDIO_RATE))).catch(()=>undefined);
    if(beats)c.ref={...c.ref,beats};
    o.log?.(beats?`music ${c.ref.name}: ${beats.bpm} bpm, confidence ${beats.confidence}, lively from ${beats.livelyFrom}s`:`music ${c.ref.name}: no steady beat found`);
  }
  const frames=o.frames??localFrames({sources:o.sources??{},dir:join(o.workspace,'looks'),html:o.html??dockerGraphicsRenderer(),ff});
  if(o.understand) {
    const found=await o.understand(understandClips(job),frames);
    for(const c of clips)if(found[c.ref.id])c.moments=found[c.ref.id];
  }
  const ws=newWorkspace({dir:o.workspace,job,frames,graphics:o.graphics,captionLookKept:!!o.look,
    ...(o.eyes!==false?{eyes:o.eyes??eyeFinder(frames.frames)}:{})});
  if(o.previous)ws.base=o.previous;
  const calls:AgentRun['toolCalls']=[];
  const rec=o.steps?stepRecorder({dir:o.workspace,job,steps:o.steps,doc:()=>({...(ws.doc?{doc:ws.doc}:{}),segments:ws.segments})}):undefined;
  const tools=instrument(editorTools(ws),calls,o.log,rec&&((name,args,r,ms)=>rec.step(name,args,r,ms)));
  const server=await serveTools(tools);
  let run:AgentRun;
  try {
    run=await o.runner.run({instructions:promptText(AGENT_SKILL_PROMPT_ID),prompt:taskPrompt(job,o.graphics,!!o.look),tools,workspace:o.workspace,
      model:o.model??'',maxTurns:o.maxTurns??60,maxBudgetUsd:o.maxBudgetUsd??3,server:{url:server.url,headers:server.headers},
      ...(o.log?{log:o.log}:{}),...(rec?{said:(text:string)=>rec.said(text)}:{}),...(o.signal?{signal:o.signal}:{})});
  } finally {
    await server.close();
  }
  // The harness counts calls from its own stream; ours has timings and errors.
  run={...run,toolCalls:calls};
  if(!ws.doc)throw new Error(`The agent stopped without a cut (${run.stop}).`);
  await save(ws);
  const check=checkCut(job,ws.doc,ws.segments,ws.doc.tracks.graphics.length);
  const doc={...ws.doc,revision:o.revision,...(o.look?{mix:o.look.mix}:{})};
  const notes=[
    ...(ws.finished?[ws.finished.summary]:[`The agent stopped before finishing (${run.stop}); this is its last cut.`]),
    ...check.problems.map(p=>`Open: ${p}`),
  ];
  // Variants ship too, so the creator can switch to them later.
  const placed=new Set(doc.tracks.graphics.flatMap(g=>[g.assetId,...(g.variants??[]).map(v=>v.assetId)]));
  return {doc,notes,problems:check.problems,metrics:check.metrics,run,...(ws.proposedRules?.length?{proposedRules:ws.proposedRules}:{}),
    graphics:Object.entries(ws.graphics).filter(([id])=>placed.has(id)).map(([assetId,g])=>({assetId,webm:g.webm,seconds:g.seconds}))};
}

export {claudeCliRunner,codexRunner} from './adapters/cli';
export {dockerHtmlRenderer,hyperframesReady} from './hyperframes';
export {dockerGraphicsRenderer,dockerRemotionRenderer,graphicsEngine,graphicsReady,localGraphicsRenderer,remotionReady,GRAPHICS_ENGINES,type GraphicsEngine} from './remotion';
export {answerFrameCall,localFrames,relayFrames,renderGraphic,type FrameCall,type FrameHost,type FrameReply,type GraphicJob,type GraphicResult,type HtmlRenderer,type RelayPort} from './frames';
export type {AgentRunner} from './port';
export type {AgentStep,AgentTrace} from './steps';
