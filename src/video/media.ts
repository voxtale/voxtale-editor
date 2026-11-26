import {ffmpegPath,ffprobePath} from './ffmpeg-path';
import {readFile, stat} from 'node:fs/promises';
import {dirname, isAbsolute, resolve} from 'node:path';
import {editSchema, timeline, type Edit} from './model';
import {spawnText} from '../spawn';

export async function run(command:string, args:string[], signal?:AbortSignal):Promise<string> {
  if(signal?.aborted) throw new Error('Cancelled');
  const {stdout,stderr,code}=await spawnText(command,args,signal?{signal}:{});
  if(signal?.aborted) throw new Error('Cancelled');
  if(code!==0) throw new Error(`${command} exited ${code}: ${stderr.slice(-3000)}`);
  return stdout || stderr;
}
export async function probe(path:string) {
  const info=JSON.parse(await run(ffprobePath(),['-v','error','-show_format','-show_streams','-of','json',path]));
  return {duration:Number(info.format.duration), video:info.streams.some((s:any)=>s.codec_type==='video'),
    audio:info.streams.some((s:any)=>s.codec_type==='audio')};
}
export function localPath(base:string, path:string) {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) throw new Error('Only local media files are supported');
  return isAbsolute(path)?path:resolve(base,path);
}
export async function loadEdit(path:string):Promise<Edit> {
  const edit=editSchema.parse(JSON.parse(await readFile(path,'utf8')));
  const base=dirname(resolve(path));
  edit.source=localPath(base,edit.source);
  for (const scene of edit.scenes) if(scene.broll) scene.broll.path=localPath(base,scene.broll.path);
  if(edit.music) edit.music.path=localPath(base,edit.music.path);
  return edit;
}
export async function validateMedia(edit:Edit) {
  const source=await probe(edit.source);
  if(!source.video || !Number.isFinite(source.duration) || source.duration<=0) throw new Error('Source must be a video with a known duration');
  const frames=Math.floor(source.duration*edit.fps + 0.001);
  for(const scene of timeline(edit)) {
    if(scene.sourceStart+scene.duration>frames) throw new Error(`${scene.id}: source range exceeds footage (${source.duration}s)`);
    if(scene.broll) {
      if(!(await stat(scene.broll.path)).isFile()) throw new Error(`${scene.id}: B-roll is not a file`);
      const media=await probe(scene.broll.path);
      if(!media.video) throw new Error(`${scene.id}: B-roll must contain an image or video`);
      if(scene.broll.kind==='video' && (!Number.isFinite(media.duration) || scene.broll.in+scene.duration/edit.fps>media.duration+0.001))
        throw new Error(`${scene.id}: B-roll is shorter than the scene`);
    }
  }
  if(edit.music && !(await probe(edit.music.path)).audio) throw new Error('Music file has no audio');
  return source;
}
export function silenceRanges(log:string, duration:number) {
  const ranges:Array<{start:number;end:number}>=[];
  let start:number|undefined;
  for(const m of log.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    if(m[1]==='start') start=Number(m[2]);
    else {ranges.push({start:start??0,end:Number(m[2])});start=undefined;}
  }
  if(start!==undefined) ranges.push({start,end:duration});
  return ranges;
}
