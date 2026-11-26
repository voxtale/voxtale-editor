#!/usr/bin/env bun
import {ffmpegPath} from './video/ffmpeg-path';
import {parseArgs} from 'node:util';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {editSchema, durationFrames, timeline, parseSrt, keepOutsideSilence} from './video/model';
import {loadEdit, probe, run, silenceRanges, validateMedia} from './video/media';

const help=`Local footage editor — local rendering, optional paid transcription and planning.

bun run video init --source recording.mp4 --out edit.json
bun run video transcribe edit.json --out transcript.json
bun run video select-takes edit.json --transcript transcript.json --out takes-v1
bun run video graphics takes-v1/edit.json --transcript transcript.json --out graphics-v1
bun run video produce edit.json --out production-v1
bun run video check edit.json
bun run video suggest-cuts edit.json --out suggested.json
bun run video captions edit.json --srt transcript.srt --out captioned.json
bun run video revise edit.json --patch changes.json --out revised.json
bun run video preview edit.json --out preview-v1
bun run video render edit.json --out render-v1
bun run video render-doc editdoc.json --media DIR [--graphics DIR] --out out.mp4
bun run video parity editdoc.json --a desktop.mp4 --b cloud.mp4

Edit JSON scenes use original footage seconds (in/out). Scenes play in array order.
Captions also use original footage time and follow cuts automatically.
revise accepts a top-level JSON patch; arrays replace the whole array.
suggest-cuts replaces scene ranges with a silence-cut proposal. Review before rendering.
Preview makes a 640px-wide MP4. Each render gets a NEW directory; none are overwritten.
produce runs transcription → take selection → graphics → preview, with saved stages.
Set ASSEMBLYAI_API_KEY and OPENROUTER_API_KEY for those stages.
--model overrides VIDEO_EDIT_MODEL; --plan uses a reviewed JSON plan without an LLM call.
select-takes: --confidence 0.85 (default), --keep-pauses disables long-pause trimming.
transcribe: --transcript-id ID resumes an existing AssemblyAI job.
Requires Bun, FFmpeg/ffprobe. First render may download Remotion's browser.
See src/video/README.md for graphics, B-roll and music.`;
async function save(path:string,value:unknown) {
  const dest=resolve(path);await mkdir(dirname(dest),{recursive:true});
  await writeFile(dest,JSON.stringify(value,null,2)+'\n',{flag:'wx'});console.log(dest);
}
export async function cmdVideo(args:string[]) {
  const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,
    options:{source:{type:'string'},out:{type:'string'},srt:{type:'string'},patch:{type:'string'},transcript:{type:'string'},model:{type:'string'},plan:{type:'string'},confidence:{type:'string'},'keep-pauses':{type:'boolean'},'transcript-id':{type:'string'},media:{type:'string'},graphics:{type:'string'},ffmpeg:{type:'string'},a:{type:'string'},b:{type:'string'},help:{type:'boolean'}}});
  const [command,path]=positionals;
  if(values.help || !command || command==='help'){console.log(help);return;}
  if(command==='render-doc'||command==='parity') {await editDocCommand(command,path,values);return;}
  if(!['init','check','suggest-cuts','captions','revise','preview','render','transcribe','select-takes','graphics','produce'].includes(command))throw new Error(`Unknown command: ${command}`);
  if(command!=='check' && !values.out)throw new Error('--out is required');
  if(command==='init') {
    if(!values.source)throw new Error('--source is required');
    const source=resolve(values.source),info=await probe(source);
    if(!info.video || !Number.isFinite(info.duration))throw new Error('Source must be video footage');
    const edit=editSchema.parse({version:1,name:'Untitled edit',source,scenes:[{id:'scene-1',in:0,out:Math.floor(info.duration*30)/30}]});
    await save(values.out!,edit);return;
  }
  if(!path)throw new Error('Edit JSON path is required');
  const edit=await loadEdit(path);
  if(command==='transcribe') {
    const {transcribe}=await import('./video/transcript');await transcribe(edit,values.out!,{progress:console.error,transcriptId:values['transcript-id']});console.log(resolve(values.out!));return;
  }
  if(command==='select-takes'||command==='graphics') {
    if(!values.transcript)throw new Error('--transcript is required');
    await validateMedia(edit);
    const {stage}=await import('./video/stages');
    await stage(command==='select-takes'?'takes':'graphics',edit,values.transcript,values.out!,{progress:console.error,model:values.model,plan:values.plan,confidence:values.confidence===undefined?undefined:Number(values.confidence),keepPauses:values['keep-pauses']});console.log(resolve(values.out!,'edit.json'));return;
  }
  if(command==='produce') {
    await validateMedia(edit);
    const {produce}=await import('./video/produce');console.log(await produce(edit,values.out!,{progress:console.error,model:values.model}));return;
  }
  if(command==='check') {await validateMedia(edit);console.log(JSON.stringify({name:edit.name,seconds:durationFrames(edit)/edit.fps,frames:durationFrames(edit),scenes:timeline(edit)},null,2));return;}
  if(command==='captions') {
    if(!values.srt)throw new Error('--srt is required');
    edit.captions=parseSrt(await readFile(values.srt,'utf8'));await save(values.out!,editSchema.parse(edit));return;
  }
  if(command==='revise') {
    if(!values.patch)throw new Error('--patch is required');
    const patch=JSON.parse(await readFile(values.patch,'utf8'));
    // Resolve media paths against the original edit file, even when writing elsewhere.
    const next=editSchema.parse({...edit,...patch});
    const {localPath}=await import('./video/media');
    next.source=localPath(dirname(resolve(path)),next.source);
    for(const s of next.scenes)if(s.broll)s.broll.path=localPath(dirname(resolve(path)),s.broll.path);
    if(next.music)next.music.path=localPath(dirname(resolve(path)),next.music.path);
    await validateMedia(next);await save(values.out!,next);return;
  }
  if(command==='suggest-cuts') {
    const info=await validateMedia(edit);
    if(!info.audio)throw new Error('Source has no audio to analyze');
    const log=await run(ffmpegPath(),['-hide_banner','-nostdin','-i',edit.source,'-af','silencedetect=noise=-35dB:d=0.6','-vn','-f','null','-']);
    const ranges=silenceRanges(log,info.duration);
    // Preserve existing scene edits and ordering; intersect cuts with each kept scene.
    const parents=new Map<string,string>();
    edit.scenes=edit.scenes.flatMap(scene=>keepOutsideSilence(scene.out-scene.in,ranges.map(r=>({start:r.start-scene.in,end:r.end-scene.in})))
      .filter(r=>Math.round(r.out*edit.fps)>Math.round(r.in*edit.fps))
      .map((r,i)=>{parents.set(`${scene.id}-${i+1}`,scene.id);return ({...scene,id:`${scene.id}-${i+1}`,in:scene.in+r.in,out:scene.in+r.out,
        ...(scene.broll?{broll:{...scene.broll,in:scene.broll.in+r.in}}:{}),
        ...(scene.graphics?{graphics:scene.graphics.map(g=>({...g,in:Math.max(g.in,scene.in+r.in),out:Math.min(g.out,scene.in+r.out)})).filter(g=>g.out-g.in>=1/edit.fps)}:{})});}));
    edit.captions=edit.captions.flatMap(c=>c.sceneId?edit.scenes.filter(s=>parents.get(s.id)===c.sceneId).map(s=>({...c,sceneId:s.id})): [c]);
    await save(values.out!,editSchema.parse(edit));console.error('Proposal only: review scene ranges and pauses before rendering.');return;
  }
  const {render}=await import('./video/render');await render(edit,values.out!,command==='preview',console.error);console.log(resolve(values.out!,'video.mp4'));
}


/** EditDoc JSON (bare or wrapped in {doc}) → parsed doc. */
async function readDoc(path:string|undefined) {
  if(!path)throw new Error('EditDoc JSON path is required');
  const {parseEditDoc}=await import('@voxtale/editdoc');
  const raw=JSON.parse(await readFile(path,'utf8'));
  return parseEditDoc(raw.doc??raw).doc;
}

/** Files in `dir` by content hash (sha256), as the EditDoc names clips. */
async function filesByHash(dir:string):Promise<Record<string,string>> {
  const {readdir}=await import('node:fs/promises');
  const out:Record<string,string>={};
  for(const name of await readdir(dir)) {
    const file=resolve(dir,name);
    const hasher=createHash('sha256');
    for await(const chunk of createReadStream(file))hasher.update(chunk as Buffer);
    out[hasher.digest('hex')]=file;
  }
  return out;
}

async function editDocCommand(command:string,path:string|undefined,values:Record<string,string|boolean|undefined>) {
  const doc=await readDoc(path);
  const ffmpeg=typeof values.ffmpeg==='string'?values.ffmpeg:undefined;
  const {tmpdir}=await import('node:os');
  const work=resolve(tmpdir(),`voxtale-editor-render-${process.pid}`);
  if(command==='render-doc') {
    if(typeof values.media!=='string'||typeof values.out!=='string')throw new Error('--media and --out are required');
    const media=await filesByHash(values.media);
    // Graphics folder: <assetId>.webm files.
    const graphics:Record<string,string>={};
    if(typeof values.graphics==='string') {
      const {readdir}=await import('node:fs/promises');
      for(const f of await readdir(values.graphics))if(f.endsWith('.webm'))graphics[f.slice(0,-5)]=resolve(values.graphics,f);
    }
    const {renderEditDoc}=await import('./video/render-edit');
    const {nativeSubjectMask}=await import('./native/bridge');
    const r=await renderEditDoc({doc,media,graphics,out:resolve(values.out),work,subjectMask:m=>nativeSubjectMask(m,w=>console.error(w)),...(ffmpeg?{ffmpeg}:{}),progress:f=>console.error(`${Math.round(f*100)}%`)});
    console.log(JSON.stringify(r,null,2));return;
  }
  if(typeof values.a!=='string'||typeof values.b!=='string')throw new Error('--a and --b are required');
  const {mkdir}=await import('node:fs/promises');await mkdir(work,{recursive:true});
  const {checkParity}=await import('./video/parity');
  const r=await checkParity({doc,a:resolve(values.a),b:resolve(values.b),work,...(ffmpeg?{ffmpeg}:{})});
  console.log(JSON.stringify(r,null,2));
  if(r.problems.length)process.exitCode=1;
}

// Prompts register on import; the CLI needs them loaded.
import "./video/prompts";
if (import.meta.main) {
  cmdVideo(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
