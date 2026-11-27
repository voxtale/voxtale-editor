// One-step setup for the local editor: the Python env for the face finder and
// subject mask (.venv, with uv when present, else python3 -m venv + pip), the
// two models in models/ (shipped in git; fetched again only if lost) and the
// pixel font. Reports the transcription model (tools/fetch-parakeet.sh) without
// fetching it or failing. Safe to run again: it skips what is already there.
//
//   bun run setup            (also runs after `bun install`, with --soft)
//   --soft  never fail: print what is missing and exit 0 (bun install must not break)
// Skip it in `bun install` with VOXTALE_EDITOR_SKIP_SETUP=1.
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO_ROOT,venvPython} from '../src/native/bridge';
import {checkNatives,missingNote,SUBJECT_MODEL,transcriberLine} from '../src/native/check';
import {spawnText} from '../src/spawn';

const soft=process.argv.includes('--soft');
if(soft&&process.env.VOXTALE_EDITOR_SKIP_SETUP==='1')process.exit(0);

const ROOT=REPO_ROOT,FONTS=join(ROOT,'apps/editor-mcp/fonts');
const SUBJECT_URL='https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx';
const SUBJECT_SHA='309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const say=(l:string)=>console.log(`setup: ${l}`);

const run=async(cmd:string,args:string[])=>{
  const r=await spawnText(cmd,args,{cwd:ROOT,timeoutMs:15*60_000}).catch(e=>({code:-1,stdout:'',stderr:String(e)}));
  if(r.code)throw new Error(`${cmd} ${args.join(' ')} failed:\n${(r.stderr||r.stdout).trim().slice(-800)}`);
  return r.stdout.trim();
};
const has=(cmd:string)=>spawnText(cmd,['--version'],{timeoutMs:10_000}).then(r=>r.code===0,()=>false);

async function subjectModel():Promise<void> {
  const out=join(ROOT,'models',SUBJECT_MODEL);
  if(existsSync(out))return;
  say(`fetching ${SUBJECT_MODEL} (4.6 MB)`);
  const res=await fetch(SUBJECT_URL);
  if(!res.ok)throw new Error(`${SUBJECT_URL}: HTTP ${res.status}`);
  const bytes=new Uint8Array(await res.arrayBuffer());
  const sum=createHash('sha256').update(bytes).digest('hex');
  if(sum!==SUBJECT_SHA)throw new Error(`${SUBJECT_MODEL} checksum mismatch: ${sum}`);
  await mkdir(join(ROOT,'models'),{recursive:true});
  await writeFile(`${out}.part`,bytes);
  await rename(`${out}.part`,out);
}

async function pythonEnv():Promise<void> {
  const py=venvPython(ROOT),req=join(ROOT,'requirements.txt');
  const works=async()=>existsSync(py)&&await spawnText(py,['-c','import cv2, numpy'],{cwd:ROOT,timeoutMs:60_000}).then(r=>r.code===0,()=>false);
  // Reinstall when requirements.txt changed since the last setup.
  const want=createHash('sha256').update(await readFile(req)).digest('hex'),stamp=join(ROOT,'.venv','.voxtale-requirements');
  if(await works()&&await readFile(stamp,'utf8').then(s=>s.trim()===want,()=>false))return;
  if(await has('uv')) {
    say('making .venv with uv');
    if(!existsSync(py))await run('uv',['venv','--quiet','--python','3.12',join(ROOT,'.venv')]);
    await run('uv',['pip','install','--quiet','--python',py,'-r',req]);
  }
  else {
    const sys=process.platform==='win32'?'python':'python3';
    if(!await has(sys))throw new Error('no uv and no python3: install uv (https://docs.astral.sh/uv/) and run bun run setup again');
    say(`making .venv with ${sys} -m venv (install uv for a faster setup)`);
    if(!existsSync(py)) {await rm(join(ROOT,'.venv'),{recursive:true,force:true});await run(sys,['-m','venv',join(ROOT,'.venv')]);}
    await run(py,['-m','pip','install','--quiet','-r',req]);
  }
  if(!await works())throw new Error(`.venv made, but ${py} cannot import cv2 and numpy`);
  await writeFile(stamp,`${want}\n`);
}

const errors:string[]=[];
for(const [name,step] of [['subject mask model',subjectModel],['Python env',pythonEnv]] as const)
  await step().catch(e=>errors.push(`${name}: ${e instanceof Error?e.message:String(e)}`));

const c=await checkNatives({root:ROOT,python:venvPython(ROOT),fontsDir:FONTS});
for(const e of errors)console.error(`setup: ${e}`);
// The transcription model is reported, never failing setup: it is a separate fetch (tools/fetch-parakeet.sh).
const note=missingNote(c);
if(note)console.error(note);
say(transcriberLine(c));
if(c.missing.length) {if(!soft)process.exit(1);}
else say(`ready: face finder, subject mask, pixel font (${venvPython(ROOT)})`);
