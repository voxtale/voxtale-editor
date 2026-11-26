// The Docker HtmlRenderer (./frames): HyperFrames HTML → transparent WebM in a
// fresh container with no network (HyperFrames is Apache-2.0). The desktop app
// renders in its own Chromium instead; the local editor MCP uses
// localHtmlRenderer (below), no container.
// Image: docker build -t voxtale-hyperframes-sandbox:1 src/video/editor/agent/sandbox
import {chmod,cp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {spawnText} from '../../../spawn';
import type {HtmlRenderer} from './frames';

export const HF_IMAGE=process.env.VOXTALE_HF_IMAGE??'voxtale-hyperframes-sandbox:1';

const DOCKER_FLAGS=['--network','none','--read-only','--tmpfs','/tmp:rw,size=2g,exec','--tmpfs','/home/render:rw,size=256m,exec,uid=10001,gid=10001',
  '-e','HYPERFRAMES_NO_TELEMETRY=1','-e','DO_NOT_TRACK=1',
  '--memory','3g','--cpus','2','--pids-limit','1024','--cap-drop','ALL','--security-opt','no-new-privileges','--shm-size','512m'];

/** Docker is running and has the HyperFrames image. */
export async function hyperframesReady(image=HF_IMAGE):Promise<boolean> {
  try {return (await spawnText('docker',['image','inspect',image],{timeoutMs:10_000})).code===0;}
  catch {return false;}
}

const tail=(s:string,n=1500)=>s.length>n?`…${s.slice(-n)}`:s;

export const dockerHtmlRenderer=(image=HF_IMAGE):HtmlRenderer=>async({dir})=>{
  const outDir=join(dirname(dir),'docker-out');
  await rm(outDir,{recursive:true,force:true});
  await mkdir(outDir,{recursive:true});
  await chmod(dirname(dir),0o755);await chmod(dir,0o755);await chmod(outDir,0o777);
  const {code,stderr}=await spawnText('docker',['run','--rm',...DOCKER_FLAGS,'-v',`${dir}:/job/in:ro`,'-v',`${outDir}:/job/out`,image],{timeoutMs:5*60_000});
  const read=async(f:string)=>{try {return await readFile(join(outDir,f),'utf8');} catch {return '';}};
  const lint=await read('lint.txt'),render=await read('render.txt'),fonts=(await read('fonts.txt')).trim().split('\n').filter(f=>f&&!/Italic/.test(f));
  const webm=join(outDir,'graphic.webm');
  const ok=await readFile(webm).then(b=>b.length>0,()=>false);
  const report=[`lint:\n${tail(lint)}`,`fonts in ./fonts/: ${fonts.join(', ')||'unknown'}`,ok?'render: ok':`render failed (docker exit ${code}):\n${tail(render||stderr)}`].join('\n');
  return ok?{ok,webm,report}:{ok,report};
};

// ---- on this machine, no Docker ----

const HF_VERSION='0.8.139',GSAP_VERSION='3.14.2';

async function run(cmd:string[],o:{cwd?:string;env?:Record<string,string>;timeoutMs?:number}={}):Promise<{code:number;out:string}> {
  const p=Bun.spawn(cmd,{...(o.cwd?{cwd:o.cwd}:{}),env:{...process.env,HYPERFRAMES_NO_TELEMETRY:'1',DO_NOT_TRACK:'1',...o.env},stdout:'pipe',stderr:'pipe',stdin:'ignore'});
  const timer=setTimeout(()=>p.kill(),o.timeoutMs??10*60_000);
  try {
    const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);
    return {code:await p.exited,out:`${out}${err}`};
  } finally {clearTimeout(timer);}
}

interface Kit {cli:string[];gsap:string;browser:string}

/**
 * HyperFrames and GSAP installed once into `home` (bun install), plus the
 * render browser (`hyperframes browser ensure`, ~150 MB). Node runs the CLI
 * when it is on PATH, else bun.
 */
async function setUp(home:string):Promise<Kit> {
  await mkdir(home,{recursive:true});
  const pkg=join(home,'package.json'),want=JSON.stringify({private:true,dependencies:{hyperframes:HF_VERSION,gsap:GSAP_VERSION}},null,1);
  const have=await readFile(pkg,'utf8').catch(()=>'');
  if(have!==want||!await readFile(join(home,'node_modules/hyperframes/package.json'),'utf8').then(()=>true,()=>false)) {
    await writeFile(pkg,want);
    const r=await run([process.execPath,'install','--no-save'],{cwd:home});
    if(r.code)throw new Error(`could not install HyperFrames: ${tail(r.out,600)}`);
  }
  const meta=JSON.parse(await readFile(join(home,'node_modules/hyperframes/package.json'),'utf8')) as {bin?:string|Record<string,string>};
  const bin=typeof meta.bin==='string'?meta.bin:meta.bin?.hyperframes??Object.values(meta.bin??{})[0];
  if(!bin)throw new Error('HyperFrames has no command to run');
  const node=await run(['node','--version'],{timeoutMs:10_000}).then(r=>r.code===0,()=>false);
  const cli=[node?'node':process.execPath,join(home,'node_modules/hyperframes',bin)];
  await run([...cli,'telemetry','disable'],{cwd:home,timeoutMs:30_000}).catch(()=>undefined);
  const saved=join(home,'browser-path');
  let browser=(await readFile(saved,'utf8').catch(()=>'')).trim();
  if(!browser) {
    const e=await run([...cli,'browser','ensure'],{cwd:home});
    if(e.code)throw new Error(`could not fetch the render browser: ${tail(e.out,600)}`);
    const p=await run([...cli,'browser','path'],{cwd:home,timeoutMs:30_000});
    browser=p.out.trim().split(/\r?\n/).pop()??'';
    if(p.code||!browser)throw new Error(`no render browser: ${tail(p.out,600)}`);
    await writeFile(saved,browser);
  }
  return {cli,gsap:join(home,'node_modules/gsap/dist/gsap.min.js'),browser};
}

/**
 * HyperFrames on this machine, for the local editor: the same steps as the
 * Docker sandbox (sandbox/render.sh) without the container. The agent's HTML
 * runs in a local browser with network access, so use it only for the
 * machine owner's own agent. First render installs HyperFrames into `home`.
 */
export function localHtmlRenderer(o:{home:string;fontsDir?:string}):HtmlRenderer {
  let kit:Promise<Kit>|undefined;
  return async({dir})=>{
    let k:Kit;
    try {k=await (kit??=setUp(o.home));}
    catch(e) {kit=undefined;return {ok:false,report:`render failed: ${e instanceof Error?e.message:String(e)}`};}
    const work=join(dirname(dir),'hf'),outDir=join(dirname(dir),'hf-out');
    await rm(work,{recursive:true,force:true});await rm(outDir,{recursive:true,force:true});
    await mkdir(join(work,'fonts'),{recursive:true});await mkdir(outDir,{recursive:true});
    await cp(dir,work,{recursive:true});
    await cp(k.gsap,join(work,'gsap.min.js'));
    if(o.fontsDir)for(const f of await readdir(o.fontsDir).catch(()=>[] as string[]))if(/\.(ttf|otf|woff2?)$/i.test(f))await cp(join(o.fontsDir,f),join(work,'fonts',f));
    const env={HYPERFRAMES_BROWSER_PATH:k.browser};
    const lint=await run([...k.cli,'lint'],{cwd:work,env,timeoutMs:2*60_000});
    const webm=join(outDir,'graphic.webm');
    const render=await run([...k.cli,'render','--workers','2','--format','webm','--output',webm],{cwd:work,env,timeoutMs:5*60_000});
    const fonts=(await readdir(join(work,'fonts')).catch(()=>[] as string[])).filter(f=>!/Italic/.test(f));
    const ok=await readFile(webm).then(b=>b.length>0,()=>false);
    const report=[`lint:\n${tail(lint.out)}\nexit ${lint.code}`,`fonts in ./fonts/: ${fonts.join(', ')||'none'}`,
      ok?'render: ok':`render failed (exit ${render.code}):\n${tail(render.out)}`].join('\n');
    return ok?{ok,webm,report}:{ok,report};
  };
}
