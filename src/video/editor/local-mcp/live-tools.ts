// The finished-live tools: a long live (file or URL) → candidate moments →
// one editor project per chosen moment, framed 9:16 (webcam over game, or
// a crop that follows the face). Everything about the live sits in
// <folder>/.live/; each clip is its own project folder under it.
import {existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {maybeJson,writeJson} from '../../artifacts';
import type {FaceFinder} from '../../footage-index';
import {run} from '../../media';
import {promptText} from '../../../services/prompts';
import {mergeRatings,ranked,scanText,type Candidate} from '../../live/candidates';
import {prepareClip} from '../../live/clip';
import {contactSheets,detectLayout,layoutText,planVertical,readLayout,sampleClip,type LayoutPart,type VerticalPlan} from '../../live/layout';
import {LIVE_LAYOUT_PROMPT_ID,LIVE_PICK_PROMPT_ID,LIVE_TITLES_PROMPT_ID} from '../../live/prompts';
import {scanLive,type LiveIndex} from '../../live/scan';
import {hms,seconds} from '../../live/signals';
import {change,type Workspace} from '../agent/tools';
import {z} from '../agent/port';
import type {McpTool} from '../agent/mcp-protocol';
import {hasProject,openProject,probe,projectAt,type At,type Project} from './project';

/** What the live is: the creator's source, the local file the sound is read from, its length. Kept in .live/live.json. */
interface LiveMeta {source:string;media:string;duration:number;title?:string;heatmap?:{start_time:number;end_time:number;value:number}[]}

const isUrl=(s:string)=>/^https?:\/\//.test(s);

/** A URL's length, title and most-replayed heatmap, then its sound only (yt-dlp; free). */
async function fetchLive(url:string,dir:string):Promise<LiveMeta> {
  const info=JSON.parse(await run('yt-dlp',['--quiet','--no-warnings','--dump-single-json','--no-playlist',url])) as {duration?:number;title?:string;heatmap?:LiveMeta['heatmap']};
  const media=join(dir,'audio.m4a');
  if(!existsSync(media))await run('yt-dlp',['--quiet','--no-warnings','--no-playlist','-f','ba[ext=m4a]/ba','-o',media,url]);
  const duration=info.duration??(await probe(media)).duration;
  return {source:url,media,duration,...(info.title?{title:info.title}:{}),...(info.heatmap?.length?{heatmap:info.heatmap}:{})};
}

const stamp=(v:string|number|undefined)=>v===undefined?undefined:typeof v==='number'?v:seconds(v);

export interface LiveToolsDeps {
  folderOf(folder?:string):string;
  faces():Promise<FaceFinder|undefined>;
  /** Make the project at `a` the open one (load + tools/list_changed). */
  load(a:At):Promise<void>;
  current():{a:At;p:Project;ws:Workspace};
}

export function liveTools(d:LiveToolsDeps):McpTool[] {
  const liveDir=(folder?:string)=>join(d.folderOf(folder),'.live');
  async function index(folder?:string):Promise<{dir:string;meta:LiveMeta;ix:LiveIndex}> {
    const dir=liveDir(folder),meta=await maybeJson(join(dir,'live.json')) as LiveMeta|undefined,ix=await maybeJson(join(dir,'candidates.json')) as LiveIndex|undefined;
    if(!meta||!ix)throw new Error(`no scanned live in ${dir}: call live_scan first`);
    return {dir,meta,ix};
  }
  const row=(c:Candidate)=>`${c.id} ${hms(c.start)}-${hms(c.end)} (${Math.round(c.end-c.start)}s) score ${c.score.toFixed(2)}${c.rating?` rating ${c.rating}`:''}${c.cues.length?` [${c.cues.join(',')}]`:''}${c.what?` ${c.what}`:''}`;

  /** The clip's 9:16 plan applied to the open project: stacks and the reframe on its one clip. */
  async function applyPlan(ws:Workspace,a:At,clipId:string,plan:VerticalPlan):Promise<void> {
    const set=()=>{
      ws.frame={aspect:'9:16',speed:ws.frame?.speed??'default'};
      ws.stacks=plan.stacks.length?{[clipId]:plan.stacks}:undefined;
      ws.reframes=plan.reframe?{[clipId]:plan.reframe}:undefined;
      ws.motionTracks=undefined;
    };
    if(ws.segments.length)return change(ws,set);
    // No cut yet: save() has nothing to build, so keep the frame where the next open reads it.
    set();
    const file=join(a.dir,'state.json'),state=(await maybeJson(file) as Record<string,unknown>|undefined)??{};
    await writeFile(file,JSON.stringify({...state,frame:ws.frame,reframes:ws.reframes??null,stacks:ws.stacks??null,motionTracks:null},null,1));
  }
  const layoutFile=(a:At)=>join(a.dir,'live-layout.json');
  const sheets=async(a:At,file:string)=>{
    const s=await contactSheets(file,join(a.dir,'live-sheets'),'sheet');
    return Promise.all(s.slice(0,3).map(async f=>({data:new Uint8Array(await readFile(f)),mime:'image/jpeg' as const})));
  };
  const clipOf=(p:Project)=>{
    const c=p.job.clips[0];
    if(!c||c.ref.kind!=='video'||!c.ref.width||!c.ref.height)throw new Error('the open project is not a live clip (make one with live_make_clip)');
    const path=p.sources[c.ref.hash];
    if(!path)throw new Error(`no file for ${c.ref.id}`);
    return {id:c.ref.id,path,width:c.ref.width,height:c.ref.height,duration:c.ref.duration};
  };

  return [
    {name:'live_scan',description:'Index a finished livestream (8-12 h is fine): a local file or a URL (yt-dlp; only the sound is downloaded). Transcribes it in 30-min pieces (about $0.15 per hour of live on AssemblyAI, the engine when the server has ASSEMBLYAI_API_KEY; free with local Parakeet otherwise; pieces already done are never sent again), reads loudness, chat spikes, laughter, the streamer\'s markers and the most-replayed curve, and lists candidate moments in <folder>/.live/. A second call reuses all of it. Then live_candidates.',
      input:{folder:z.string().optional().describe('where .live/ and the clip folders go; default the server\'s folder'),
        source:z.string().min(1).describe('the live: a file (absolute, or relative to folder) or a URL'),
        chat:z.string().optional().describe('chat file: TwitchDownloader JSON, chat-downloader JSON, YouTube live_chat JSON lines, or "[h:mm:ss] name: message" lines'),
        markers:z.string().optional().describe('markers or chapters file: JSON, CSV or "h:mm:ss label" lines'),
        top:z.number().int().min(10).max(200).optional().describe('how many candidates at most (default 80)'),
        fresh:z.boolean().optional().describe('find the candidates again (the transcript is kept)')},
      run:async({folder,source,chat,markers,top,fresh},ctx)=>{
        const base=d.folderOf(folder),dir=liveDir(folder);
        const progress=(n:number,t:number,m:string)=>ctx.progress(n,t,m);
        const prev=await maybeJson(join(dir,'live.json')) as LiveMeta|undefined;
        const src=isUrl(source)?source:resolve(base,source);
        let meta:LiveMeta;
        if(prev&&prev.source===src)meta=prev;
        else if(isUrl(src)){ctx.progress(0,undefined,'reading the live page and its sound');meta=await fetchLive(src,dir);}
        else {
          if(!existsSync(src))return {text:`no such file: ${src}`,isError:true};
          meta={source:src,media:src,duration:(await probe(src)).duration};
        }
        await writeJson(join(dir,'live.json'),meta);
        const ix=await scanLive({source:meta.media,duration:meta.duration,dir,progress,...(fresh?{fresh}:{}),...(top?{top}:{}),
          ...(chat?{chat:resolve(base,chat)}:{}),...(markers?{markers:resolve(base,markers)}:{}),...(meta.heatmap?{heatmap:meta.heatmap}:{})});
        const kinds=[...new Set(ix.signals.map(s=>s.kind))];
        return {text:`${meta.title??meta.source}: ${hms(meta.duration)}, ${ix.signals.length} hints (${kinds.join(', ')||'none'}), ${ix.candidates.length} candidates in ${dir}\n\n${promptText(LIVE_PICK_PROMPT_ID)}`};
      }},

    {name:'live_candidates',description:'The candidate moments of the scanned live, best first (rating, then local score): id, time, cues, what happens. With id: that moment with the words said around it and its hints, to set exact bounds.',
      input:{folder:z.string().optional(),id:z.string().optional().describe('one candidate, with its words'),
        pad:z.number().min(0).max(120).optional().describe('seconds of words each side with id (default 30)'),
        limit:z.number().int().min(1).max(200).optional().describe('how many rows (default 40)')},
      run:async({folder,id,pad,limit})=>{
        const {ix}=await index(folder);
        if(id) {
          const c=ix.candidates.find(x=>x.id===id);
          if(!c)return {text:`no candidate ${id}`,isError:true};
          const t=await maybeJson(join(liveDir(folder),'transcript.json')) as {words:Parameters<typeof scanText>[1]}|undefined;
          return {text:`${row(c)}${c.why?`\nwhy: ${c.why}`:''}\n\n${scanText([c],t?.words??[],pad??30)}`};
        }
        const list=ix.candidates.slice(0,limit??40);
        return {text:`${ix.candidates.length} candidates${ix.rated?'':' (not rated yet)'}:\n${list.map(row).join('\n')}`};
      }},

    {name:'live_rate',description:'Rate candidates and set their exact bounds (15-90 s, setup and payoff inside): 1-10, a line on what happens and why it works. Kept in .live/candidates.json; the list re-ranks. Bounds outside 15-90 s or the live are ignored.',
      input:{folder:z.string().optional(),
        ratings:z.array(z.object({id:z.string(),rating:z.number().min(1).max(10),
          start:z.union([z.string(),z.number()]).optional().describe('h:mm:ss or seconds in the live'),end:z.union([z.string(),z.number()]).optional(),
          what:z.string().max(200).optional(),why:z.string().max(200).optional()})).min(1)},
      run:async({folder,ratings})=>{
        const {dir,meta,ix}=await index(folder);
        const rs=(ratings as {id:string;rating:number;start?:string|number;end?:string|number;what?:string;why?:string}[]).map(r=>{
          const start=stamp(r.start),end=stamp(r.end);
          return {id:r.id,rating:r.rating,...(r.what?{what:r.what}:{}),...(r.why?{why:r.why}:{}),...(start!==undefined?{start}:{}),...(end!==undefined?{end}:{})};
        });
        const unknown=rs.filter(r=>!ix.candidates.some(c=>c.id===r.id)).map(r=>r.id);
        const next:LiveIndex={...ix,candidates:ranked(mergeRatings(ix.candidates,rs,meta.duration))};
        await writeJson(join(dir,'candidates.json'),next);
        const kept=rs.filter(r=>{const c=next.candidates.find(x=>x.id===r.id);return c&&r.start!==undefined&&(c.start!==r.start||c.end!==r.end);}).map(r=>r.id);
        return {text:`rated ${rs.length-unknown.length}${unknown.length?`; unknown: ${unknown.join(', ')}`:''}${kept.length?`; bounds refused (15-90 s inside the live): ${kept.join(', ')}`:''}\n${next.candidates.slice(0,10).map(row).join('\n')}`};
      }},

    {name:'live_make_clip',description:'Make one candidate a clip and open it as the edit: cuts the passage (3 s more each side; from a URL only that passage is downloaded), opens it with its words from the live transcript (no new transcription), finds the webcam in its frames and frames it 9:16 (webcam over game, or a crop that follows the face). Shows the layout plan and contact sheets to check. Then edit as usual: set_cut, captions, render. Do not call set_frame on it (that drops the layout); fix the layout with live_layout.',
      input:{folder:z.string().optional(),id:z.string().describe('candidate id from live_candidates')},
      run:async({folder,id},ctx)=>{
        const {dir,meta,ix}=await index(folder);
        const c=ix.candidates.find(x=>x.id===id);
        if(!c)return {text:`no candidate ${id}`,isError:true};
        const t=await maybeJson(join(dir,'transcript.json')) as {words:Parameters<typeof prepareClip>[0]['words']}|undefined;
        ctx.progress(0,4,'cutting the passage');
        const clip=await prepareClip({root:dir,stem:`clip-${c.id}`,source:meta.source,start:c.start,end:c.end,liveDuration:meta.duration,
          words:t?.words??[],liveId:c.id,probe:f=>probe(f)});
        const a=projectAt(clip.folder),lines:string[]=[];
        ctx.progress(1,4,'opening the clip');
        if(!hasProject(a))
          await openProject(a,{files:[{path:clip.file,role:'a-roll',voice:false,synced:false}],proxies:false,vision:null},l=>{lines.push(l);});
        await d.load(a);
        const {p,ws}=d.current(),src=clipOf(p);
        ctx.progress(2,4,'finding the webcam');
        const faces=await d.faces();
        const samples=await sampleClip(src.path,join(a.dir,'live-samples'),faces??(async j=>j.map(()=>null)));
        const parts=detectLayout(samples);
        const plan=await planVertical(parts,src,src.duration);
        await applyPlan(ws,a,src.id,plan);
        await writeJson(layoutFile(a),plan.parts);
        ctx.progress(3,4,'contact sheets');
        const images=await sheets(a,src.path);
        return {text:`${a.folder}: ${hms(clip.offset)} in the live, ${src.duration.toFixed(1)}s, clip ${src.id}${faces?'':' (no face finder on this machine: check the layout by eye)'}\n${lines.join('\n')}\nlayout:\n${layoutText(plan.parts)}\n\n${promptText(LIVE_LAYOUT_PROMPT_ID)}\n\n${promptText(LIVE_TITLES_PROMPT_ID)}`,images};
      }},

    {name:'live_layout',description:'The open live clip\'s 9:16 layout: with no parts, the plan and contact sheets (one frame every 4 s). With parts, replace it: [{from, layout:"stack", facecam:{x,y,w,h}} | {from, layout:"full"|"game", x}], from in seconds of the clip, boxes in fractions of the frame (x, y = top-left).',
      input:{parts:z.array(z.record(z.string(),z.unknown())).optional()},
      run:async({parts})=>{
        const {a,p,ws}=d.current(),src=clipOf(p);
        if(!parts) {
          const saved=await maybeJson(layoutFile(a)) as LayoutPart[]|undefined;
          return {text:saved?layoutText(saved):'no layout yet',images:await sheets(a,src.path)};
        }
        const list:LayoutPart[]=readLayout(parts);
        if(!list.length)return {text:'no usable part: each needs from, layout and facecam (stack) or x (full, game)',isError:true};
        const plan=await planVertical(list,src,src.duration);
        await applyPlan(ws,a,src.id,plan);
        await writeJson(layoutFile(a),plan.parts);
        return {text:`layout:\n${layoutText(plan.parts)}${ws.segments.length?'':'\n(applies when the cut is set)'}`};
      }},
  ];
}
