// Remotion: the default graphics renderer. It renders the same composition the
// agent writes for HyperFrames (index.html + kit.css, a paused GSAP timeline in
// window.__timelines.main): sandbox/remotion/entry.jsx loads it in an iframe and
// seeks the timeline once per frame. So the tools and skill stay the same; only
// the engine changes. Pick the engine with VOXTALE_GRAPHICS_RENDERER.
// Licence: Remotion is free for individuals and companies of up to 3 people; a
// larger company needs a paid Remotion company licence.
import {chmod,cp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {spawnText} from '../../../spawn';
import type {HtmlRenderer} from './frames';
import {dockerHtmlRenderer,HF_IMAGE,hyperframesReady,localHtmlRenderer} from './hyperframes';

export type GraphicsEngine='remotion'|'hyperframes';
export const GRAPHICS_ENGINES:readonly GraphicsEngine[]=['remotion','hyperframes'];

/** The engine a deployment or creator picked: VOXTALE_GRAPHICS_RENDERER, default remotion. */
export function graphicsEngine(v:string|undefined=process.env.VOXTALE_GRAPHICS_RENDERER):GraphicsEngine {
  const e=(v??'').trim().toLowerCase();
  return e==='hyperframes'||e==='hf'?'hyperframes':'remotion';
}

export const REMOTION_IMAGE=process.env.VOXTALE_REMOTION_IMAGE??'voxtale-remotion-sandbox:1';
const SANDBOX=join(import.meta.dir,'sandbox','remotion');

const DOCKER_FLAGS=['--network','none','--read-only','--tmpfs','/tmp:rw,size=2g,exec','--tmpfs','/home/render:rw,size=256m,exec,uid=10001,gid=10001',
  '-e','REMOTION_DISABLE_TELEMETRY=1','-e','DO_NOT_TRACK=1',
  '--memory','3g','--cpus','2','--pids-limit','1024','--cap-drop','ALL','--security-opt','no-new-privileges','--shm-size','512m'];

const tail=(s:string,n=1500)=>s.length>n?`…${s.slice(-n)}`:s;

async function imageReady(image:string):Promise<boolean> {
  try {return (await spawnText('docker',['image','inspect',image],{timeoutMs:10_000})).code===0;}
  catch {return false;}
}

/** Docker is running and has the Remotion image. */
export const remotionReady=(image=REMOTION_IMAGE)=>imageReady(image);

export const dockerRemotionRenderer=(image=REMOTION_IMAGE):HtmlRenderer=>async({dir,width,height,seconds})=>{
  const outDir=join(dirname(dir),'docker-out');
  await rm(outDir,{recursive:true,force:true});
  await mkdir(outDir,{recursive:true});
  await chmod(dirname(dir),0o755);await chmod(dir,0o755);await chmod(outDir,0o777);
  const env=['-e',`W=${Math.round(width)}`,'-e',`H=${Math.round(height)}`,'-e',`S=${Number(seconds)}`];
  const {code,stderr}=await spawnText('docker',['run','--rm',...DOCKER_FLAGS,...env,'-v',`${dir}:/job/in:ro`,'-v',`${outDir}:/job/out`,image],{timeoutMs:5*60_000});
  const read=async(f:string)=>{try {return await readFile(join(outDir,f),'utf8');} catch {return '';}};
  return report(join(outDir,'graphic.webm'),await read('render.txt')||stderr,(await read('fonts.txt')).split('\n'),code);
};

async function report(webm:string,out:string,fonts:string[],code:number) {
  const ok=await readFile(webm).then(b=>b.length>0,()=>false);
  const f=fonts.filter(x=>x&&!/Italic/.test(x));
  const text=['engine: remotion (no lint step)',`fonts in ./fonts/: ${f.join(', ')||'unknown'}`,ok?'render: ok':`render failed (exit ${code}):\n${tail(out)}`].join('\n');
  return ok?{ok,webm,report:text}:{ok,report:text};
}

// ---- on this machine, no Docker ----

async function run(cmd:string[],o:{cwd?:string;timeoutMs?:number}={}):Promise<{code:number;out:string}> {
  const p=Bun.spawn(cmd,{...(o.cwd?{cwd:o.cwd}:{}),env:{...process.env,REMOTION_DISABLE_TELEMETRY:'1',DO_NOT_TRACK:'1'},stdout:'pipe',stderr:'pipe',stdin:'ignore'});
  const timer=setTimeout(()=>p.kill(),o.timeoutMs??10*60_000);
  try {
    const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);
    return {code:await p.exited,out:`${out}${err}`};
  } finally {clearTimeout(timer);}
}

/** Remotion installed once into `home` from sandbox/remotion/package.json, with entry.jsx, render.mjs and scenes/. Needs Node on PATH. */
async function setUp(home:string):Promise<string> {
  await mkdir(home,{recursive:true});
  const want=await readFile(join(SANDBOX,'package.json'),'utf8');
  const have=await readFile(join(home,'package.json'),'utf8').catch(()=>'');
  for(const f of ['entry.jsx','render.mjs'])await cp(join(SANDBOX,f),join(home,f));
  await rm(join(home,'scenes'),{recursive:true,force:true});
  await cp(join(SANDBOX,'scenes'),join(home,'scenes'),{recursive:true});
  if(have!==want||!await readFile(join(home,'node_modules/@remotion/renderer/package.json'),'utf8').then(()=>true,()=>false)) {
    await writeFile(join(home,'package.json'),want);
    const r=await run([process.execPath,'install','--no-save'],{cwd:home});
    if(r.code)throw new Error(`could not install Remotion: ${tail(r.out,600)}`);
  }
  if(!await run(['node','--version'],{timeoutMs:10_000}).then(r=>r.code===0,()=>false))throw new Error('Remotion needs Node.js on PATH');
  return home;
}

/**
 * Remotion on this machine, for the local editor: the sandbox steps without the
 * container. The first render installs Remotion (and its headless Chrome) into `home`.
 */
export function localRemotionRenderer(o:{home:string;fontsDir?:string;browser?:string}):HtmlRenderer {
  let kit:Promise<string>|undefined;
  return async({dir,width,height,seconds})=>{
    let home:string;
    try {home=await (kit??=setUp(o.home));}
    catch(e) {kit=undefined;return {ok:false,report:`render failed: ${e instanceof Error?e.message:String(e)}`};}
    const work=join(dirname(dir),'rm'),webm=join(dirname(dir),'rm-out','graphic.webm');
    await mkdir(dirname(webm),{recursive:true});
    const job={in:dir,work,out:webm,width:Math.round(width),height:Math.round(height),seconds,
      gsap:join(home,'node_modules/gsap/dist/gsap.min.js'),...(o.fontsDir?{fonts:o.fontsDir}:{}),...(o.browser?{browser:o.browser}:{})};
    const r=await run(['node',join(home,'render.mjs'),JSON.stringify(job)],{cwd:home,timeoutMs:5*60_000});
    return report(webm,r.out,await readdir(join(work,'public','fonts')).catch(()=>[] as string[]),r.code);
  };
}

/** The sandboxed (Docker) renderer for the picked engine. */
export function dockerGraphicsRenderer(engine=graphicsEngine()):HtmlRenderer {
  return engine==='hyperframes'?dockerHtmlRenderer(HF_IMAGE):dockerRemotionRenderer();
}

/** The picked engine's Docker image is present. */
export function graphicsReady(engine=graphicsEngine()):Promise<boolean> {
  return engine==='hyperframes'?hyperframesReady():remotionReady();
}

/** The on-this-machine renderer for the picked engine; `home` is the parent folder both install under. */
export function localGraphicsRenderer(o:{home:string;fontsDir?:string},engine=graphicsEngine()):HtmlRenderer {
  const fonts=o.fontsDir?{fontsDir:o.fontsDir}:{};
  return engine==='hyperframes'?localHtmlRenderer({home:join(o.home,'hyperframes'),...fonts}):localRemotionRenderer({home:join(o.home,'remotion'),...fonts});
}
