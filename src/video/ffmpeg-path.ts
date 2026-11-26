// Finds ffmpeg/ffprobe. Env var wins (VOXTALE_EDITOR_FFMPEG / VOXTALE_EDITOR_FFPROBE;
// the old SUPERTALE_FFMPEG / SUPERTALE_FFPROBE still work).
// On macOS, Homebrew's plain `ffmpeg` lacks libass (captions fail: "No such
// filter: 'ass'"), so prefer keg-only ffmpeg-full when installed. Else PATH.
// ffprobe comes from the same folder as the chosen ffmpeg.
import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';

export const FFMPEG_FULL_DIRS=['/opt/homebrew/opt/ffmpeg-full/bin','/usr/local/opt/ffmpeg-full/bin'];

export type FfmpegEnv={env?:Record<string,string|undefined>;platform?:string;exists?:(p:string)=>boolean};
export type FfmpegPaths={ffmpeg:string;ffprobe:string};

export function resolveFfmpegPaths(o:FfmpegEnv={}):FfmpegPaths{
  const env=o.env??process.env,platform=o.platform??process.platform,exists=o.exists??existsSync;
  let ffmpeg=env.VOXTALE_EDITOR_FFMPEG||env.SUPERTALE_FFMPEG||undefined,ffprobe=env.VOXTALE_EDITOR_FFPROBE||env.SUPERTALE_FFPROBE||undefined;
  if(!ffmpeg&&platform==='darwin'){
    const dir=FFMPEG_FULL_DIRS.find(d=>exists(join(d,'ffmpeg')));
    if(dir) ffmpeg=join(dir,'ffmpeg');
  }
  ffmpeg??='ffmpeg';
  if(!ffprobe){
    if(ffmpeg.includes('/')||ffmpeg.includes('\\')){
      const dir=dirname(ffmpeg),name=/\.exe$/i.test(ffmpeg)?'ffprobe.exe':'ffprobe',p=join(dir,name);
      ffprobe=exists(p)?p:'ffprobe';
    }else ffprobe='ffprobe';
  }
  return {ffmpeg,ffprobe};
}

let cached:FfmpegPaths|undefined;
let cachedKey='';
function paths():FfmpegPaths{
  const e=process.env,key=[e.VOXTALE_EDITOR_FFMPEG,e.SUPERTALE_FFMPEG,e.VOXTALE_EDITOR_FFPROBE,e.SUPERTALE_FFPROBE].map(v=>v??'').join('\0');
  if(!cached||key!==cachedKey){cached=resolveFfmpegPaths();cachedKey=key;}
  return cached;
}
export const ffmpegPath=():string=>paths().ffmpeg;
export const ffprobePath=():string=>paths().ffprobe;
