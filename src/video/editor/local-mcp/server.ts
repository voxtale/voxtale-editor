// The VoxTale editor as a local MCP server (stdio or loopback HTTP), for any agent on the
// creator's machine: Claude Code, Codex, Cursor, or an agent driving another
// editor's MCP. One project at a time, kept in <folder>/.edit/. The app
// (apps/editor-mcp) only wires it up.
//
// Beyond the editor tools: open/resume a project, render, sheet, clips (file
// paths), export_timeline (Premiere/Resolve xmeml, FCPXML, OTIO + SRT), editing_guide. Footage
// labels (find_footage, screen_activity) follow VOXTALE_EDITOR_VISION
// (vision-mode.ts): openrouter, open labels with a Gemini model as the cloud
// planner does; harness, label_footage/save_labels hand it to the agent. Resources: the
// EditDoc schema, a guide to reading it, and the current edit. Prompt:
// edit-video.
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {editDocJsonSchema,EXPORT_TARGETS,exportTimeline,STYLE_PRESETS,toSrt,type ExportTarget} from '@voxtale/editdoc';
import {EXPORT_TIMELINE_DESCRIPTION} from './export-guide';
import {nativeFaceFinder} from '../../../native/bridge';
import {checkNatives,missingNote,type NativeCheck} from '../../../native/check';
import {uvFaceFinder} from '../../../native/uv-faces';
import type {VisionModel} from '../../footage-index';
import {askVision} from '../../openrouter';
import {styleOf} from '../agent/cut';
import {localGraphicsRenderer} from '../agent/remotion';
import {serveStdio,type McpServer,type McpTool,type Notify} from '../agent/mcp-protocol';
import {taskPrompt} from '../agent/plan';
import {z,type ToolResult} from '../agent/port';
import {jobTools,newWorkspace} from '../agent/session';
import type {Workspace} from '../agent/tools';
import {serveHttp} from './http';
import {EDITDOC_GUIDE,editingGuide,SERVER_INSTRUCTIONS} from './guide';
import {styleTools} from './style-tools';
import {labelTools} from './label-tools';
import {liveTools} from './live-tools';
import {visionMode} from './vision-mode';
import {stylesRoot} from '../styles/folder';
import {migrateGlobalRules} from '../styles/style-rules';
import {isPreset,useStyle} from '../styles/use';
import {OPEN_MEDIA_NOTE} from '../agent/media-skill-text';
import {clipFiles,clipLines,finalDoc,hasProject,keepProject,loadProject,openProject,projectAt,renderProject,sheetOf,
  type At,type OpenFile,type Ports,type Project,type Role} from './project';

export interface LocalEditorOptions {
  /** Footage folder used when a call names none; default EDIT_FOLDER, else the working folder. */
  folder?:string;
  /** Caption and graphic fonts (Inter). */
  fontsDir?:string;
  /** Graphics on this machine (installed on first use); Remotion unless VOXTALE_GRAPHICS_RENDERER=hyperframes; default on unless VOXTALE_GRAPHICS=off. */
  graphics?:boolean;
  /** Where graphics renderers install (remotion/, hyperframes/ under it); default ~/.voxtale-editor. */
  graphicsHome?:string;
  /** The old global rules file (before styles), moved once into the style "my-style"; default ~/.voxtale-editor/rules.json. */
  rulesFile?:string;
  /** Style folders (rules.md, style.json, brand/, references/); default VOXTALE_STYLES, else ~/.voxtale-editor/styles. */
  stylesDir?:string;
  /** Labels footage at open; default from VOXTALE_EDITOR_VISION (vision-mode.ts): the OpenRouter vision model, or null = harness (the agent labels). */
  vision?:VisionModel|null;
  version?:string;
  /** What this machine has of the face finder, subject mask and pixel font; default checked on first need (checkNatives). */
  natives?:Promise<NativeCheck>;
}

const ROLES:Record<string,[Role,boolean,boolean]>={talk:['a-roll',false,false],voiceover:['a-roll',true,false],broll:['b-roll',false,false],
  screen:['screen',false,false],screen_synced:['screen',false,true],music:['music',false,false],sfx:['sfx',false,false],
  camera:['other',false,true],mic:['mic',false,true]};
const STYLES=Object.keys(STYLE_PRESETS) as [string,...string[]];

/** Editor tools before a project opens: descriptions do not depend on the footage, so list them from an empty workspace. */
const blank=(graphics:boolean)=>newWorkspace({dir:'',job:{id:'edit',name:'',clips:[],style:styleOf(undefined)},frames:{} as Workspace['frames'],graphics});

/** The MCP server plus what the stdio entry needs before a client connects. */
export interface LocalEditorServer extends McpServer {
  /** Open the edit already in this folder, quietly (no tools/list_changed). */
  resume(a:At):Promise<void>;
  folderOf(folder?:string):string;
}

/** The server, for any transport. `notify` reaches the client (tools/list_changed after open). */
export function localEditorServer(o:LocalEditorOptions,notify:()=>Notify):LocalEditorServer {
  const graphics=o.graphics??process.env.VOXTALE_GRAPHICS!=='off';
  const mode=o.vision!==undefined?{mode:o.vision?'openrouter' as const:'harness' as const}:visionMode();
  if('warning' in mode&&mode.warning)console.error(mode.warning);
  const vision=o.vision!==undefined?o.vision:mode.mode==='openrouter'?(system:string,parts:Parameters<VisionModel>[1])=>askVision(system,parts):null;
  const harness=mode.mode==='harness';
  const folderOf=(f?:string)=>resolve(f??o.folder??process.env.EDIT_FOLDER??process.cwd());
  let natives=o.natives;
  const nativesOf=()=>(natives??=checkNatives(o.fontsDir?{fontsDir:o.fontsDir}:{}));
  /** Said on open and resume while something is missing, so the agent tells the creator. */
  const missing=async()=>{const n=missingNote(await nativesOf());return n?`\n\n${n}`:'';};
  // The venv's face finder when setup made it; else uv fetches OpenCV once.
  const facesOf=async()=>{const c=await nativesOf();return c.python&&c.faceModel?nativeFaceFinder:uvFaceFinder();};
  let ports:Promise<Ports>|undefined;
  const portsOf=()=>(ports??=facesOf().then(faces=>({...(faces?{faces}:{}),
    ...(graphics?{html:localGraphicsRenderer({home:o.graphicsHome??join(homedir(),'.voxtale-editor'),...(o.fontsDir?{fontsDir:o.fontsDir}:{})})}:{})})));

  let at:At|undefined;
  let open:{p:Project;ws:Workspace}|undefined;
  const styles=stylesRoot(o.stylesDir);
  let migrated:Promise<unknown>|undefined;
  /** Style folders, with the old global rules moved in on first use. */
  const root=async()=>{await (migrated??=migrateGlobalRules(styles,o.rulesFile??join(homedir(),'.voxtale-editor','rules.json')));return styles;};
  /** The open edit's style, read again: the creator may have edited rules.md or the brand since. The EditStyle (pace, caption look) stays the edit's. */
  async function refreshStyle(ws:Workspace):Promise<void> {
    const u=ws.job.styleUse;
    if(!u)return;
    const r=await useStyle(await root(),u.slug,u.usage).catch(()=>undefined);
    if(!r)return;
    ws.job.styleUse=r.use;
    ws.job.rules=r.use.rules;
  }
  async function load(a:At,announce=true):Promise<void> {
    open=await loadProject(a,await portsOf());
    await refreshStyle(open.ws);
    at=a;
    // The footage decides which editor tools apply.
    if(announce)notify()('notifications/tools/list_changed',{});
  }
  function current():{a:At;p:Project;ws:Workspace} {
    if(!at||!open)throw new Error('no project open: call open (new footage) or resume (an edit already in .edit/)');
    return {a:at,...open};
  }
  const empty=blank(graphics);
  // The cloud harness starts every edit with the craft guide as its system
  // prompt and the job brief as its task. An MCP server cannot set a system
  // prompt, so open/resume hand over both: the brief always, the guide once
  // per session unless the agent already read it.
  let guided=false;
  const guide=()=>{guided=true;return editingGuide(graphics,!!vision);};
  const brief=(ws:Workspace)=>`Brief:\n${taskPrompt(ws.job,graphics)}\nThen render, and look at the result with sheet.`
    +(ws.job.styleUse?'':`\nNo style folder chosen for this edit: if the creator has styles (styles lists them), ask which one to follow and call use_style.`)
    +(guided?'':`\n\n--- Editing guide (read before the first edit) ---\n${guide()}`);

  const folderArg=z.string().optional().describe('footage folder (absolute); default: the server\'s EDIT_FOLDER or working folder');
  const SERVER:McpTool[]=[
    {name:'editing_guide',description:'How to edit well with these tools: workflow, cutting, rhythm, zoom, captions, footage. Read it before the first edit.',
      input:{},run:async()=>({text:guide()})},

    {name:'open',description:'Start an edit from footage files: reads each file, transcribes speech (about 1 min per 10 min of speech), labels b-roll and screen clips with a vision model when the server has one (for find_footage; a few cents per minute of footage, kept for the next open; else label_footage hands them to you) and opens the project in <folder>/.edit/. Starts over if an edit is already there (use resume to continue it). Roles: talk (the speaker on camera), voiceover (sound only; the picture is your footage), broll, screen, screen_synced (a screen recorded together with the speaker), music, sfx. The clips in the cut set the picture\'s shape: a speaker in it, else the shape with the most screen time. A talk clip with no spoken words opens as broll, with a warning. Lists the clips when done. '+OPEN_MEDIA_NOTE,
      input:{folder:folderArg,
        files:z.array(z.object({path:z.string().describe('absolute, or relative to folder'),role:z.enum(Object.keys(ROLES) as [string,...string[]])})).min(1),
        format:z.enum(['vertical','horizontal']).optional().describe('voiceover only: the picture\'s shape; default the first footage\'s'),
        style:z.string().max(80).optional().describe(`edit style: a preset (${STYLES.join(', ')}) or a style folder by name (styles lists them): its rules, measured pace and brand load into the brief`),
        usage:z.string().max(40).optional().describe('style folder only: which measured set (long, short...); default its only one'),
        target:z.number().positive().max(3600).optional().describe('target length, seconds'),
        note:z.string().max(2000).optional().describe('what the creator asked for'),
        proxies:z.boolean().optional().describe('make light 720p copies of heavy video (default true)')},
      run:async({folder,files,format,style,usage,target,note,proxies},ctx)=>{
        const a=projectAt(folderOf(folder)),lines:string[]=[];
        const log=(l:string)=>{lines.push(l);console.error(l);ctx.progress(lines.length,undefined,l.trim());};
        const of=(files as {path:string;role:string}[]).map(f=>{const [role,voice,synced]=ROLES[f.role]!;return {path:f.path,role,voice,synced} satisfies OpenFile;});
        const styled=style&&!isPreset(style)?await useStyle(await root(),style,usage):undefined;
        await openProject(a,{files:of,...(format?{format}:{}),...(style&&!styled?{style}:{}),...(styled?{styled}:{}),...(target?{target}:{}),...(note?{instruction:note}:{}),proxies:proxies!==false,vision},log);
        await load(a);
        return {text:`${lines.join('\n')}\n\nOpen: ${a.folder}\nclips:\n${clipLines(open!.ws)}${await missing()}\n\n${brief(open!.ws)}`};
      }},

    {name:'resume',description:'Continue the edit already in <folder>/.edit/.',
      input:{folder:folderArg},
      run:async({folder})=>{
        const a=projectAt(folderOf(folder));
        if(!hasProject(a))return {text:`No edit in ${a.dir}: call open with the footage.`,isError:true};
        await load(a);
        const {ws}=current();
        return {text:`Resumed ${a.folder}\nclips:\n${clipLines(ws)}\n${ws.doc?`cut: ${Math.max(0,...ws.doc.tracks['a-roll'].map(x=>x.end)).toFixed(1)}s, ${ws.segments.length} segments`:'no cut yet'}${await missing()}\n\n${brief(ws)}`};
      }},

    {name:'render',description:'Render the edit to an MP4 (default <folder>/final.mp4). Takes about as long as the video, or longer. width, height and fps set the delivered file when a brief asks for one (default: the cut\'s own canvas and rate); the cut is scaled whole into that frame, letterboxed or pillarboxed (fit contain, the default), never cropped unless fit is cover. The result reports the file\'s actual size, frame rate and length. Then look at it with sheet.',
      input:{out:z.string().optional().describe('output file, absolute or relative to the folder'),
        width:z.number().int().min(320).max(7680).optional().describe('delivered width, px (even)'),
        height:z.number().int().min(240).max(4320).optional().describe('delivered height, px (even)'),
        fps:z.number().positive().max(120).optional().describe('delivered frame rate'),
        fit:z.enum(['contain','cover']).optional().describe('contain (default): whole picture, black bars; cover: fill and crop')},
      run:async({out,width,height,fps,fit},ctx)=>{
        const {a,p,ws}=current();
        let last=-1;
        const output={...(width?{width}:{}),...(height?{height}:{}),...(fps?{fps}:{}),...(fit?{fit}:{})};
        const r=await renderProject(a,p,ws,{...(out?{out}:{}),...(o.fontsDir?{fontsDir:o.fontsDir}:{}),output,progress:f=>{
          const pc=Math.round(f*100);
          if(pc!==last){last=pc;ctx.progress(pc,100,`rendering ${pc}%`);}
        }});
        const x=r.actual,canvas=ws.doc!.canvas;
        const shaped=(width||height)&&(x.width!==canvas.width||x.height!==canvas.height)?` (cut composed at ${canvas.width}x${canvas.height}, ${fit==='cover'?'cropped to fill':'scaled whole with black bars'})`:'';
        return {text:`${r.file} (${r.seconds.toFixed(0)}s to render)\nfile: ${x.width}x${x.height}, ${+x.fps.toFixed(3)} fps, ${x.duration.toFixed(2)}s${shaped}${r.skipped.length?`\nleft out: ${r.skipped.join(', ')}`:''}${r.unmasked.length?`\nover the speaker, not behind: ${r.unmasked.join('; ')}`:''}${r.loudness.length?`\nloudness:\n- ${r.loudness.join('\n- ')}`:''}${r.graded.length?`\ngraded: ${r.graded.join(', ')}`:''}`};
      }},

    {name:'sheet',description:'16 frames of a rendered video in one picture, to check what the viewer sees: black frames, captions over faces, footage that misses the words.',
      input:{video:z.string().optional().describe('default <folder>/final.mp4')},
      run:async({video})=>{
        const {a}=current();
        const s=await sheetOf(a,video);
        return {text:s.text,images:[{data:new Uint8Array(await readFile(s.image)),mime:'image/jpeg'}]};
      }},

    {name:'clips',description:'Every clip in the edit with the file it plays (absolute path), its role, length and size; the rendered graphics; and where the EditDoc is. Use it to rebuild the edit in another editor.',
      input:{},
      run:async()=>{
        const {a,p,ws}=current();
        const graphics=Object.entries(ws.graphics).map(([assetId,g])=>({assetId,webm:g.webm,seconds:g.seconds}));
        return {text:JSON.stringify({editDoc:resolve(a.dir,'edit.json'),clips:clipFiles(p),...(graphics.length?{graphics}:{})},null,1)};
      }},

    {name:'export_timeline',description:EXPORT_TIMELINE_DESCRIPTION,
      input:{
        target:z.enum(EXPORT_TARGETS as [ExportTarget,...ExportTarget[]]).optional().describe('premiere, resolve, finalcut or otio'),
        format:z.enum(['fcpxml','otio']).optional().describe('old name: fcpxml = finalcut'),
        out:z.string().optional().describe('file, absolute or relative to the folder; default <folder>/edit-<target>.<ext>'),
      },
      run:async({target,format,out})=>{
        const {a,p,ws}=current();
        if(!ws.doc)return {text:'No cut yet: set_cut first.',isError:true};
        const to:ExportTarget|undefined=target??(format==='fcpxml'?'finalcut':format==='otio'?'otio':undefined);
        if(!to)return {text:`Say which app: target ${EXPORT_TARGETS.join(', ')}.`,isError:true};
        const doc=finalDoc(p,ws.doc);
        const media={
          clipPath:(c:{hash:string;id:string})=>{
            const f=p.sources[c.hash];
            if(!f)throw new Error(`no file for clip ${c.id}`);
            return f;
          },
          // Rendered graphics are WebM with alpha (Premiere needs a WebM plug-in to read it).
          graphicPath:(g:{assetId:string})=>{
            const r=ws.graphics[g.assetId];
            return r?{path:resolve(r.webm),duration:r.seconds,fps:doc.fps}:undefined;
          },
        };
        const r=exportTimeline(doc,media,to);
        const file=resolve(a.folder,out??`edit-${to}.${r.extension}`),srt=file.replace(/\.[^./\\]+$/,'')+'.srt';
        await writeFile(file,r.text);
        await writeFile(srt,toSrt(doc));
        const missing=p.job.clips.filter(c=>!existsSync(p.sources[c.ref.hash]??'')).map(c=>c.ref.name);
        const lost=r.losses.map(l=>`- ${l.feature}: ${l.note} (${l.items.slice(0,6).join(', ')}${l.items.length>6?` +${l.items.length-6}`:''})`);
        return {text:[`${r.app}, ${r.format}`,file,srt,
          ...(lost.length?['not carried:',...lost]:['everything in the edit carried']),
          ...(missing.length?[`missing on disk (the editor will ask for them): ${missing.join(', ')}`]:[])].join('\n')};
      }},
    ...liveTools({folderOf,faces:async()=>(await portsOf()).faces,load:a=>load(a),current}),
    ...styleTools({root,current:()=>open&&at?{ws:open.ws,keep:()=>keepProject(at!,open!.p,open!.ws)}:undefined}),
    ...(harness?labelTools({current:()=>open&&at?{dir:at.dir,ws:open.ws,keep:()=>keepProject(at!,open!.p,open!.ws)}:undefined,
      changed:()=>notify()('notifications/tools/list_changed',{})}):[]),
  ];
  const serverNames=new Set(SERVER.map(t=>t.name));

  /** Editor tools for the open project; each call keeps what it changed in .edit/. */
  const editor=():McpTool[]=>jobTools(open?.ws??empty).filter(t=>!serverNames.has(t.name)).map(t=>({...t,run:async(args:any):Promise<ToolResult>=>{
    const {a,p,ws}=current();
    // The live tool, bound to the open workspace (the listed one may be the empty one).
    const live=jobTools(ws).find(x=>x.name===t.name);
    if(!live)return {text:`${t.name} does not apply to this project.`,isError:true};
    try {
      return await live.run(args);
    }
    finally {await keepProject(a,p,ws);}
  }}));

  return {
    name:'voxtale-editor',version:o.version??'0.1.0',instructions:SERVER_INSTRUCTIONS,listChanged:true,serial:true,
    tools:()=>[...SERVER,...editor()],
    prompts:[{name:'edit-video',description:'Edit raw footage into a finished video with the VoxTale editor.',text:()=>guide()}],
    resources:[
      {uri:'editdoc://guide',name:'EditDoc guide',description:'How to read a VoxTale edit (times, tracks, fields) to rebuild it in another editor.',mimeType:'text/markdown',
        read:()=>EDITDOC_GUIDE},
      {uri:'editdoc://schema',name:'EditDoc JSON Schema',description:'The full schema of .edit/edit.json.',mimeType:'application/schema+json',
        read:()=>JSON.stringify(editDocJsonSchema(),null,1)},
      {uri:'editdoc://current',name:'Current edit',description:'The open project\'s EditDoc (.edit/edit.json) as the viewer gets it.',mimeType:'application/json',
        read:()=>{
          const {p,ws}=current();
          if(!ws.doc)throw new Error('no cut yet: set_cut first');
          return JSON.stringify(finalDoc(p,ws.doc),null,1);
        }},
    ],
    resume:async a=>{if(hasProject(a))await load(a,false);},
    folderOf,
  };
}

/** The bearer token for HTTP: VOXTALE_EDITOR_TOKEN, else kept in <home>/mcp-token (made once, owner-only). */
export async function editorToken(home=join(homedir(),'.voxtale-editor'),env=process.env.VOXTALE_EDITOR_TOKEN):Promise<{token:string;file?:string}> {
  if(env?.trim())return {token:env.trim()};
  const file=join(home,'mcp-token');
  const kept=await readFile(file,'utf8').then(t=>t.trim(),()=>'');
  if(kept)return {token:kept,file};
  const token=randomBytes(24).toString('base64url');
  await mkdir(home,{recursive:true});
  await writeFile(file,`${token}\n`,{mode:0o600});
  return {token,file};
}

export interface RunOptions extends LocalEditorOptions {
  /** Serve MCP Streamable HTTP on loopback instead of stdio. */
  http?:{port?:number;host?:string;token?:string};
}

/**
 * Run the server on stdio, or on a loopback port with `http`. An edit already
 * in the default folder opens by itself. Checks the face finder, subject mask
 * and pixel font at start and says on stderr what is missing.
 */
export async function runLocalEditor(o:RunOptions={}):Promise<void> {
  if(!o.http)console.log=console.error;  // stdout is the protocol
  const natives=o.natives??checkNatives(o.fontsDir?{fontsDir:o.fontsDir}:{});
  void natives.then(c=>{const n=missingNote(c);if(n)console.error(n);});
  let send:Notify=()=>{};
  const server=localEditorServer({...o,natives},()=>send);
  const start=projectAt(server.folderOf());
  await server.resume(start).catch(e=>console.error(`could not resume ${start.dir}: ${e instanceof Error?e.message:e}`));
  if(!o.http){send=serveStdio(server).notify;return;}
  const {token,file}=o.http.token?{token:o.http.token,file:undefined}:await editorToken();
  const end=await serveHttp(server,{token,...(o.http.port!==undefined?{port:o.http.port}:{}),...(o.http.host?{host:o.http.host}:{})});
  send=end.notify;
  console.error(`VoxTale editor MCP: ${end.url}\ntoken: ${file?`${file} (or set VOXTALE_EDITOR_TOKEN)`:'from VOXTALE_EDITOR_TOKEN'}\n`
    +`Claude Code: claude mcp add --transport http voxtale-editor ${end.url} --header "Authorization: Bearer ${file?`$(cat ${file})`:'$VOXTALE_EDITOR_TOKEN'}"\n`
    +'Codex, Cursor: see apps/editor-mcp/README.md');
  const stop=()=>{void end.close().then(()=>process.exit(0));};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
