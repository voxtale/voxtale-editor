import {ffmpegPath} from '../../ffmpeg-path';
// Cheap perception on demand (video-use's timeline_view): ffmpeg only, no model.
import {spawnText} from '../../../spawn';

export async function ff(args:string[]):Promise<void> {
  // JPEG out needs full-range YUV: ffmpeg 6 (the desktop's) refuses anything else.
  const out=args.at(-1)??'';
  if(/\.jpe?g$/i.test(out)&&!args.includes('-pix_fmt'))args=[...args.slice(0,-1),'-pix_fmt','yuvj420p',out];
  const r=await spawnText(ffmpegPath(),['-hide_banner','-nostdin','-loglevel','error','-y',...args],{timeoutMs:120_000});
  if(r.code!==0)throw new Error(`ffmpeg: ${r.stderr.slice(-600)}`);
}

/** One source frame (the speaker), used as the backdrop when checking a graphic. */
export async function frameAt(src:string,t:number,out:string,width:number):Promise<void> {
  await ff(['-ss',String(t),'-i',src,'-frames:v','1','-vf',`scale=${width}:-2`,out]);
}
