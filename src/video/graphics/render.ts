// Graphic render boundary. Generated code only ever runs inside the locked
// sandbox container (plan §5): no network, read-only root, capped memory,
// CPUs and processes, all capabilities dropped, non-root, fresh per job.
import {chmod,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnText} from '../../spawn';
import type {GraphicTokens} from './tokens';

export interface RenderInput {
  props?:Record<string,unknown>;
  tokens:GraphicTokens;
  width:number;height:number;fps:number;durationInFrames:number;
  /** Frames to render as checkerboard JPEG stills for the defect check. */
  stills?:number[];
  stillsOnly?:boolean;
  /** Also render ProRes 4444 `.mov` (Resolve hand-off). */
  prores?:boolean;
}
export interface RenderOutput {
  ok:boolean;
  stage:string;
  error?:string;
  /** Props after the graphic's own schema parsed them. */
  props?:Record<string,unknown>|null;
  defaultProps?:Record<string,unknown>|null;
  jsonSchema?:unknown;
  stills:Map<number,Uint8Array>;
  webm?:Uint8Array;
  mov?:Uint8Array;
  seconds?:number;
}
export type GraphicRenderer=(source:string,input:RenderInput)=>Promise<RenderOutput>;

/** Container flags from spike 3; the render box baseline. */
export function sandboxArgs(image:string,jobDir:string):string[] {
  return ['run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,size=1g','--tmpfs','/home/render:rw,size=64m',
    '--memory','2g','--cpus','2','--pids-limit','512','--cap-drop','ALL','--security-opt','no-new-privileges',
    '-v',`${jobDir}:/job`,image];
}

export const SANDBOX_IMAGE=process.env.VOXTALE_GRAPHICS_IMAGE??'voxtale-graphics-sandbox:1';

/** Docker is running and has the sandbox image: graphics can render on this machine. */
export async function sandboxReady(image=SANDBOX_IMAGE):Promise<boolean> {
  try {return (await spawnText('docker',['image','inspect',image],{timeoutMs:10_000})).code===0;}
  catch {return false;}
}

/** Render in a fresh Docker container; the job dir is removed afterwards. */
export function dockerRenderer(image=SANDBOX_IMAGE,timeoutMs=5*60_000):GraphicRenderer {
  return async (source,input)=>{
    const dir=await mkdtemp(join(tmpdir(),'vt-graphic-'));
    try {
      await mkdir(join(dir,'out'),{recursive:true});
      await writeFile(join(dir,'graphic.tsx'),source);
      await writeFile(join(dir,'input.json'),JSON.stringify(input));
      // The container runs as its own non-root user; on Linux it must be able to read the job and write out/.
      await chmod(dir,0o755);await chmod(join(dir,'out'),0o777);
      const {code,stderr}=await spawnText('docker',sandboxArgs(image,dir),{timeoutMs});
      let report:any;
      try {report=JSON.parse(await readFile(join(dir,'out/report.json'),'utf8'));}
      catch {return {ok:false,stage:'container',error:`sandbox exited ${code}: ${stderr.slice(-1500)}`,stills:new Map()};}
      const stills=new Map<number,Uint8Array>();
      for(const f of input.stills??[]) {
        try {stills.set(f,new Uint8Array(await readFile(join(dir,`out/still-${f}.jpg`))));} catch {}
      }
      const file=async(name:string)=>{try {return new Uint8Array(await readFile(join(dir,'out',name)));} catch {return undefined;}};
      return {ok:!!report.ok,stage:String(report.stage),...(report.error?{error:String(report.error)}:{}),
        props:report.props??null,defaultProps:report.defaultProps??null,jsonSchema:report.jsonSchema??null,
        stills,webm:input.stillsOnly?undefined:await file('graphic.webm'),mov:input.prores?await file('graphic.mov'):undefined,
        seconds:typeof report.totalSeconds==='number'?report.totalSeconds:undefined};
    } finally {
      await rm(dir,{recursive:true,force:true});
    }
  };
}
