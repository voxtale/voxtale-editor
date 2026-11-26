// One edit session, wherever it runs: the job and workspace the editor tools
// work on. The cloud planner (./plan) and the local editor MCP (../local-mcp)
// both build them here, so the agent sees the same job either way; only the
// ports differ (frame host, graphics renderer, face finder, where state is
// kept).
import {STYLE_PRESETS,withBrand,type EditStyle} from '@voxtale/editdoc';
import type {BrandKit} from '../state';
import type {ProjectBrief} from '../project';
import {syncClips,type MomentWord} from '../../moments';
import {speaking,styleOf,type Job,type JobClip} from './cut';
import type {EyeFinder} from './eyes';
import type {FrameHost} from './frames';
import {editorTools,type Workspace} from './tools';
import type {ToolDef} from './port';

/** A preset by id (unknown ids get the default), with the creator's brand kit over it. */
export const styleFor=(id?:string,brand?:BrandKit):EditStyle=>withBrand(styleOf(id&&id in STYLE_PRESETS?id:undefined),brand??{});

export interface JobInput {
  id:string;
  name:string;
  clips:JobClip[];
  style:EditStyle;
  targetSeconds?:number;
  instruction?:string;
  project?:ProjectBrief;
  /** The creator's accepted standing rules. */
  rules?:string[];
  /** Clip ids the creator says were recorded with the speaker, from the same start. */
  synced?:string[];
}

/** The job: effects files switch on sound effects, and clips recorded together share a clock. */
export function newJob(o:JobInput):Job {
  const {clips}=o;
  const job:Job={id:o.id,name:o.name,clips,style:o.style,
    ...(o.targetSeconds?{targetSeconds:o.targetSeconds}:{}),...(o.instruction?{instruction:o.instruction}:{}),...(o.project?{project:o.project}:{}),...(o.rules?.length?{rules:o.rules}:{})};
  // Effects files given to a style that has none: use them, quietly.
  if(clips.some(c=>c.ref.role==='sfx')&&job.style.audio.sfx==='off')job.style={...job.style,audio:{...job.style.audio,sfx:'subtle'}};
  const sync=syncClips(clips.map(c=>({id:c.ref.id,kind:c.ref.kind,role:c.ref.role,duration:c.ref.duration,hasAudio:c.ref.hasAudio,speaks:speaking(c)&&c.words.length>0})));
  const talk=clips.find(c=>speaking(c)&&c.words.length);
  if(talk)for(const id of o.synced??[])if(id!==talk.ref.id&&!sync.some(s=>s.clip===id))sync.push({clip:id,with:talk.ref.id,offset:0});
  job.sync=sync;
  return job;
}

/** Footage to show over the voice: video clips that do not speak (not music or effects). */
export const footageClips=(job:Job)=>job.clips.filter(c=>c.ref.kind==='video'&&!speaking(c)&&c.ref.role!=='music'&&c.ref.role!=='sfx');

/** A footage clip to describe (../../moments.ts), with the words heard while it ran. */
export interface UnderstandClip {id:string;hash:string;duration:number;words:MomentWord[]}

/** The footage clips to describe. One without its own speech hears the speaker it was recorded with, on its clock. */
export function understandClips(job:Job):UnderstandClip[] {
  const heard=(c:JobClip):MomentWord[]=>{
    if(c.words.length)return c.words;
    const s=job.sync?.find(x=>x.clip===c.ref.id),voice=s&&job.clips.find(x=>x.ref.id===s.with);
    return voice?voice.words.map(w=>({text:w.text,start:w.start+s.offset,end:w.end+s.offset})):[];
  };
  return footageClips(job).map(c=>({id:c.ref.id,hash:c.ref.hash,duration:c.ref.duration,words:heard(c)}));
}

/** An empty workspace on a job: nothing cut yet. */
export function newWorkspace(o:{dir:string;job:Job;frames:FrameHost;graphics:boolean;eyes?:EyeFinder;captionLookKept?:boolean}):Workspace {
  return {dir:o.dir,job:o.job,segments:[],placements:[],captions:[],zooms:[],broll:[],text:[],chapters:[],graphics:{},graphicsEnabled:o.graphics,frames:o.frames,
    ...(o.captionLookKept?{captionLookKept:true}:{}),...(o.eyes?{eyes:o.eyes}:{})};
}

/**
 * The tools that apply to this job. find_footage and screen_activity read clip
 * moments, a vision pass a host may skip (the local MCP without a vision key);
 * set_music needs music.
 */
export function jobTools(ws:Workspace):ToolDef<any>[] {
  const moments=ws.job.clips.some(c=>c.moments?.moments.length);
  const hide=new Set([...(moments?[]:['find_footage','screen_activity']),...(ws.job.clips.some(c=>c.ref.role==='music')?[]:['set_music']),...(footageClips(ws.job).length?[]:['survey_clips','rank_candidates'])]);
  return editorTools(ws).filter(t=>!hide.has(t.name));
}
