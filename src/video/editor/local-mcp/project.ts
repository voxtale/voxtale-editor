import {ffmpegPath,ffprobePath} from '../../ffmpeg-path';
// One edit per footage folder, kept in <folder>/.edit/. `openProject` reads
// the footage, transcribes speech and, given a vision model, labels the
// footage the way the cloud planner does (`labelFootage`), `loadProject` rebuilds the editor's
// workspace from disk, `keepProject` writes back what save() does not. Each
// call can load, run one tool and keep, so nothing lives only in memory.
import {createHash} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {clipRefSchema,groupFromStarts,handEdits,overlapSeconds,parseEditDoc,parseLoudness,FORMULAS,SYNC_CONFIDENCE_MIN,type ClipRef,type EditDoc,type SyncGroup} from '@voxtale/editdoc';
import {detectColor,makeProxy,mediaInfo,needsProxy} from '../../footage-media';
import {activityLevels,decodeMono,envelope,placeBySound,SYNC_RATE} from '../../sound-sync';
import {syncFromGroups} from '../agent/multicam';

import {beatsOfFile} from '../../beats';
import type {FaceFinder,VisionModel} from '../../footage-index';
import type {Edit} from '../../model';
import {denseMoments,freshMoments,type ClipMoments} from '../../moments';
import {loudnessReport,renderEditDoc,type OutputShape} from '../../render-edit';
import {transcribe} from '../../transcript';
import type {Point} from '../../zoom';
import type {Job,JobClip} from '../agent/cut';
import {eyeFinder} from '../agent/eyes';
import {localFrames,type FrameHost,type HtmlRenderer} from '../agent/frames';
import {ff} from '../agent/look';
import {jobTools,newJob,newWorkspace,styleFor,understandClips} from '../agent/session';
import {AGENT_EDIT,matchLevels,save,type Workspace} from '../agent/tools';

const FFPROBE=ffprobePath();

export type Log=(line:string)=>void;
export type Role='a-roll'|'b-roll'|'screen'|'music'|'sfx'|'mic'|'other';
/** voice: sound only (a voiceover); synced: recorded with the speaker, from the same start. */
export interface OpenFile {path:string;role:Role;voice:boolean;synced:boolean}
export type Format='vertical'|'horizontal';
/** format: the picture for a voiceover-only edit; with a speaker on camera, their clip sets it. */
export interface OpenOptions {files:OpenFile[];
  /** false: no light copies; previews read the originals (slow on 4K or 10-bit). */
  proxies?:boolean;style?:string;target?:number;instruction?:string;format?:Format;
  /** Labels footage for find_footage and screen_activity; null = transcribe only (the reason is logged). */
  vision?:VisionModel|null}
export interface Project {job:Job;sources:Record<string,string>;voiceover:boolean;
  /** Light 720p copies by clip hash: previews, filmstrips and look samples read these; the render reads `sources`. */
  proxies?:Record<string,string>;
  /** Clips recorded together, found by their sound at open, with each member's level per `step` seconds. */
  multicam?:{groups:SyncGroup[];levels:Record<string,number[]>;step:number}}
/** What a project needs from this machine: a face finder for zoom, a renderer for graphics. */
export interface Ports {faces?:FaceFinder;html?:HtmlRenderer}

/** Where a project lives: the footage folder and its .edit/ folder. */
export interface At {folder:string;dir:string}
export const projectAt=(folder:string,dir?:string):At=>{const f=resolve(folder);return {folder:f,dir:resolve(f,dir??'.edit')};};
const projectFile=(a:At)=>join(a.dir,'project.json');
const sessionFile=(a:At)=>join(a.dir,'session.json');
export const hasProject=(a:At)=>existsSync(projectFile(a));

async function sh(cmd:string,args:string[]):Promise<{out:string;err:string;code:number}> {
  const p=Bun.spawn([cmd,...args],{stdout:'pipe',stderr:'pipe',stdin:'ignore'});
  const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);
  return {out,err,code:await p.exited};
}

async function sha256(path:string):Promise<string> {
  const h=createHash('sha256');
  for await (const chunk of createReadStream(path))h.update(chunk as Buffer);
  return h.digest('hex');
}

export async function probe(path:string) {
  const r=await sh(FFPROBE,['-v','error','-show_format','-show_streams','-of','json',path]);
  if(r.code)throw new Error(`ffprobe ${path}: ${r.err.slice(-300)}`);
  const info=JSON.parse(r.out),v=info.streams.find((s:any)=>s.codec_type==='video'&&s.disposition?.attached_pic!==1);
  // Phone video is stored landscape with a rotation flag; ffmpeg turns it upright when it decodes.
  const rot=Math.abs(Number(v?.side_data_list?.find((d:any)=>d.rotation!==undefined)?.rotation??v?.tags?.rotate??0))%180===90;
  return {duration:Number(info.format.duration),width:(rot?v?.height:v?.width) as number|undefined,height:(rot?v?.width:v?.height) as number|undefined,
    rate:String(v?.avg_frame_rate??'30/1'),audio:info.streams.some((s:any)=>s.codec_type==='audio')};
}

function fps(rate:string):{num:number;den:number} {
  const [n,d]=rate.split('/').map(Number);
  if(n&&d&&Number.isInteger(n/d))return {num:n/d,den:1};
  if(n===30000&&d===1001)return {num:30000,den:1001};
  return {num:Math.round((n||30)/(d||1))||30,den:1};
}

async function loudness(path:string):Promise<{lufs:number;truePeakDb:number}|undefined> {
  const r=await sh(ffmpegPath(),['-hide_banner','-nostdin','-i',path,'-map','0:a:0','-af','ebur128=peak=true:framelog=quiet','-f','null','-']);
  const l=parseLoudness(r.err);
  if(!l||!Number.isFinite(l.lufs)||l.lufs<-70)return undefined;
  return {lufs:Math.max(-70,Math.min(10,l.lufs)),truePeakDb:Math.max(-70,Math.min(20,l.truePeakDb))};
}

/**
 * True when transcription failed only because the clip has no speech: no
 * sound track, an empty transcript, or AssemblyAI finding no spoken audio.
 */
export function noSpeech(e:unknown):boolean {
  const issues=(e as {name?:string;issues?:{path:PropertyKey[];code:string}[]})?.name==='ZodError'?(e as {issues:{path:PropertyKey[];code:string}[]}).issues:undefined;
  if(issues)return issues.some(i=>i.path[0]==='words'&&i.code==='too_small');
  return e instanceof Error&&/requires video footage with an audio track|no spoken audio/i.test(e.message);
}

async function loadClip(a:At,id:string,path:string,role:Role,log:Log,o:{proxy?:boolean}={}):Promise<{clip:JobClip;hash:string;proxy?:string}> {
  const info=await probe(path),hash=await sha256(path);
  const kind=info.width?'video':'audio';
  let words:JobClip['words']=[];
  if(role==='a-roll') {
    if(info.audio) {
      log(`transcribing ${basename(path)} (AssemblyAI)…`);
      try {
        const t=await transcribe({source:path} as unknown as Edit,join(a.dir,'transcripts',`${hash.slice(0,12)}.json`),{progress:m=>log(`  ${m}`)});
        words=t.words.map(w=>({id:w.id,text:w.text,start:w.start,end:w.end}));
      } catch(e) {if(!noSpeech(e))throw e;}
    }
    // A talk clip nobody speaks in is footage: open it as broll rather than fail the whole open.
    if(!words.length&&kind==='video') {
      log(`warning: ${basename(path)} has no spoken words${info.audio?'':' (no sound track)'}: opened as broll, not talk`);
      role='b-roll';
    }
  }
  const level=info.audio&&role!=='b-roll'&&role!=='screen'?await loudness(path):undefined;
  // Log or HDR footage: converted to Rec.709 before the look (camera-log.ts); a light copy for editing when big.
  const media=kind==='video'?await mediaInfo(path).catch(()=>null):null;
  const color=media?await detectColor(path,media).catch(()=>undefined):undefined;
  if(color&&(color.log||color.hdr))log(`${basename(path)}: ${color.log??color.hdr?.toUpperCase()} (${color.why})${color.log&&!FORMULAS[color.log]?': no built-in conversion, set an input LUT (set_look inputLut)':''}`);
  let proxy:string|undefined;
  if(media&&o.proxy!==false&&needsProxy(media)) {
    log(`light copy of ${basename(path)} for editing (${media.width}x${media.height} ${media.codec} ${media.pixFmt})…`);
    proxy=await makeProxy(path,join(a.dir,'proxies',`${hash.slice(0,16)}.mp4`)).catch(e=>{log(`warning: no light copy of ${basename(path)}: ${(e as Error).message}`);return undefined;});
  }
  // Music: its beat, so joins and shots can land on it.
  const beats=role==='music'&&info.audio?await beatsOfFile(path,ff).catch(()=>undefined):undefined;
  const ref:ClipRef=clipRefSchema.parse({id,hash,name:basename(path),kind,role,roleSource:'creator',duration:info.duration,fps:fps(info.rate),
    ...(kind==='video'?{width:info.width,height:info.height}:{}),hasAudio:info.audio,timecodeStart:0,...(level?{loudness:level}:{}),...(beats?{beats}:{}),...(color?{color}:{})});
  return {clip:{ref,words},hash,...(proxy?{proxy}:{})};
}

/** A voiceover becomes a black video with that sound, so the editor can cut it like a speaker. */
async function voiceVideo(a:At,audio:string,format:Format):Promise<string> {
  const size=format==='vertical'?'1080x1920':'1920x1080';
  const out=join(a.dir,'voice',`${basename(audio).replace(/\.[^.]+$/,'')}-${format}.mp4`);
  await mkdir(dirname(out),{recursive:true});
  if(!existsSync(out))await ff(['-f','lavfi','-i',`color=c=black:s=${size}:r=30`,'-i',audio,'-map','0:v','-map','1:a','-shortest',
    '-c:v','libx264','-preset','ultrafast','-tune','stillimage','-c:a','aac','-b:a','192k',out]);
  return out;
}

/** Overlap below this many seconds makes a sound match doubtful (a chance echo). */
const SYNC_OVERLAP_MIN=10;

/**
 * One sync group from the clips' sound (local ffmpeg, no network): who
 * starts when on a shared clock, and each one's level for picking the active
 * mic. Clips no sure match reaches stay out.
 */
async function groupBySound(clips:JobClip[],sources:Record<string,string>,log:Log):Promise<Project['multicam']> {
  log(`lining up ${clips.length} clips by their sound…`);
  const decoded=await Promise.all(clips.map(async c=>({clipId:c.ref.id,pcm:await decodeMono(sources[c.ref.hash]!).catch(()=>null)})));
  const ok=decoded.filter((d):d is {clipId:string;pcm:Float32Array}=>!!d.pcm&&d.pcm.length>SYNC_RATE);
  const placed=placeBySound(ok.map(d=>({clipId:d.clipId,env:envelope(d.pcm)})));
  let g=groupFromStarts('g1',placed.filter(p=>p.start!==undefined).map(p=>({clipId:p.clipId,start:p.start!,...(p.confidence!==undefined?{confidence:p.confidence}:{})})));
  const refs=clips.map(c=>c.ref);
  if(g) {
    const kept=g.members.filter(m=>g!.members.some(o=>o.clipId!==m.clipId&&overlapSeconds(g!,refs,m.clipId,o.clipId)>=SYNC_OVERLAP_MIN));
    g=kept.length>=2?{...g,members:kept}:null;
  }
  for(const p of placed)if(!g?.members.some(m=>m.clipId===p.clipId))log(`warning: ${p.clipId} did not line up by sound${p.confidence!==undefined?` (match ${p.confidence.toFixed(1)}, sure from ${SYNC_CONFIDENCE_MIN})`:''}: kept as is`);
  if(!g)return undefined;
  for(const m of g.members)log(`${m.clipId} starts at ${m.start.toFixed(3)}s on the shared clock${m.confidence?` (match ${m.confidence.toFixed(1)})`:''}`);
  const levels=Object.fromEntries(ok.filter(d=>g!.members.some(m=>m.clipId===d.clipId)).map(d=>[d.clipId,activityLevels(d.pcm,SYNC_RATE,0.1).map(v=>Math.round(v*10)/10)]));
  return {groups:[g],levels,step:0.1};
}

/** Read the footage, transcribe speech and save a fresh project (an edit already there starts over). */
export async function openProject(a:At,o:OpenOptions,log:Log):Promise<void> {
  const files=o.files.map(f=>({...f,path:resolve(a.folder,f.path)}));
  if(!files.some(f=>f.role!=='music'&&f.role!=='sfx'))throw new Error('need a talking-head clip, a voiceover file or footage');
  for(const f of files)if(!existsSync(f.path))throw new Error(`no such file: ${f.path}`);
  await mkdir(a.dir,{recursive:true});
  await mkdir(join(a.dir,'proxies'),{recursive:true});
  const clips:JobClip[]=[],sources:Record<string,string>={},proxies:Record<string,string>={},synced:string[]=[];
  // Voiceover only: the picture takes the creator's format, else the first footage's shape.
  const shape=async():Promise<Format>=>{
    for(const f of files.filter(f=>f.role==='b-roll'||f.role==='screen')) {
      const i=await probe(f.path);
      if(i.width&&i.height)return i.height>i.width?'vertical':'horizontal';
    }
    return 'horizontal';
  };
  const format=files.some(f=>f.voice)?o.format??await shape():undefined;
  let n=0;
  // Speaking clips first: the first one sets the canvas.
  for(const f of [...files.filter(f=>f.role==='a-roll'),...files.filter(f=>f.role!=='a-roll')]) {
    const path=f.voice?await voiceVideo(a,f.path,format!):f.path;
    const {clip,hash,proxy}=await loadClip(a,`c${++n}`,path,f.role,log,{proxy:o.proxies});
    if(proxy)proxies[hash]=proxy;
    if(f.voice)clip.ref={...clip.ref,name:basename(f.path)};
    clips.push(clip);
    if(f.synced)synced.push(clip.ref.id);
    sources[hash]=path;
    log(`${clip.ref.id} ${f.voice?'voiceover':clip.ref.role} ${clip.ref.name} ${clip.ref.duration.toFixed(1)}s${clip.ref.width?` ${clip.ref.width}x${clip.ref.height}`:''}${clip.words.length?` ${clip.words.length} words`:''}`);
  }
  const job=newJob({id:'edit',name:basename(a.folder),clips,style:styleFor(o.style),synced,
    ...(o.target?{targetSeconds:o.target}:{}),...(o.instruction?{instruction:o.instruction}:{})});
  // Several cameras or mics: line them up by their sound, so cuts stay in step on every one.
  const groupable=clips.filter(c=>c.ref.hasAudio&&(c.ref.role==='a-roll'||c.ref.role==='mic'||synced.includes(c.ref.id)));
  const multicam=groupable.length>=2?await groupBySound(groupable,sources,log):undefined;
  const talk=clips.find(c=>c.ref.role==='a-roll'&&c.words.length);
  if(multicam&&talk) {
    const found=syncFromGroups(multicam.groups,talk.ref.id);
    job.sync=[...(job.sync??[]).filter(s=>!found.some(x=>x.clip===s.clip)),...found];
  }
  for(const s of job.sync??[])log(`${s.clip} recorded with ${s.with} (same clock${s.offset?`, ${s.offset>0?'+':''}${s.offset.toFixed(3)}s`:''}): show it with sync:true`);
  if(o.vision)await labelFootage(a,job,sources,o.vision,log);
  else if(understandClips(job).length)log('footage not labelled (no OPENROUTER_API_KEY): find_footage and screen_activity are off; look with timeline_view');
  await writeFile(projectFile(a),JSON.stringify({job,sources,voiceover:files.some(f=>f.voice),
    ...(Object.keys(proxies).length?{proxies}:{}),...(multicam?{multicam}:{})} satisfies Project,null,1));
  await writeFile(join(a.dir,'state.json'),'{}');
  await writeFile(sessionFile(a),'{}');
  // Starting over: the last edit is not the creator's to keep.
  await rm(join(a.dir,'edit.json'),{force:true});
  await rm(join(a.dir,AGENT_EDIT),{force:true});
}

/** Rough labelling cost, for the agent to tell the creator: dense moments, one vision call per 12 picture changes. */
export const LABEL_COST='about 1 vision call per 12 picture changes; roughly 1-3 cents and under a minute per minute of footage';

/**
 * Moments for every footage clip (b-roll, screens), as the cloud planner
 * makes them: the same clips, words and describer. Kept in .edit/moments/ by
 * clip hash, so opening again pays only for new clips or a new prompt. A
 * clip that fails is left without moments; the edit goes on.
 */
export async function labelFootage(a:At,job:Job,sources:Record<string,string>,vision:VisionModel,log:Log):Promise<{clips:number;calls:number;costUsd:number}> {
  const todo=understandClips(job);
  if(!todo.length)return {clips:0,calls:0,costUsd:0};
  const minutes=todo.reduce((t,c)=>t+c.duration,0)/60;
  log(`labelling ${todo.length} footage clip${todo.length>1?'s':''} (${minutes.toFixed(1)} min) with a vision model: ${LABEL_COST}`);
  const frames=localFrames({sources,dir:join(a.dir,'looks'),ff});
  let calls=0,cost=0,labelled=0;
  const counted:VisionModel=async(system,parts)=>{calls++;return vision(system,parts);};
  const t0=Date.now();
  for(const c of todo) {
    const clip=job.clips.find(x=>x.ref.id===c.id)!;
    const file=join(a.dir,'moments',`${c.hash.slice(0,16)}.json`);
    let m:ClipMoments|undefined=freshMoments(await readJson<unknown>(file,null).catch(()=>null),c.hash);
    if(m)log(`  ${c.id} ${clip.ref.name}: ${m.moments.length} moments (kept from an earlier open)`);
    else {
      try {
        m=await denseMoments({hash:c.hash,duration:c.duration,words:c.words,frames},counted,{progress:x=>log(`  ${c.id}: ${x}`)});
        await mkdir(dirname(file),{recursive:true});
        await writeFile(file,JSON.stringify(m));
        cost+=m.costUsd;
        log(`  ${c.id} ${clip.ref.name}: ${m.moments.length} moments, $${m.costUsd.toFixed(3)}`);
      } catch(e) {
        log(`  ${c.id} ${clip.ref.name}: not labelled (${e instanceof Error?e.message:e}); find_footage skips it`);
      }
    }
    if(m){clip.moments=m;labelled++;}
  }
  if(calls)log(`labelled ${labelled}/${todo.length} clips: ${calls} vision calls, $${cost.toFixed(3)}, ${((Date.now()-t0)/1000).toFixed(0)}s`);
  return {clips:labelled,calls,costUsd:cost};
}

/** What the editor keeps in memory between calls that save() does not write: edit count, last watch, caption look, eyes found. */
interface Session {edits?:number;watchedAt?:number;watchAsked?:boolean;captionLookKept?:boolean;eyes?:[string,Point|null][]}

const readJson=async<T>(f:string,empty:T):Promise<T>=>existsSync(f)?JSON.parse(await readFile(f,'utf8')):empty;

/** The voice track of a clip is read once (one pass over its sound) and kept in .edit/voicetrack/. */
function cachedVoice(a:At,frames:FrameHost):FrameHost {
  const read=frames.voice;
  if(!read)return frames;
  return {...frames,voice:async hash=>{
    const f=join(a.dir,'voicetrack',`${hash.slice(0,16)}.bin`);
    if(existsSync(f))return new Uint8Array(await readFile(f));
    const bytes=await read(hash);
    await mkdir(dirname(f),{recursive:true});
    await writeFile(f,bytes);
    return bytes;
  }};
}

/**
 * Rebuild the workspace from .edit/. With a face finder, zoom aims at the
 * speaker's eyes (else the middle); with a renderer, the graphics tools are on.
 */
export async function loadProject(a:At,ports:Ports={}):Promise<{p:Project;ws:Workspace}> {
  if(!hasProject(a))throw new Error(`no project here: open one first (looked in ${a.dir})`);
  const p:Project=JSON.parse(await readFile(projectFile(a),'utf8'));
  // Previews and samples read the light copies; the render reads the originals (renderProject: p.sources).
  const frames=cachedVoice(a,localFrames({sources:{...p.sources,...p.proxies},dir:join(a.dir,'looks'),ff,...(ports.html?{html:ports.html}:{})}));
  const ws=newWorkspace({dir:a.dir,job:p.job,frames,graphics:!!ports.html,...(ports.faces?{eyes:eyeFinder(frames.frames,ports.faces)}:{})});
  // state.json is what save() writes; null fields (music cleared) mean "none".
  const state=await readJson<Record<string,unknown>>(join(a.dir,'state.json'),{});
  for(const [k,v] of Object.entries(state))if(v!==null&&v!==undefined)(ws as unknown as Record<string,unknown>)[k]=v;
  if(p.multicam)ws.syncGroups=p.multicam;
  ws.media=p.sources;
  const {eyes,...session}=await readJson<Session>(sessionFile(a),{});
  // Eyes found on earlier calls, so the face model runs once per cut frame.
  if(eyes)ws.eyeCache=new Map(eyes);
  await readHandEdits(a,ws);
  if(ws.segments.length)await save(ws);
  // Rebuilding the cut from saved state is not an edit: keep the count, so a watch_cut still counts at finish.
  Object.assign(ws,session);
  return {p,ws};
}

/**
 * What the creator changed in .edit/edit.json since the agent last wrote it
 * (in an editor or by hand): those items become theirs, and the rebuild that
 * follows lays them over the agent's plan instead of wiping them.
 */
async function readHandEdits(a:At,ws:Workspace):Promise<void> {
  const disk=await readJson<unknown>(join(a.dir,'edit.json'),null);
  if(!disk)return;
  const now=parseEditDoc(disk).doc;
  const written=await readJson<unknown>(join(a.dir,AGENT_EDIT),null);
  if(!written){ws.base=now;return;}
  const h=handEdits(parseEditDoc(written).doc,now);
  ws.base=h.doc;
  for(const [id,fields] of Object.entries(h.hand))ws.hand={...ws.hand,[id]:[...new Set([...(ws.hand?.[id]??[]),...fields])]};
}

/** Keep what this call changed that save() does not write: the job's style (caption look) and the session. */
export async function keepProject(a:At,p:Project,ws:Workspace):Promise<void> {
  await writeFile(projectFile(a),JSON.stringify({...p,job:ws.job},null,1));
  const session:Session={...(ws.edits!==undefined?{edits:ws.edits}:{}),...(ws.watchedAt!==undefined?{watchedAt:ws.watchedAt}:{}),
    ...(ws.watchAsked?{watchAsked:true}:{}),...(ws.captionLookKept?{captionLookKept:true}:{}),
    ...(ws.eyeCache?.size?{eyes:[...ws.eyeCache]}:{})};
  await writeFile(sessionFile(a),JSON.stringify(session));
}

export const visibleTools=jobTools;

/** The clips, one per line, for the agent. */
export function clipLines(ws:Workspace):string {
  return ws.job.clips.map(c=>{
    const s=ws.job.sync?.find(x=>x.clip===c.ref.id);
    return `- ${c.ref.id} ${c.ref.role} "${c.ref.name}" ${c.ref.duration.toFixed(1)}s${c.ref.width?` ${c.ref.width}x${c.ref.height}`:''}${c.words.length?` ${c.words.length} words`:''}${s?`, same clock as ${s.with} (sync:true)`:''}`;
  }).join('\n');
}

/** Each clip with the file it reads, so another editor can rebuild the edit. */
export function clipFiles(p:Project) {
  return p.job.clips.map(c=>({id:c.ref.id,role:c.ref.role,name:c.ref.name,path:p.sources[c.ref.hash]??null,hash:c.ref.hash,
    duration:c.ref.duration,fps:c.ref.fps,...(c.ref.width?{width:c.ref.width,height:c.ref.height}:{}),hasAudio:c.ref.hasAudio}));
}

/**
 * Voiceover has no picture under the footage, so any gap shows black. The
 * hook hold keeps shots out of the first seconds: pull the first back to 0.
 * Shots start on words, so a few frames fall between them: stretch each to
 * the next (and the last to the end) when the gap is under half a second.
 */
export function coverVoice(doc:EditDoc):EditDoc {
  const b=[...doc.tracks['b-roll']].sort((x,y)=>x.start-y.start).map(x=>({...x}));
  if(!b.length)return doc;
  const first=b[0]!;
  if(first.start>0&&first.start<=3){first.in=Math.max(0,first.in-first.start);first.start=0;}
  const end=Math.max(...doc.tracks['a-roll'].map(a=>a.end));
  for(const [i,x] of b.entries()) {
    const next=b[i+1]?.start??end,gap=next-x.end;
    if(gap>0&&gap<0.5)x.end=next;
    x.out=x.in+(x.end-x.start);
  }
  return {...doc,tracks:{...doc.tracks,'b-roll':b}};
}

/** The edit as the viewer gets it: voiceover gaps closed. */
export const finalDoc=(p:Project,doc:EditDoc)=>p.voiceover?coverVoice(doc):doc;

/** Render the cut to an MP4 (relative paths sit in the footage folder). Returns the file and what was left out. */
export async function renderProject(a:At,p:Project,ws:Workspace,o:{out?:string;fontsDir?:string;progress?:(f:number)=>void;output?:OutputShape}):Promise<{file:string;seconds:number;skipped:string[];
  /** What the file is, read back from it: size, frame rate, length. */
  actual:{width:number;height:number;fps:number;duration:number};
  /** Integrated loudness and true peak, as built and as delivered. */
  loudness:string[];graded:string[]}> {
  if(!ws.doc)throw new Error('no cut yet: set_cut first');
  // Every kept segment at one speech level (finish does this too; measured once, kept in state.json).
  await matchLevels(ws);
  await keepProject(a,p,ws);
  const file=resolve(a.folder,o.out??'final.mp4');
  await mkdir(dirname(file),{recursive:true});
  const t0=Date.now();
  const graphics=Object.fromEntries(Object.entries(ws.graphics).filter(([,g])=>existsSync(g.webm)).map(([id,g])=>[id,g.webm]));
  const r=await renderEditDoc({doc:finalDoc(p,ws.doc),media:p.sources,graphics,out:file,work:join(a.dir,'render'),
    ...(o.fontsDir&&existsSync(o.fontsDir)?{fontsDir:o.fontsDir}:{}),...(o.progress?{progress:o.progress}:{}),...(o.output?{output:o.output}:{})});
  const seconds=(Date.now()-t0)/1000,i=await probe(file),[n,d]=i.rate.split('/').map(Number);
  const doc=ws.doc;
  return {file,seconds,skipped:r.skipped.map(x=>x.itemId),actual:{width:i.width??0,height:i.height??0,fps:n&&d?n/d:0,duration:i.duration},
    loudness:r.loudness?loudnessReport(r.loudness,{lufs:doc.mix.loudnessLufs,truePeakDb:doc.mix.truePeakDb}):[],graded:r.graded??[]};
}

/** Frames of a rendered video in a grid, to check what the viewer sees. */
export async function sheetOf(a:At,video?:string):Promise<{text:string;image:string}> {
  const file=resolve(a.folder,video??'final.mp4');
  if(!existsSync(file))throw new Error(`no such video: ${file} (render first)`);
  const info=await probe(file);
  const n=16,step=info.duration/n,img=join(a.dir,'views',`sheet-${Date.now()}.jpg`);
  await mkdir(dirname(img),{recursive:true});
  await ff(['-i',file,'-vf',`fps=1/${step.toFixed(3)},scale=-2:320,tile=8x2`,'-frames:v','1',img]);
  return {text:`${n} frames of ${file}, left to right then next row, at ${Array.from({length:n},(_,k)=>(k*step).toFixed(1)).join(', ')}s`,image:img};
}
