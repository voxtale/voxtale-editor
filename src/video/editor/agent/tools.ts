// The editor's tools in harness-neutral form, over one per-job workspace.
// State: segments + graphics in memory, mirrored to <workspace>/state.json and
// <workspace>/edit.json (the EditDoc) after every change.
import {withMotionKit} from './motion';
import {resolvePlace,templateHtml,templateSchema} from './templates';
import {sceneTools,type SceneJob} from './scene-tools';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {StackSpan} from '../../live/stack';
import {z} from 'zod/v4';
import {BEAT_CONFIDENCE_MIN,CAPTION_PRESETS,CAPTION_PRESET_IDS,PIP_CORNERS,TRANSITION_KINDS,ZOOM_CURVES,VARIANTS_MAX,fixedWord,keepCreatorItems,keepText,withCaptionPreset,type CaptionPresetId,type EditDoc,type GraphicItem,type KeepReport,type WordFix} from '@voxtale/editdoc';
import {footageText,rankFootage,rankText,screenActivity,screenSummary,shownMeanwhile} from './footage';
import {deliveryOf,deliveryTable} from '../../delivery';
import {levelGains,speechLevel} from '../../levels';
import {findRetakes,joinSound,quietTo,retakeText,saidTwice,speechIn,stressedWords,voiceOf,wordEdge,type Voice} from '../../voice';
import {AUDIO_MAX_SECONDS,AUDIO_RATE,stripTimes} from '@voxtale/frames';
import type {Point} from '../../zoom';
import type {EyeFinder} from './eyes';
import {kitCss,type Face} from './kit';
import {afterClose,buildCut,checkCut,clipOf,cutSound,faceAt,packTranscript,type BrollPlacement,type CaptionSpan,type ChapterPlacement,type GraphicPlacement,type Job,type JobClip,type MusicPlacement,type Segment,type TextPlacement,type TextVariant,isShotItem,BROLL_MAX,BROLL_MIN,FACE_GAP,SHOW_MAX,TRANSITION_SECONDS,speaking,syncOf} from './cut';
import type {FrameHost} from './frames';
import {defineTool,type ToolDef,type ToolResult} from './port';
import {ff} from './look';
import {drawPreview,previewShots,previewTimes,PREVIEW_MAX} from './preview';
import {changedMoments,CHANGED_MAX} from './changes';
import {legibilityWarnings,textSheet} from './legible';
import {faceWarnings} from './face-text';
import {readWarning} from './reading';
import {reviewCounts,reviewText} from './review';
import {noteReplies,REPLY_MAX,type NoteReply} from './notes';
import {cutGate,labelNotes,markLooked,markViewed,showGate,surveyTools} from './survey-tools';
import {contentBox,greyFrames,spreadTimes} from '../../screen';
import {loudnessLines,sfxLines,soundLookTools} from './sound-look';
import type {ClipRef,Grade,MotionTrack,Reframe,ReframeSpeed} from '@voxtale/editdoc';
import type {SfxPlacement} from './cut';
import {mediaTools} from './media-tools';
import {logoTools} from './logo-tools';
import {trackTools} from './track-tools';
import type {LogoPlacement} from './logo';
import type {Multicam} from './multicam';

export interface Workspace {
  dir:string;
  job:Job;
  segments:Segment[];
  placements:GraphicPlacement[];
  captions:CaptionSpan[];
  /** Lines to punch in on, by word span. */
  zooms:CaptionSpan[];
  broll:BrollPlacement[];
  text:TextPlacement[];
  chapters:ChapterPlacement[];
  /** Caption word fixes, by source time; every caption from the clip shows them. */
  wordFixes?:WordFix[];
  /** Where music comes in and drops out; absent = under the whole video. */
  music?:MusicPlacement;
  /** The creator chose the caption look on an earlier cut: the agent leaves it. */
  captionLookKept?:boolean;
  /** Graphic id → rendered alpha WebM, and where it sits on screen. */
  graphics:Record<string,{webm:string;seconds:number;place:GraphicItem['placement']}>;
  /** Scenes the agent wrote (write_scene): name → TSX source, gated and type-checked. */
  scenes?:Record<string,string>;
  doc?:EditDoc;
  finished?:{summary:string;problems:string[];noteReplies?:NoteReply[]};
  /** finish already asked once for the missing note replies. */
  notesAsked?:boolean;
  graphicsEnabled:boolean;
  /** Frames and graphic renders, from wherever the full files are. */
  frames:FrameHost;
  /** Finds the speaker's eyes at cut frames; results cached by clip and time. */
  eyes?:EyeFinder;
  /** Masks the speaker in a preview still, so watch_cut shows text behind them as the export does. */
  cutout?:(still:string,out:string)=>Promise<boolean>;
  eyeCache?:Map<string,Point|null>;
  /** Saves so far, and the save the agent last watched the cut at. */
  edits?:number;
  watchedAt?:number;
  /** The doc as watch_cut last showed it; watch_cut changed:true looks only where the edit differs from it. */
  seenDoc?:EditDoc;
  /** finish asked for a watch-down once already. */
  watchAsked?:boolean;
  /** Clips whose frames the agent has seen (survey_clips, timeline_view). */
  viewed?:Set<string>;
  /** Clips seen close: timeline_view (frames, waveform, words) over them. */
  looked?:Set<string>;
  /** Clips whose frames could not be read: the gates do not wait on them. */
  unseeable?:Set<string>;
  /** Look-first gates refused once already: clip ids, and '#cut' for set_cut. */
  viewAsked?:Set<string>;
  /** Grey frames per clip for camera movement, sampled once; null = could not be read. */
  motion?:Map<string,{every:number;frames:Uint8Array[]}|null>;
  /** Speech level of kept segments, dB, by clip and source span; null = could not be read. */
  levels?:Record<string,number|null>;
  /** Voice track of each speaking clip, by clip id; null = could not be read. */
  voices?:Map<string,Voice|null>;
  /** The edit as the creator left it (their items, locks), before this session's first save. */
  base?:EditDoc;
  /** Fields the creator set by hand, by item id; kept when the agent changes that item by name. */
  hand?:Record<string,string[]>;
  /** This call only: doc ids the agent names (may change a creator item) and removes by name. */
  named?:Set<string>;
  drop?:Set<string>;
  /** This call replaced the cut. */
  cutChanged?:boolean;
  /** What the last save kept of the creator's work and left out of the agent's. */
  lastKeep?:KeepReport;
  /** The agent's sound-effect hits (set_sfx); absent = code places them. */
  sfx?:SfxPlacement[];
  /** Peak time and level of the creator's effect files, by clip id. */
  sfxPeaks?:Record<string,{peak:number;levelDb:number}>;
  /** Colour grade by clip id (set_look). */
  grades?:Record<string,Grade>;
  /** Per clip id: colour space or input LUT (set_look) and A/V offset (set_av_offset), over what the open found. */
  clipSettings?:Record<string,Pick<ClipRef,'colorSpace'|'inputLut'|'avOffset'>>;
  /** Clips the open found recorded together, with their sound levels (project.json; not saved in state). */
  syncGroups?:Pick<Multicam,'groups'|'levels'|'step'>;
  /** Original source files by clip hash (not saved): set_av_offset measures these. */
  media?:Record<string,string>;
  /** The agent's camera/mic picks per word range, and auto picking (set_angles). */
  angles?:Pick<Multicam,'choices'|'auto'>;
  /** Standing rules proposed this edit, for the creator to decide. */
  proposedRules?:{text:string;said:string}[];
  /** The brand logo over the cut (place_logo): its clip, its file on this machine (a creator clip has none; its path is in media), where and when. */
  logo?:{ref:ClipRef;path?:string;items:LogoPlacement[]};
  /** Output frame shape (set_frame); absent = the main clip's shape. */
  frame?:{aspect:string;speed:ReframeSpeed};
  /** Auto reframe path by clip id (set_frame). */
  reframes?:Record<string,Reframe>;
  /** Livestream clips: source spans per clip id shown as webcam over game (live_layout). */
  stacks?:Record<string,StackSpan[]>;
  /** Motion tracks by text or graphic item id (track_title). */
  motionTracks?:Record<string,MotionTrack>;
}

/** The doc as the agent last wrote it, next to edit.json: a hand edit shows as a difference. */
export const AGENT_EDIT='agent-edit.json';

const png=(data:Uint8Array):ToolResult['images']=>[{data,mime:'image/png'}];
/** A caption preset in a few words, for the tool description. */
const describeLook=(s:(typeof CAPTION_PRESETS)[CaptionPresetId]['style'])=>[
  s.case==='upper'?'capitals':'',s.box==='line'?'on a box':s.strokeWidth>=6?'heavy outline':'light outline',
  {none:'still',highlight:'spoken word coloured',pop:'spoken word coloured and growing',pill:'coloured box behind the spoken word',karaoke:'words light up as said',word:'one word at a time'}[s.animation],
  `${s.maxWords} words a line`].filter(Boolean).join(', ');

const jpg=(data:Uint8Array):ToolResult['images']=>[{data,mime:'image/jpeg'}];

const eyeKey=(clip:string,t:number)=>`${clip}@${t.toFixed(2)}`;
const levelKey=(i:{clipId:string;in:number;out:number})=>`${i.clipId}@${i.in.toFixed(2)}-${i.out.toFixed(2)}`;

/** Measure the speech level of every a-roll item not measured yet. Returns how many gains differ from 0 after. */
export async function matchLevels(ws:Workspace):Promise<number> {
  if(!ws.doc||!ws.frames.audio)return 0;
  const levels=ws.levels??={};
  const todo=ws.doc.tracks['a-roll'].filter(i=>!isShotItem(i)&&!(levelKey(i) in levels));
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,todo.length)},async()=>{
    while(next<todo.length) {
      const i=todo[next++]!;
      try {
        const bytes=await ws.frames.audio!(clipOf(ws.job,i.clipId).ref.hash,i.in,Math.min(i.out,i.in+AUDIO_MAX_SECONDS));
        levels[levelKey(i)]=speechLevel(new Float32Array(bytes.buffer,bytes.byteOffset,Math.floor(bytes.byteLength/4)),AUDIO_RATE)??null;
      } catch {levels[levelKey(i)]=null;}
    }
  }));
  if(todo.length)await save(ws);
  return ws.doc.tracks['a-roll'].filter(i=>!isShotItem(i)&&i.gainDb!==0).length;
}

/** Look up the eyes on each a-roll item's first and last frame not seen yet; true when any were found. */
async function findEyes(ws:Workspace,doc:EditDoc):Promise<boolean> {
  if(!ws.eyes)return false;
  const cache=ws.eyeCache??=new Map();
  const want=new Map<string,number[]>();
  for(const i of doc.tracks['a-roll'].filter(i=>!isShotItem(i)))for(const t of [i.in,Math.max(i.in,i.out-0.05)]) {
    if(cache.has(eyeKey(i.clipId,t)))continue;
    cache.set(eyeKey(i.clipId,t),null);
    want.set(i.clipId,[...(want.get(i.clipId)??[]),t]);
  }
  let found=false;
  for(const [clip,times] of want) {
    const c=clipOf(ws.job,clip);
    const eyes=await ws.eyes(c.ref.hash,times).catch(()=>[] as (Point|null)[]);
    times.forEach((t,k)=>{const e=eyes[k];if(e){cache.set(eyeKey(clip,t),e);found=true;}});
  }
  return found;
}

export async function save(ws:Workspace):Promise<void> {
  const build=()=>buildCut(ws.job,ws.segments,{graphics:ws.placements.filter(p=>ws.graphics[p.shows??p.id]).map(p=>({...p,placement:ws.graphics[p.shows??p.id]!.place,
    ...(p.variants?{variants:p.variants.filter(v=>ws.graphics[v.id]).map(v=>({id:v.id,placement:ws.graphics[v.id]!.place}))}:{})})),captions:ws.captions,zooms:ws.zooms,broll:ws.broll,text:ws.text,chapters:ws.chapters,...(ws.music?{music:ws.music}:{}),...(ws.wordFixes?.length?{wordFixes:ws.wordFixes}:{}),
    ...(ws.sfx?{sfx:ws.sfx}:{}),...(ws.grades?{grades:ws.grades}:{}),...(ws.clipSettings?{clipSettings:ws.clipSettings}:{}),...(ws.syncGroups?{multicam:{...ws.syncGroups,...ws.angles}}:{}),...(ws.logo?{logo:{ref:ws.logo.ref,items:ws.logo.items}}:{}),
    ...(ws.frame?{frame:{aspect:ws.frame.aspect}}:{}),...(ws.reframes?{reframes:ws.reframes}:{}),...(ws.stacks?{stacks:ws.stacks}:{}),...(ws.motionTracks?{motionTracks:ws.motionTracks}:{}),
    eyesAt:(clip,t)=>ws.eyeCache?.get(eyeKey(clip,t))??undefined,
    edge:(clip,t,side,limit,other)=>{const v=ws.voices?.get(clip);return v?wordEdge(v,t,side,limit,other):t;},
    quiet:(clip,t,side,limit)=>{const v=ws.voices?.get(clip);return v?quietTo(v,t,side,limit):limit;}});
  await loadVoices(ws);
  const prev=ws.doc??ws.base;
  let built=build();
  // Zoom aims by the eyes on the frames each side of a cut, so build once more when new ones come in.
  if(await findEyes(ws,built))built=build();
  ws.edits=(ws.edits??0)+1;
  // Segments measured so far play at one level; the rest wait for finish. Placed shots keep their own level.
  const aroll=built.tracks['a-roll'].filter(i=>!isShotItem(i));
  levelGains(aroll.map(i=>ws.levels?.[levelKey(i)]??undefined)).forEach((g,k)=>{aroll[k]!.gainDb=g;});
  // The creator's own items and locked tracks, laid back over the build.
  const named=ws.named;
  const kept=keepCreatorItems(prev,built,{...(named?{named:(id:string)=>named.has(id)||[...named].some(n=>n.endsWith('-')&&id.startsWith(n))}:{}),
    ...(ws.drop?{drop:ws.drop}:{}),...(ws.hand?{hand:ws.hand}:{}),cutChanged:!prev||!!ws.cutChanged});
  ws.doc=kept.doc;
  ws.lastKeep=kept.report;
  await writeFile(join(ws.dir,'edit.json'),JSON.stringify(ws.doc,null,1));
  await writeFile(join(ws.dir,AGENT_EDIT),JSON.stringify(ws.doc));
  await writeFile(join(ws.dir,'state.json'),JSON.stringify({levels:ws.levels,segments:ws.segments,placements:ws.placements,captions:ws.captions,zooms:ws.zooms,broll:ws.broll,text:ws.text,chapters:ws.chapters,music:ws.music,wordFixes:ws.wordFixes,graphics:ws.graphics,finished:ws.finished,hand:ws.hand,
    sfx:ws.sfx,sfxPeaks:ws.sfxPeaks,grades:ws.grades,clipSettings:ws.clipSettings,angles:ws.angles,proposedRules:ws.proposedRules,logo:ws.logo??null,
    frame:ws.frame??null,reframes:ws.reframes??null,stacks:ws.stacks??null,motionTracks:ws.motionTracks??null},null,1));
}

/** Read the voice track of every speaking clip not read yet. A host that cannot gives none: the editor works from words alone. */
async function loadVoices(ws:Workspace):Promise<void> {
  const voices=ws.voices??=new Map();
  await Promise.all(ws.job.clips.filter(c=>speaking(c)&&c.ref.hasAudio&&!voices.has(c.ref.id)).map(async c=>{
    voices.set(c.ref.id,null);
    if(!ws.frames.voice)return;
    try {voices.set(c.ref.id,voiceOf(await ws.frames.voice(c.ref.hash)));} catch {/* stays null */}
  }));
}

/** A recording of a screen: by its role, or by what the index saw in it. */
const isScreen=(c:JobClip)=>c.ref.role==='screen'||(c.index?.segments.some(s=>s.shotType==='screen')??false);

/** The page inside the bars of a screen recording, over the source stretches a shot shows. */
async function screenContent(ws:Workspace,c:JobClip,spans:[number,number][]) {
  const jpegs=await ws.frames.frames(c.ref.hash,spreadTimes(spans),640);
  return contentBox(await greyFrames(jpegs,join(ws.dir,'screen',String(ws.edits??0)),ff));
}

/** What a viewer hears go wrong at each cut in the speech, from the voice tracks. */
function joinSounds(ws:Workspace):string[] {
  const items=ws.doc?.tracks['a-roll']??[],out:string[]=[];
  for(let k=1;k<items.length;k++) {
    const p=items[k-1]!,i=items[k]!;
    if(p.clipId===i.clipId&&Math.abs(i.in-p.out)<0.02)continue;
    const last=clipOf(ws.job,p.clipId).words.filter(w=>w.start<p.out).at(-1);
    const notes=joinSound({voice:ws.voices?.get(p.clipId)??undefined,t:p.out,ends:!last||/[.?!]$/.test(last.text)},{voice:ws.voices?.get(i.clipId)??undefined,t:i.in});
    if(notes.length)out.push(`@${i.start.toFixed(1)}s: ${notes.join('; ')}`);
  }
  return out;
}

/** The logo clip's image on this machine, for watch_cut stills: the brand-kit file, else the creator's clip. */
function logoFile(ws:Workspace,clipId:string):string|undefined {
  const l=ws.logo;
  return l&&l.ref.id===clipId?l.path??ws.media?.[l.ref.hash]:undefined;
}

/** watch_cut changed:true: frames only where the edit differs from the last watch, text drawn, legibility measured. */
async function watchChanged(ws:Workspace,doc:EditDoc):Promise<ToolResult> {
  const seen=ws.seenDoc,moments=changedMoments(seen,doc);
  if(!moments.length)return {text:seen?'Nothing on screen changed since you last watched.':'Nothing to show yet.'};
  const hashOf=(id:string)=>{const c=ws.job.clips.find(x=>x.ref.id===id);return c&&c.ref.kind!=='audio'?c.ref.hash:undefined;};
  const shots=previewShots(doc,moments.map(m=>m.t),hashOf,id=>ws.graphics[id]?.webm,id=>logoFile(ws,id));
  const tall=doc.canvas.height>doc.canvas.width,width=tall?360:640;
  const size={width,height:Math.round(width*doc.canvas.height/doc.canvas.width/2)*2};
  const dir=join(ws.dir,'preview',`changed-${ws.edits??0}`);
  const bare=await drawPreview({shots,canvas:doc.canvas,frames:ws.frames,dir,ff,width,...(ws.cutout?{cutout:ws.cutout}:{})});
  // Text is drawn with libass; an ffmpeg without it still shows the frames, unchecked.
  const drawn=await textSheet({ff,doc,times:moments.map(m=>m.t),dir,size}).catch((e:Error)=>e);
  const sheet=drawn instanceof Error?bare:drawn.sheet,rows=drawn instanceof Error?[]:drawn.rows;
  // A full watch earlier plus this one covers every change.
  if(seen&&ws.watchedAt!==undefined)ws.watchedAt=ws.edits;
  ws.seenDoc=doc;
  const warn=[...legibilityWarnings(rows),...faceWarnings(doc,rows,(clip,at)=>{const c=ws.job.clips.find(x=>x.ref.id===clip);return c&&faceAt(c,at);})];
  const measured=rows.map(r=>`${r.t.toFixed(1)}s ${r.label}: ${r.m.text} on ${r.m.behind} = ${r.m.ratio.toFixed(1)}:1`);
  return {text:[`${moments.length} changed moment(s)${seen?'':' (first watch: everything counts)'}, left to right then down, text drawn:`,
    ...moments.map((m,k)=>`${k+1}. ${m.t.toFixed(1)}s: ${m.why} | on screen: ${shots[k]!.notes.join(' + ')}`),
    ...(measured.length?['text contrast:',...measured.map(x=>`- ${x}`)]:[]),
    ...(drawn instanceof Error?[`text not drawn or checked here (${drawn.message.slice(0,160)}): judge it in the app`]
      :warn.length?['WARNINGS:',...warn.map(x=>`- ${x}`)]:['no text warnings']),
  ].join('\n'),images:jpg(sheet)};
}

function report(ws:Workspace):string {
  if(!ws.doc)return 'No cut yet.';
  const c=checkCut(ws.job,ws.doc,ws.segments,ws.doc.tracks.graphics.length,(clip,t)=>ws.eyeCache?.get(eyeKey(clip,t))??undefined);
  const heard=joinSounds(ws);
  const edges=cutSound(ws.job,ws.doc,ws.segments,(clip,a,b)=>{const v=ws.voices?.get(clip);return v?speechIn(v,a,b):0;});
  const screen=screenSummary(ws.job,ws.doc);
  const close=afterClose(ws.job,ws.doc);
  return [`metrics: ${JSON.stringify(c.metrics)}`,
    c.problems.length?`problems (${c.problems.length}):\n- ${c.problems.join('\n- ')}`:'problems: none found by the checks (they do not judge story or pace feel)',
    `joins:\n${c.joins.join('\n')}`,
    ...(heard.length?[`sound at joins (move the cut a word, keep or drop the breath, or pick a take that matches):\n- ${heard.join('\n- ')}`]:[]),
    ...(edges.tight.length?[`tight joins (the source still sounds at the cut; fine inside a run of speech, a clipped word if not: listen, or cut a word earlier or later):\n- ${edges.tight.join('\n- ')}`]:[]),
    ...(edges.stillHeard.length?[`cut words still heard (the padding plays part of them; end the segment a word earlier or start it a word later, or set pace fast there):\n- ${edges.stillHeard.join('\n- ')}`]:[]),
    ...(close?[`after the close the source goes on (a closing line or resolution cut off by seconds? extend the last segment unless the brief holds it back):\n- ${close}`]:[]),
    ...(screen.length?[`footage recorded with the speaker (screen_activity lists each change and its word):\n- ${screen.join('\n- ')}`]:[]),
    ...(c.jumps.length?[`visible jumps (cover with footage or a graphic, punch in on the line, or cut at a point where the head is still):\n- ${c.jumps.join('\n- ')}`]:[]),
    ...sfxLines(ws,ws.doc),...loudnessLines(ws,ws.doc)].join('\n');
}

const transitionField=z.object({
  kind:z.enum(TRANSITION_KINDS).describe('crossfade = one picture dissolves into the next; dip-black / dip-white = fade to the colour and back; whip = both pictures slide sideways with a blur; zoom = scale into the cut and back out'),
  seconds:z.number().min(0.2).max(1).optional().describe(`length, centred on the join; default ${TRANSITION_SECONDS}. Code rounds to an even number of frames`),
}).strict().optional().describe('a transition INTO this segment from the one before it; leave out for a hard cut (the default, and right for most joins). Sound still cuts straight');
const audioLead=z.number().positive().max(2).optional().describe('J-cut: seconds this segment\'s voice starts before its picture, under the end of the segment before. Code trims it to the footage there');
const audioLag=z.number().positive().max(2).optional().describe('L-cut: seconds this segment\'s voice runs on after its picture, under the start of the next segment. Code trims it to the footage there');
const fadeField=z.object({
  in:z.number().min(0.1).max(5).optional().describe('seconds the picture fades in from black (or from what is under it)'),
  out:z.number().min(0.1).max(5).optional().describe('seconds it fades out at its end'),
}).strict().optional().describe('picture fade at this item\'s start and/or end: an opening, a closing, a soft entrance. Leave out for most items. Sound is unchanged');
const segmentSchema=z.object({
  clip:z.string().describe('clip id, e.g. "c1"'),
  from:z.number().int().describe('first kept word id (inclusive)'),
  to:z.number().int().describe('last kept word id (inclusive)'),
  note:z.string().max(200).optional().describe('why this stays (beat / role)'),
  pace:z.enum(['fast','normal','slow']).optional().describe('how tight this stretch runs: fast = sentences run together, short pauses trimmed; slow = pauses up to 1s stay, more breath at the edges; default normal (the style)'),
  hold:z.number().min(0).max(2).optional().describe('seconds of the pause after the last word to keep: a beat for a punchline or before a turn. Code keeps what silence the source has there'),
  teaser:z.boolean().optional().describe('a cold open lifted from later in the video; its words may play again in place'),
  transition:transitionField,
  audioLead,audioLag,
  fade:fadeField,
});
const shotSchema=z.object({
  clip:z.string().describe('clip id of any video clip: speaking or not (a silent shot, music-only, ambient)'),
  in:z.number().min(0).optional().describe('source second to start at; default 0'),
  out:z.number().positive().optional().describe('source second to end at; default the clip\'s end'),
  audio:z.enum(['keep','mute']).optional().describe('keep (default) plays the clip\'s own sound; mute silences it, so music plays under it at full level'),
  note:z.string().max(200).optional().describe('why this stays (beat / role)'),
  transition:transitionField,
  audioLead,audioLag,
  fade:fadeField,
}).strict();

/** Change workspace state and rebuild; on a build error, put it back. */
export async function change(ws:Workspace,f:()=>void,o:{named?:string[];drop?:string[]}={}):Promise<void> {
  const before={segments:ws.segments,placements:ws.placements,captions:ws.captions,zooms:ws.zooms,broll:ws.broll,text:ws.text,chapters:ws.chapters,music:ws.music,wordFixes:ws.wordFixes,sfx:ws.sfx,grades:ws.grades,clipSettings:ws.clipSettings,angles:ws.angles,frame:ws.frame,reframes:ws.reframes,stacks:ws.stacks,motionTracks:ws.motionTracks};
  f();
  ws.cutChanged=JSON.stringify(before.segments)!==JSON.stringify(ws.segments);
  ws.named=o.named?.length?new Set(o.named):undefined;
  ws.drop=o.drop?.length?new Set(o.drop):undefined;
  try {await save(ws);} catch(e) {Object.assign(ws,before);throw e;}
  finally {ws.cutChanged=false;ws.named=undefined;ws.drop=undefined;}
}

/** Each tool's result says what of the creator's work its saves kept, and what of the agent's they left out. */
function withKeepNotes(ws:Workspace,t:ToolDef<any>):ToolDef<any> {
  return {...t,run:async(input:any)=>{
    ws.lastKeep=undefined;
    const r=await t.run(input);
    const note=ws.lastKeep?keepText(ws.lastKeep):'';
    return note?{...r,text:`${r.text}\n\n${note}`}:r;
  }};
}

/** Template place -> graphic item placement. */
const ITEM_PLACE={full:'full',left:'left',right:'right',lower:'bottom',top:'top',center:'center'} as const;

export function editorTools(ws:Workspace):ToolDef<any>[] {
  // Graphics render at the canvas size, the speaker's frame; another clip's size gets stretched onto it.
  const canvas=()=>(ws.job.clips.find(speaking)??ws.job.clips[0]!).ref;
  async function renderInto(id:string,html:string,seconds:number,c:Job['clips'][number],t:number,face:Face|undefined,stills:number[],place:GraphicItem['placement'],scene?:SceneJob) {
    const ref=canvas(),width=ref.width??1920,brand=ws.job.styleUse?.graphics;
    const r=await ws.frames.graphic({id,html:withMotionKit(html),kitCss:kitCss(width,face)+(brand?.css?`\n/* brand */\n${brand.css}`:''),
      width,height:ref.height??1080,seconds,stills,backdrop:{clip:c.ref.hash,t:t+0.3},...(brand?.files.length?{files:brand.files}:{}),...(scene?{scene}:{})});
    if(r.ok&&r.webm){ws.graphics[id]={webm:r.webm,seconds,place};await save(ws);}
    else delete ws.graphics[id];
    return {text:`${r.ok?'rendered':'FAILED'} ${id}\n${r.report}${r.ok?`\nstills at ${stills.map(x=>x.toFixed(1)).join(', ')}s, over the speaker`:''}`,
      ...(r.sheet?{images:jpg(r.sheet)}:{}),isError:!r.ok};
  }

  const tools:ToolDef<any>[]=[
    defineTool({name:'get_transcript',description:'Word-timed transcript of a clip, one phrase per line: [firstId-lastId start-end] text. Pauses are marked. Words the speaker leans on (louder, higher, longer than the words around them, measured from the sound) are marked *so*. After it: lines said more than once, each take with its word ids and how it was said, and words said twice back to back (stutters, restarts). Cut by word id.',
      input:{clip:z.string().optional().describe('clip id; omit for all clips')},
      run:async({clip})=>{
        await loadVoices(ws);
        return {text:(clip?[clipOf(ws.job,clip)]:ws.job.clips.filter(speaking)).map(c=>{
          const v=ws.voices?.get(c.ref.id)??undefined;
          const again=retakeText(findRetakes(c.words,v)),twice=saidTwice(c.words);
          const fixes=(ws.wordFixes??[]).filter(f=>f.clipId===c.ref.id).flatMap(f=>{const w=fixedWord(c.words.map(x=>({...x,clipId:c.ref.id})),f);return w?[`${w.id} "${w.text}" -> "${f.text}"`]:[];});
          return packTranscript(c,undefined,v?stressedWords(v,c.words):undefined)+(fixes.length?`\n\nCaption fixes (fix_word): ${fixes.join(', ')}`:'')+(again?`\n\nSaid more than once in ${c.ref.id} (keep one take of each; a take cut off mid-line is a false start):\n${again}`:'')
            +(twice.length?`\n\nSaid twice back to back in ${c.ref.id} (likely a stutter or restart; usually cut the first):\n${twice.join('\n')}`:'');
        }).join('\n\n')};
      }}),

    defineTool({name:'find_footage',description:'What the footage shows. Clips with moments: every visible change, at the second, with what changed, on-screen text and subjects (a screen recording turning to a chart, a new page, a drawing stroke). Others: shot segments from the clip index. Optional query keeps entries sharing a word with it (e.g. "bell curve chart"); start/end keep a window of source seconds. "said" turns it round: give a stretch of the spoken words and get the footage ranked by how much of what is said it shows, rare words counting most. Clips recorded together share a clock: the moment at a speaker\'s word time is what was on that clip while the word was said. Confirm a pick with timeline_view.',
      input:{clip:z.string().optional(),query:z.string().max(200).optional(),start:z.number().min(0).optional(),end:z.number().positive().optional(),
        said:z.object({clip:z.string(),from:z.number().int(),to:z.number().int()}).optional().describe('rank footage against what the speaker says over these word ids')},
      run:async({clip,query,start,end,said})=>{
        const clips=clip?[clipOf(ws.job,clip)]:ws.job.clips;
        if(!said)return {text:footageText(clips,{query,start,end},ws.job)+labelNotes(ws,clips)};
        const v=clipOf(ws.job,said.clip),text=v.words.filter(w=>w.id>=said.from&&w.id<=said.to).map(w=>w.text).join(' ');
        if(!text)throw new Error(`${said.clip} has no words ${said.from}-${said.to}`);
        const ws0=v.words.filter(w=>w.id>=said.from&&w.id<=said.to);
        // Footage recorded with the speaker: what it showed at those seconds is the match, whatever the words.
        const live=shownMeanwhile(ws.job,said.clip,ws0[0]!.start,ws0.at(-1)!.end);
        const synced=new Set((ws.job.sync??[]).filter(s=>s.with===said.clip).map(s=>s.clip));
        return {text:[...live,rankText(rankFootage(clips.filter(c=>!speaking(c)&&!(live.length&&synced.has(c.ref.id))),`${text} ${query??''}`),text)].join('\n')};
      }}),

    defineTool({name:'screen_activity',description:'For a clip recorded with the speaker (a screen, a second camera): every change on it that happens while words you kept are said, at its second of the cut, with the word and whether the cut shows that clip then. Run it after set_cut to choose where to cut to the screen: start show_footage (sync:true) on the word at a change the speaker is talking about, and come back to the speaker when the screen goes still. Also lists shots sitting on a still picture.',
      input:{},
      run:async()=>{
        if(!ws.doc)throw new Error('set a cut first');
        return {text:screenActivity(ws.job,ws.doc)};
      }}),

    defineTool({name:'timeline_view',description:'Look at a stretch of SOURCE footage of any clip (speaking or b-roll): 8 frames across [start,end] over the audio waveform, the first at start and the last the final frame before end, plus the words spoken there. Use at decision points (retakes, gestures, where the speaker looks), not for every line.',
      input:{clip:z.string(),start:z.number().min(0),end:z.number().positive()},
      run:async({clip,start,end})=>{
        const c=clipOf(ws.job,clip);
        if(end<=start)throw new Error('end must be after start');
        const to=Math.min(end,c.ref.duration);
        if(to<=start)throw new Error(`${clip} is ${c.ref.duration.toFixed(2)}s long: start before that`);
        const img=await ws.frames.filmstrip(c.ref.hash,start,to).catch(e=>{(ws.unseeable??=new Set()).add(clip);throw e;});
        markViewed(ws,clip);markLooked(ws,clip);
        const words=c.words.filter(w=>w.end>start&&w.start<end).map(w=>`${w.id}:${w.text}@${w.start.toFixed(2)}`).join(' ');
        const at=stripTimes(start,to).map(t=>t.toFixed(2));
        return {text:`frames at ${at.join(', ')}s (first = the frame at ${at[0]}s, last = the final frame before ${at.at(-1)}s)\nwords: ${words}`,images:png(img)};
      }}),

    defineTool({name:'set_cut',description:'Replace the whole cut with these segments, in play order. A spoken segment keeps words from..to of a speaking clip; code pads to word edges. pace and hold set the rhythm: how tight a stretch runs and where a line gets a beat. A shot segment (in/out instead of from/to) places a video clip, or source seconds of it, as its own stretch of the cut, speech or not: a silent shot, music-only or ambient footage, between or among spoken segments, with its own sound kept or muted. Footage over the voice is show_footage instead. Returns metrics, problems the checks found, every join as text with the gap a viewer hears, tight joins (no silence at the cut) and cut words still heard, what the source says in the 10s after the cut ends, and joins where the speaker visibly jumps.',
      input:{segments:z.array(z.union([segmentSchema,shotSchema])).min(1).max(200),
        unsure:z.array(z.string()).max(40).optional().describe('Clips (talk or footage) whose place you are not sure of, or that could swap with another. Each must have had a timeline_view over its whole length before the cut is accepted.')},
      run:async({segments,unsure})=>{
        const policy=(ws.doc??ws.base)?.policy['a-roll'];
        if(policy==='locked'||policy==='off')throw new Error('the creator locked the cut: it stays as they left it. Work on the other tracks');
        cutGate(ws,segments.map(s=>({clip:s.clip,shot:!('from' in s),...(s.note?{note:s.note}:{})})),unsure??[]);
        await change(ws,()=>{ws.segments=segments;});
        await loadVoices(ws);
        return {text:report(ws)};
      }}),

    defineTool({name:'set_captions',description:'Replace the caption spans. Only these words get captions (an editable caption track, not burnt into the picture): the hook and the few lines that carry the main ideas, not the whole video. Spans follow their words through recuts; words not in the cut are skipped. Empty list = no captions.',
      input:{spans:z.array(z.object({
        clip:z.string(),from:z.number().int().describe('first word id (inclusive)'),to:z.number().int().describe('last word id (inclusive)'),
        why:z.string().max(120).optional().describe('hook / key idea / number …'),
      })).max(30),
      look:z.enum(CAPTION_PRESET_IDS as [CaptionPresetId,...CaptionPresetId[]]).optional().describe(`how captions look: ${Object.entries(CAPTION_PRESETS).map(([id,p])=>`${id} (${describeLook(p.style)})`).join('; ')}. Omit to keep the current look`)},
      run:async({spans,look})=>{
        if(!ws.segments.length)throw new Error('set a cut first');
        if(look&&ws.captionLookKept)throw new Error('the creator chose the caption look on the last cut; call again without look');
        const style=ws.job.style;
        try {
          if(look)ws.job.style={...style,brand:{...style.brand,captionStyle:withCaptionPreset(style.brand.captionStyle,look)}};
          await change(ws,()=>{ws.captions=spans;});
        } catch(e){ws.job.style=style;throw e;}
        const caps=ws.doc!.tracks.captions;
        return {text:caps.length?`${caps.length} caption lines, ${caps.reduce((n,c)=>n+c.end-c.start,0).toFixed(1)}s:\n${caps.map(c=>`${c.start.toFixed(1)}-${c.end.toFixed(1)}s ${c.text}`).join('\n')}`:'no captions in the cut'};
      }}),

    defineTool({name:'set_zooms',description:`Replace the punch-ins. Only these lines zoom in on the speaker: the few that carry the video — the thesis, a number, a punchline, a turn in the argument. A zoom is stress; on every other line it is a tic. Code frames the face and holds the zoom for the line; none while a graphic is up. Jump cuts stay wide. Empty list = no zooms.`,
      input:{spans:z.array(z.object({
        clip:z.string(),from:z.number().int().describe('first word id (inclusive)'),to:z.number().int().describe('last word id (inclusive)'),
        why:z.string().max(120).describe('what the line stresses'),
        kind:z.enum(['punch','push']).optional().describe('punch (default): cuts in and holds, for a line that hits. push: moves in slowly over the line, for one that builds or turns quiet; needs a stretch of a few seconds'),
        curveIn:z.enum(ZOOM_CURVES).optional().describe('shape of the move in: smooth (default) slow-fast-slow; linear even; snap fast then lands soft; build slow then fast; settle overshoots a touch and comes back; hold stays wide, then cuts. A punch given a curve moves in over a short ease instead of cutting'),
        curveOut:z.enum(ZOOM_CURVES).optional().describe('shape of the move back out, same names; hold = stay in, then cut back'),
      })).max(200)},
      run:async({spans})=>{
        if(!ws.segments.length)throw new Error('set a cut first');
        for(const s of spans) {
          const c=clipOf(ws.job,s.clip),a=c.words.find(w=>w.id===s.from),b=c.words.find(w=>w.id===s.to);
          if(!a||!b||b.id<a.id)throw new Error(`no words ${s.from}-${s.to} in ${s.clip}`);
        }
        await change(ws,()=>{ws.zooms=spans;});
        const zs=ws.doc!.tracks.zoom.filter(z=>/ on a key line/.test(z.reason??''));
        return {text:zs.length?`${zs.length} zoomed stretches:\n${zs.map(z=>`${z.start.toFixed(1)}-${z.end.toFixed(1)}s ${z.reason}`).join('\n')}`:'no zooms in the cut (lines cut, or under a graphic)'};
      }}),

    defineTool({name:'fix_word',description:'Put right a word the transcript got wrong (a name, a product, a misheard word), once: every caption from that clip shows the fix, through any recut. Cut and search still use word ids as before. The original text again removes the fix.',
      input:{clip:z.string(),word:z.number().int().describe('word id from get_transcript'),text:z.string().trim().min(1).max(60).describe('what the speaker said, as it should read in captions')},
      run:async({clip,word,text})=>{
        const c=clipOf(ws.job,clip);
        const w=c.words.find(x=>x.id===word);
        if(!w)throw new Error(`no word ${word} in ${clip}`);
        const same=(f:WordFix)=>f.clipId===clip&&fixedWord([{clipId:clip,start:w.start,end:w.end}],f)!==undefined;
        const rest=(ws.wordFixes??[]).filter(f=>!same(f));
        const undo=text===w.text;
        await change(ws,()=>{ws.wordFixes=undo?rest:[...rest,{clipId:clip,at:w.start,text}];});
        const shown=(ws.doc?.tracks.captions??[]).filter(x=>x.words.includes(`${clip}:${word}`)).length;
        return {text:undo?`${clip}:${word} back to "${w.text}"`:`${clip}:${word} "${w.text}" -> "${text}"; ${shown?`${shown} caption${shown>1?'s':''} show it`:'no caption shows that word yet'}`};
      }}),
    defineTool({name:'set_chapters',description:'Replace the chapters: the sections of the video, each starting on a spoken word. They become the chapter list, and with several music tracks each chapter gets its own. A chapter whose word is cut is dropped. Empty list = no chapters.',
      input:{chapters:z.array(z.object({clip:z.string(),word:z.number().int().describe('first word of the section'),title:z.string().min(1).max(100)})).max(40)},
      run:async({chapters})=>{
        if(!ws.segments.length)throw new Error('set a cut first');
        for(const c of chapters)if(!clipOf(ws.job,c.clip).words.some(w=>w.id===c.word))throw new Error(`no word ${c.word} in ${c.clip}`);
        await change(ws,()=>{ws.chapters=chapters;});
        const ms=ws.doc!.markers.filter(m=>m.kind==='chapter');
        return {text:ms.length?`${ms.length} chapters:\n${ms.map(m=>`${m.time.toFixed(1)}s ${m.title}`).join('\n')}`:'no chapters in the cut'};
      }}),

    defineTool({name:'set_music',description:'Shape the music the creator gave (code picks tracks, levels and fades). `from`: the word the music comes in on, e.g. the first word after the hook; leave out to play from the start. `in`: the second of the TRACK to start playing from; default where the track comes alive (code finds it), so a long quiet intro is skipped. `drops`: lines the music leaves bare, so they land in silence; it fades out before and back in after. Use drops for the one or two lines that matter most. Call with nothing to put music back under the whole video. The result gives each track\'s tempo and how firm its beat is: on a firm beat code starts footage, graphics and text on it; on a weak one nothing snaps.',
      input:{from:z.object({clip:z.string(),word:z.number().int()}).optional(),
        in:z.number().min(0).optional().describe('seconds into the first music track to start from'),
        drops:z.array(z.object({clip:z.string(),from:z.number().int(),to:z.number().int()})).max(12).optional()},
      run:async({from,in:at,drops})=>{
        if(!ws.segments.length)throw new Error('set a cut first');
        if(!ws.job.clips.some(c=>c.ref.role==='music'))throw new Error('the creator gave no music');
        const has=(clip:string,word:number)=>{if(!clipOf(ws.job,clip).words.some(w=>w.id===word))throw new Error(`no word ${word} in ${clip}`);};
        if(from)has(from.clip,from.word);
        for(const d of drops??[]){has(d.clip,d.from);has(d.clip,d.to);}
        const first=ws.job.clips.find(c=>c.ref.role==='music')!;
        if(at!==undefined&&at>=first.ref.duration-2)throw new Error(`in ${at}s: ${first.ref.name} is ${first.ref.duration.toFixed(1)}s long`);
        await change(ws,()=>{ws.music=from||drops?.length||at!==undefined?{...(from?{from}:{}),...(drops?.length?{drops}:{}),...(at!==undefined?{in:at}:{})}:undefined;});
        const ms=ws.doc!.tracks.music;
        const beat=[...new Set(ms.map(m=>m.clipId))].map(id=>{
          const r=clipOf(ws.job,id).ref,b=r.beats;
          if(!b)return `${r.name}: no steady beat; nothing snaps`;
          const firm=b.confidence===undefined||b.confidence>=BEAT_CONFIDENCE_MIN;
          return `${r.name}: ${b.bpm} bpm, beat ${b.confidence===undefined?'not rated':`confidence ${b.confidence}`}${b.livelyFrom!==undefined?`, comes alive at ${b.livelyFrom}s`:''}: ${firm?'picture changes start on the beat':'weak beat, did not snap'}`;
        });
        return {text:ms.length?`music plays:\n${ms.map(m=>`${m.start.toFixed(1)}-${m.end.toFixed(1)}s ${clipOf(ws.job,m.clipId).ref.name} from ${m.in.toFixed(1)}s of the track`).join('\n')}\n${beat.join('\n')}`:'no music in the cut'};
      }}),

    defineTool({name:'compare_takes',description:'How each take of a line was said, measured from its sound: length, pace, level, pitch, how much the voice moves, whether it ends falling or rising, longest pause. Give 2-6 word spans (takes of one line, or lines you are weighing). Numbers describe, they do not pick: a take that ends falling sounds finished, one that trails up or stalls mid-line usually is not; more pitch movement and level is more energy. Read the words too.',
      input:{takes:z.array(z.object({clip:z.string(),from:z.number().int().min(0).describe('first word id'),to:z.number().int().min(0).describe('last word id')})).min(1).max(6)},
      run:async({takes})=>{
        if(!ws.frames.audio)throw new Error('clip sound cannot be read here: choose by the words and timeline_view');
        const rows=await Promise.all(takes.map(async(t,k)=>{
          const c=clipOf(ws.job,t.clip),words=c.words.filter(w=>w.id>=t.from&&w.id<=t.to);
          if(!words.length)throw new Error(`take ${k+1}: no words ${t.from}-${t.to} in ${t.clip}`);
          const start=words[0]!.start,end=words.at(-1)!.end;
          if(end-start>AUDIO_MAX_SECONDS)throw new Error(`take ${k+1}: longer than ${AUDIO_MAX_SECONDS}s; compare a line, not a passage`);
          const raw=await ws.frames.audio!(c.ref.hash,start,end);
          const samples=new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+Math.floor(raw.byteLength/4)*4));
          if(samples.length<AUDIO_RATE/10)throw new Error(`take ${k+1}: no sound at ${start.toFixed(1)}s in ${t.clip}`);
          return {label:`take ${k+1} [${t.clip} ${t.from}-${t.to}, ${start.toFixed(1)}s]`,text:words.map(w=>w.text).join(' '),d:deliveryOf(samples,AUDIO_RATE,words)};
        }));
        return {text:deliveryTable(rows)};
      }}),

    defineTool({name:'check_cut',description:'Deterministic checks on the current cut: length vs target, short segments, kept pauses, repeated phrases (leftover retakes), reused words, pace numbers.',
      input:{},run:async()=>{
        await loadVoices(ws);
        const review=ws.doc?`\n${reviewText(reviewCounts(ws.doc,id=>clipOf(ws.job,id).words))}`:'';
        return {text:report(ws)+review};
      }}),

    defineTool({name:'view_joins',description:'Frame before and after each join (up to 8 per call, from the given join index), one row per join. Use to catch jump cuts that look bad and mid-gesture cuts.',
      input:{from:z.number().int().min(0).default(0)},
      run:async({from=0})=>{
        if(!ws.doc)throw new Error('set a cut first');
        const items=ws.doc.tracks['a-roll'].slice(from,from+9);
        const hash=(clipId:string)=>clipOf(ws.job,clipId).ref.hash;
        const img=await ws.frames.joins(items.slice(1).map((b,k)=>({a:{clip:hash(items[k]!.clipId),t:Math.max(0,items[k]!.out-0.05)},b:{clip:hash(b.clipId),t:b.in+0.05}})));
        return {text:`rows = joins ${from+1}…${from+Math.min(8,items.length-1)} (left: end of outgoing segment, right: start of next)`,images:jpg(img)};
      }}),

    defineTool({name:'watch_cut',description:`Watch the edit as a viewer will see it: up to ${PREVIEW_MAX} frames of the OUTPUT timeline across [start,end] (default the whole video), layers stacked as the render stacks them: speaker with its zoom, shown footage with crop and speed, the corner speaker, graphics. Each frame comes with what is on screen and the words heard there. Captions and template text are listed, not drawn. Use before finish, and on any stretch you changed a lot: look for a shot that hides what the line is about, a graphic over the face, a crop that misses the subject, the same picture held too long, a gap. changed:true instead shows only what changed since you last watched (up to ${CHANGED_MAX} frames: new or changed framing and zooms first, then each text card and graphic just after it enters, then the captions mid-line), with text and captions drawn, and measures each one: text under 3:1 contrast with what is behind it, or inside the safe margin at the frame edge, comes back as a warning.`,
      input:{start:z.number().min(0).optional().describe('output seconds'),end:z.number().positive().optional(),frames:z.number().int().min(2).max(PREVIEW_MAX).default(PREVIEW_MAX),
        changed:z.boolean().optional().describe('only the moments that changed since the last watch, text drawn and checked')},
      run:async({start=0,end,frames=PREVIEW_MAX,changed})=>{
        if(!ws.doc)throw new Error('set a cut first');
        const doc=ws.doc,total=Math.max(0,...doc.tracks['a-roll'].map(i=>i.end));
        if(changed)return watchChanged(ws,doc);
        const to=Math.min(end??total,total);
        if(to<=start)throw new Error(`the cut runs 0-${total.toFixed(1)}s`);
        const hashOf=(id:string)=>{const c=ws.job.clips.find(x=>x.ref.id===id);return c&&c.ref.kind!=='audio'?c.ref.hash:undefined;};
        const shots=previewShots(doc,previewTimes(start,to,frames),hashOf,id=>ws.graphics[id]?.webm,id=>logoFile(ws,id));
        const img=await drawPreview({shots,canvas:doc.canvas,frames:ws.frames,dir:join(ws.dir,'preview',String(ws.edits??0)),ff,...(ws.cutout?{cutout:ws.cutout}:{})});
        if(start<=0.01&&to>=total-0.01)ws.watchedAt=ws.edits;
        ws.seenDoc=doc;
        const heard=(t:number)=>{
          const a=doc.tracks['a-roll'].find(i=>i.start<=t&&t<i.end);
          if(!a)return '';
          const src=a.in+(t-a.start);
          return clipOf(ws.job,a.clipId).words.filter(w=>w.end>src-0.6&&w.start<src+1.2&&w.start>=a.in-0.05&&w.end<=a.out+0.05).map(w=>w.text).join(' ');
        };
        return {text:`${shots.length} frames, left to right then down, of ${start.toFixed(1)}-${to.toFixed(1)}s of ${total.toFixed(1)}s:\n${shots.map((s,k)=>`${k+1}. ${s.t.toFixed(1)}s: ${s.notes.join(' + ')} | "${heard(s.t)}"`).join('\n')}`,images:jpg(img)};
      }}),
  ];
  if(ws.graphicsEnabled)tools.push(
    defineTool({name:'make_graphic',description:'Make a graphic from a designed template (list, stat, beforeAfter, keyTerm, compare, title, flow, marked, chapter, cards, beatWords): you give the words and the spoken word ids each part lands on; code does layout, type, motion and keeps side panels off the face. title is a section title card (full screen by default). marked underlines one word of a headline in a pen stroke; chapter shows a section title then parks it in a top corner as a label; cards deals 3-8 short examples onto a pile ("there are many"); beatWords lights each word of a line as it is said. place "full" covers the speaker with an opaque full-screen card instead; vary place across the video. Returns stills over the speaker. Same id again revises. Prefer this to render_graphic.',
      input:{id:z.string().regex(/^[a-z0-9-]{2,40}$/).describe('graphic id, e.g. "list-3-steps"'),template:templateSchema,seconds:z.number().min(2).max(12),
        anchor:z.object({clip:z.string(),word:z.number().int()}).describe('the word the graphic starts on; beat word ids are in this clip')},
      run:async({id,template,seconds,anchor})=>{
        const c=clipOf(ws.job,anchor.clip);
        const w0=c.words.find(x=>x.id===anchor.word);
        if(!w0)throw new Error(`no word ${anchor.word} in ${anchor.clip}`);
        const face=faceAt(c,w0.start);
        const at=(word:number|undefined,fb:number)=>{const w=word===undefined?undefined:c.words.find(x=>x.id===word);return w?w.start-w0.start:fb;};
        const ref=canvas();
        const html=templateHtml(template,{width:ref.width??1920,height:ref.height??1080,seconds,at,...(face?{face}:{})});
        return renderInto(id,html,seconds,c,w0.start,face,[0.7,seconds*0.55,seconds-0.7],ITEM_PLACE[resolvePlace(template.place,face)]);
      }}),
    defineTool({name:'render_graphic',description:'Design a graphic: render your own composition (HyperFrames format, one standalone index.html) to a transparent overlay with the graphics renderer (Remotion by default, HyperFrames if picked). Returns the render report (lint output under HyperFrames) and stills composited over the speaker at the anchor word. Re-render with the same id to revise.',
      input:{
        id:z.string().regex(/^[a-z0-9-]{2,40}$/).describe('graphic id, e.g. "stat-40pct"'),
        html:z.string().min(50).max(60_000).describe('full index.html; transparent background; GSAP from ./gsap.min.js; fonts from ./fonts/'),
        seconds:z.number().min(1).max(15),
        anchor:z.object({clip:z.string(),word:z.number().int()}).describe('the word the graphic starts on (for the backdrop)'),
        stills:z.array(z.number().min(0)).min(1).max(4).describe('seconds into the graphic to check, e.g. entrance, peak, hold'),
      },
      run:async({id,html,seconds,anchor,stills})=>{
        const c=clipOf(ws.job,anchor.clip);
        const w=c.words.find(x=>x.id===anchor.word);
        if(!w)throw new Error(`no word ${anchor.word} in ${anchor.clip}`);
        const face=faceAt(c,w.start);
        // Own HTML: code cannot tell where it draws, so the overlay is the frame.
        return renderInto(id,html,seconds,c,w.start,face,stills.filter(t=>t<seconds),'full');
      }}),
    ...sceneTools(ws,async(id,scene,seconds,anchor,stills)=>{
      const c=clipOf(ws.job,anchor.clip);
      const w=c.words.find(x=>x.id===anchor.word);
      if(!w)throw new Error(`no word ${anchor.word} in ${anchor.clip}`);
      // The html is unused for a scene; it keeps the in/ folder the same shape.
      return renderInto(id,'<!doctype html><html><head></head><body></body></html>',seconds,c,w.start,faceAt(c,w.start),stills,'full',scene);
    }),
    defineTool({name:'place_graphic',description:'Put a rendered graphic on the timeline, starting on a source word (it follows that word through recuts; dropped if the word is cut). Same id again moves it.',
      input:{id:z.string(),clip:z.string(),word:z.number().int(),seconds:z.number().min(0.5).max(15),
        reason:z.string().max(200),fade:fadeField,
        behindSubject:z.boolean().optional().describe('text behind the speaker: the speaker is cut out and drawn over the graphic at export (a full-frame graphic with see-through around its text; needs the subject mask model, else drawn over and reported)')},
      run:async(p)=>{
        if(!ws.graphics[p.id])throw new Error(`graphic ${p.id} has not rendered; call make_graphic, render_graphic or render_scene first`);
        if(!ws.segments.length)throw new Error('set a cut first');
        const had=ws.placements.find(x=>x.id===p.id);
        await change(ws,()=>{ws.placements=[...ws.placements.filter(x=>x.id!==p.id),{...p,...(had?.variants?{variants:had.variants}:{}),...(had?.shows?{shows:had.shows}:{})}];},{named:[`g-${p.id}`]});
        const g=ws.doc!.tracks.graphics.find(x=>x.id===`g-${p.id}`);
        return {text:g?`placed ${p.id} at ${g.start.toFixed(2)}-${g.end.toFixed(2)}s of the cut`:`${p.id} not placed: word ${p.word} is not in the cut`};
      }}),
  );
  const others=ws.job.clips.filter(c=>c.ref.kind==='video'&&!speaking(c));
  if(others.length)tools.push(
    defineTool({name:'show_footage',description:`Show another clip over the voice (muted, full frame), starting on a spoken word; the voice keeps playing. sync:true for a clip recorded with the speaker (the clip list or find_footage says "same clock"): it shows what that clip showed while those words were said, and stays in step through your cuts; no "in" needed. Otherwise give "in", the source second to start at. b-roll shots run ${BROLL_MIN}-${BROLL_MAX}s; other footage (a screen, a second camera) up to ${SHOW_MAX}s, with at least ${FACE_GAP}s of the speaker between two shots of the same footage. fit: contain keeps the whole picture (default for screens and other shapes), cover fills the frame. A screen recording is shown without its window bars, side strips and dock: code finds the page inside them from the frames shown and the result says what it kept; crop:"full" shows the whole frame. crop as a region shows one part of the frame blown up (a panel of a screen whose text is too small to read whole); frame it from timeline_view. speed runs the footage faster (typing, a build, scrolling): "seconds" is still screen time, so speed 4 for 3s shows 12s of source; not with sync. pip keeps the speaker in a corner over the footage, for long screen stretches; pick the corner the footage leaves empty. Same id again moves it. Shots that would overlap another, or land in the first 2s, are dropped.`,
      input:{id:z.string().regex(/^[a-z0-9-]{2,40}$/),footage:z.string().describe('clip id to show'),clip:z.string().describe('speaking clip of the anchor word'),word:z.number().int(),
        seconds:z.number().min(BROLL_MIN).max(SHOW_MAX),sync:z.boolean().optional(),in:z.number().min(0).optional().describe('source second to start at; not with sync'),
        fit:z.enum(['cover','contain']).optional(),
        crop:z.union([z.literal('full'),z.object({x:z.number().min(0).max(0.95),y:z.number().min(0).max(0.95),w:z.number().min(0.05).max(1),h:z.number().min(0.05).max(1)})]).optional().describe('"full", or a region of the source frame, fractions: x,y of its top-left corner, w,h its size'),
        speed:z.number().min(1).max(16).optional(),pip:z.enum(PIP_CORNERS).optional(),fade:fadeField,lead:z.number().min(0).max(1).optional().describe('seconds the picture starts before the word, so the viewer sees it as it is named'),reason:z.string().max(200)},
      run:async({footage,crop:asked,...rest})=>{
        const p={...rest,...(asked&&asked!=='full'?{crop:asked}:{})};
        const b=clipOf(ws.job,footage);
        if(b.ref.kind!=='video'||speaking(b))throw new Error(`${footage} is not footage to show; it speaks`);
        if(b.ref.role==='b-roll'&&p.seconds>BROLL_MAX)throw new Error(`b-roll shots run at most ${BROLL_MAX}s`);
        if(p.sync&&!syncOf(ws.job,footage,p.clip))throw new Error(`${footage} was not recorded with ${p.clip}; give "in" instead of sync`);
        if(p.sync&&p.speed&&p.speed!==1)throw new Error('sync keeps footage in step with the voice; sped-up footage cannot be. Give "in" instead');
        if(p.crop&&(p.crop.x+p.crop.w>1||p.crop.y+p.crop.h>1))throw new Error('crop reaches outside the frame: x+w and y+h must be at most 1');
        if(!p.sync&&p.in===undefined)throw new Error('give "in" (source second), or sync:true for a clip recorded with the speaker');
        if(!p.sync&&p.in!+BROLL_MIN*(p.speed??1)>b.ref.duration)throw new Error(`${footage} is ${b.ref.duration.toFixed(1)}s; start earlier`);
        if(!ws.segments.length)throw new Error('set a cut first');
        if(!p.sync)showGate(ws,footage);
        const shot:BrollPlacement={...p,broll:footage},before=ws.broll;
        await change(ws,()=>{ws.broll=[...ws.broll.filter(x=>x.id!==p.id),shot];},{named:[`b-${p.id}`,`b-${p.id}-`]});
        const pieces=(id:string)=>ws.doc!.tracks['b-roll'].filter(x=>x.id===`b-${id}`||x.id.startsWith(`b-${id}-`));
        const gs=pieces(p.id);
        if(gs.length) {
          const a=Math.min(...gs.map(g=>g.start)),z=Math.max(...gs.map(g=>g.end));
          const near=ws.broll.filter(x=>x.id!==p.id&&x.broll===footage).find(x=>pieces(x.id).some(g=>g.start<z+FACE_GAP&&g.end>a-FACE_GAP));
          if(near) {
            await change(ws,()=>{ws.broll=before;});
            throw new Error(`${p.id} runs into ${near.id} on the same footage; come back to the speaker for at least ${FACE_GAP}s between them, or move ${near.id}`);
          }
        }
        // A screen recording with no crop asked: drop the bars round the page, read off the frames this shot shows.
        let kept='';
        if(gs.length&&!asked&&isScreen(b)) {
          const box=await screenContent(ws,b,gs.map(g=>[g.in,g.out])).catch(()=>undefined);
          if(box) {
            await change(ws,()=>{ws.broll=ws.broll.map(x=>x.id===p.id?{...x,crop:box}:x);},{named:[`b-${p.id}`,`b-${p.id}-`]});
            kept=`; cropped to the page inside the window bars (x ${box.x} y ${box.y} w ${box.w} h ${box.h} of the frame); crop:"full" shows the whole frame`;
          }
        }
        const placed=pieces(p.id);
        return {text:placed.length?`placed ${p.id}: ${placed.map(g=>`${g.start.toFixed(2)}-${g.end.toFixed(2)}s of the cut (source ${g.in.toFixed(1)}-${g.out.toFixed(1)}s)`).join(', ')}${kept}`
          :`${p.id} not placed: anchor word cut, overlaps another shot, or too short where it lands`};
      }}));
  tools.push(
    defineTool({name:'place_text',description:'On-screen text from the house templates, starting on a spoken word: "title" (big centred), "callout" (short emphasis), "lowerThird" (name/label + subtext), "chapter" (section card). Same id again moves it.',
      input:{id:z.string().regex(/^[a-z0-9-]{2,40}$/),template:z.enum(['lowerThird','chapter','callout','title']),text:z.string().min(1).max(60),
        subtext:z.string().max(80).optional(),position:z.enum(['auto','top','bottom','left','right','center']).default('auto'),
        clip:z.string(),word:z.number().int(),seconds:z.number().min(1).max(8),reason:z.string().max(200),fade:fadeField},
      run:async(p)=>{
        if(!ws.segments.length)throw new Error('set a cut first');
        // Moving it keeps its variants.
        const had=ws.text.find(x=>x.id===p.id)?.variants;
        await change(ws,()=>{ws.text=[...ws.text.filter(x=>x.id!==p.id),{...p,...(had?{variants:had}:{})}];},{named:[`t-${p.id}`]});
        const t=ws.doc!.tracks.text.find(x=>x.id===`t-${p.id}`);
        if(!t)return {text:`${p.id} not placed: word ${p.word} is not in the cut`};
        const read=readWarning({label:`text ${p.id}`,text:[t.text,t.subtext].filter(Boolean).join(' '),start:t.start,end:t.end,...(t.fadeIn?{fadeIn:t.fadeIn}:{}),...(t.fadeOut?{fadeOut:t.fadeOut}:{})});
        return {text:`placed ${p.id} at ${t.start.toFixed(2)}-${t.end.toFixed(2)}s of the cut${read?`\n${read}`:''}`};
      }}),
    defineTool({name:'variants',description:`Keep other versions of a placed text or graphic to compare, and pick which one shows. add: another version (text: other words, subtext or template; graphic: the id of another graphic you rendered). choose N: show version N; the one shown before becomes a variant. Up to ${VARIANTS_MAX} variants per item; the creator can switch between them later. Lists the versions.`,
      input:{kind:z.enum(['text','graphic']),id:z.string().describe('the id it was placed with'),
        add:z.object({text:z.string().min(1).max(60).optional(),subtext:z.string().max(80).optional(),template:z.enum(['lowerThird','chapter','callout','title']).optional(),
          graphic:z.string().optional().describe('rendered graphic id, for kind graphic')}).strict().optional(),
        choose:z.number().int().min(1).max(VARIANTS_MAX).optional().describe('version number from the list; 0 is the one shown')},
      run:async({kind,id,add,choose})=>{
        if(!add&&choose===undefined)throw new Error('give add or choose');
        if(kind==='text') {
          const t=ws.text.find(x=>x.id===id);
          if(!t)throw new Error(`no text ${id}; place_text first`);
          let next={...t,variants:[...(t.variants??[])]};
          if(add) {
            if(!add.text&&!add.template&&add.subtext===undefined)throw new Error('a text variant needs text, subtext or template');
            if(next.variants.length>=VARIANTS_MAX)throw new Error(`${id} has ${VARIANTS_MAX} variants; choose one or leave it`);
            next.variants.push({text:add.text??t.text,...(add.subtext!==undefined?{subtext:add.subtext}:t.subtext?{subtext:t.subtext}:{}),...(add.template?{template:add.template}:{})});
          }
          if(choose!==undefined) {
            const v=next.variants[choose-1];
            if(!v)throw new Error(`${id} has no version ${choose}`);
            const shown:TextVariant={template:next.template,text:next.text,...(next.subtext?{subtext:next.subtext}:{}),position:next.position};
            const {subtext:_s,...base}=next;
            next={...base,template:v.template??next.template,text:v.text,...(v.subtext?{subtext:v.subtext}:{}),position:v.position??next.position,
              variants:next.variants.map((x,k)=>k===choose-1?shown:x)};
          }
          await change(ws,()=>{ws.text=ws.text.map(x=>x.id===id?next:x);},{named:[`t-${id}`]});
          return {text:[`${id} versions:`,...[next,...next.variants].map((v,k)=>`${k}${k?'':' (shown)'}: [${v.template??next.template}] ${v.text}${v.subtext?` / ${v.subtext}`:''}`)].join('\n')};
        }
        const g=ws.placements.find(x=>x.id===id);
        if(!g)throw new Error(`no graphic ${id}; place_graphic first`);
        let next={...g,variants:[...(g.variants??[])]};
        if(add) {
          if(!add.graphic)throw new Error('a graphic variant needs graphic: the id of another rendered graphic');
          if(!ws.graphics[add.graphic])throw new Error(`graphic ${add.graphic} has not rendered; call make_graphic, render_graphic or render_scene first`);
          if(next.variants.length>=VARIANTS_MAX)throw new Error(`${id} has ${VARIANTS_MAX} variants; choose one or leave it`);
          next.variants.push({id:add.graphic});
        }
        if(choose!==undefined) {
          const v=next.variants[choose-1];
          if(!v)throw new Error(`${id} has no version ${choose}`);
          // The placement keeps its id (its handle for moves); the graphic it shows changes.
          next={...next,shows:v.id,variants:next.variants.map((x,k)=>k===choose-1?{id:next.shows??next.id}:x)};
        }
        await change(ws,()=>{ws.placements=ws.placements.map(x=>x.id===id?next:x);},{named:[`g-${id}`]});
        return {text:[`${id} versions:`,...[next.shows??next.id,...next.variants.map(v=>v.id)].map((v,k)=>`${k}${k?'':' (shown)'}: ${v}`)].join('\n')};
      }}),
    defineTool({name:'remove_item',description:'Take a graphic, shown footage (kind broll) or text off the timeline, by the id you placed it with. kind "item" takes any item off by its EditDoc id (a zoom, caption line, music, sound, chapter, or one the creator made): only when the creator asked for that item to go.',
      input:{kind:z.enum(['graphic','broll','text','item']),id:z.string()},
      run:async({kind,id})=>{
        const doc=ws.doc??ws.base;
        const drop=kind==='graphic'?[`g-${id}`]:kind==='text'?[`t-${id}`]:kind==='broll'?(doc?.tracks['b-roll'].filter(x=>x.id===`b-${id}`||x.id.startsWith(`b-${id}-`)).map(x=>x.id)??[]):[id];
        if(kind==='item') {
          const it=doc&&[...Object.values(doc.tracks).flat(),...doc.markers].find(x=>x.id===id);
          if(!it)throw new Error(`no item ${id} in the edit`);
          // The agent's own come back on the next build: take them out through the tool that set them.
          if(it.owner==='agent')throw new Error(`${id} is yours: call the tool that set it (set_zooms, set_captions, set_music, set_chapters) without it`);
        }
        await change(ws,()=>{
          if(kind==='graphic')ws.placements=ws.placements.filter(x=>x.id!==id);
          else if(kind==='broll')ws.broll=ws.broll.filter(x=>x.id!==id);
          else if(kind==='text')ws.text=ws.text.filter(x=>x.id!==id);
        },{drop});
        return {text:`removed ${kind} ${id}`};
      }}));
  tools.push(...surveyTools(ws));
  tools.push(...soundLookTools(ws,(w,f)=>change(w,f)));
  tools.push(...mediaTools(ws,(w,f)=>change(w,f)));
  tools.push(...logoTools(ws,(w,f)=>change(w,f)));
  tools.push(...trackTools(ws,(w,f)=>change(w,f)));
  tools.push(defineTool({name:'finish',description:'End the edit. Call once, after check_cut shows no problems you can fix. Say what you cut, why, and any problem you chose to leave.',
    input:{summary:z.string().min(20).max(2000),
      notes:z.array(z.object({id:z.string().max(120),reply:z.string().min(1).max(REPLY_MAX*2)})).max(100).optional()
        .describe('one line per creator note in the brief, by its id: what you changed and the second you chose, or why you left it')},
    run:async({summary,notes})=>{
      if(!ws.doc)return {text:'No cut yet: call set_cut first.',isError:true};
      const answered=noteReplies(ws.job.notes??[],notes);
      // Every note gets its line. Asked once: a note it cannot answer still lets the edit end.
      if(answered.missing.length&&!ws.notesAsked) {
        ws.notesAsked=true;
        return {text:`No reply for note(s) ${answered.missing.join(', ')}. Pass notes: one line per note, by id, then finish again.`,isError:true};
      }
      // An editor watches the cut down before sending it. Asked once: frames may be out of reach.
      if(ws.watchedAt!==ws.edits&&!ws.watchAsked) {
        ws.watchAsked=true;
        return {text:'Not watched since the last change. Call watch_cut over the whole video, fix what you see, then finish. If watch_cut fails, finish again.',isError:true};
      }
      const levelled=await matchLevels(ws);
      // Matching levels saves; that is not a change the agent has to watch again.
      ws.watchedAt=ws.edits;
      const c=checkCut(ws.job,ws.doc,ws.segments,ws.doc.tracks.graphics.length);
      ws.finished={summary,problems:c.problems,...(answered.replies.length?{noteReplies:answered.replies}:{})};
      await save(ws);
      return {text:`Finished. ${c.problems.length} open problem(s).${levelled?` Speech level matched on ${levelled} segment(s).`:''}\n${loudnessLines(ws,ws.doc!).join('\n')}\nStop now.`};
    }}));
  return tools.map(t=>withKeepNotes(ws,t));
}
