// Media the creator links to, saved into the footage folder: a file (voice,
// music, image, a generated video), or a clip of a published video (YouTube,
// X, TikTok, Instagram, Vimeo, a Twitch or Kick replay) from start to end. Only
// an https link, only into <folder>/downloads/, never over a file.
import {createWriteStream,existsSync} from 'node:fs';
import {mkdir,mkdtemp,readdir,rename,rm,unlink} from 'node:fs/promises';
import {basename,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnText} from '../spawn';
import {ffmpegPath,ffprobePath} from './ffmpeg-path';

/** Video pages yt-dlp reads (the page link is not the file). from REDACTED REDACTED/download.py */
export const VIDEO_SITES=['youtube.com','youtu.be','x.com','twitter.com','tiktok.com','instagram.com','vimeo.com','twitch.tv','kick.com'];
/** A whole video with no start or end: 15 min at most (a clip nearly always does). from REDACTED REDACTED/download.py */
export const MAX_WHOLE_S=900;
export const MAX_BYTES=4*2**30;
export const AUDIO=new Set(['.mp3','.wav','.m4a','.aac','.aif','.aiff','.flac','.ogg']);
export const MEDIA=new Set([...AUDIO,'.mp4','.mov','.m4v','.webm','.mkv','.png','.jpg','.jpeg','.webp','.gif']);
const TYPES:Record<string,string>={'audio/mpeg':'.mp3','audio/wav':'.wav','audio/x-wav':'.wav','audio/mp4':'.m4a','audio/aac':'.aac','audio/ogg':'.ogg',
  'audio/flac':'.flac','video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm','image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif'};

/** "83", "1:23" or "1:02:03.5" → seconds. from REDACTED REDACTED/download.py */
export function seconds(s:string|number):number {
  if(typeof s==='number')return s;
  let t=0;
  for(const part of s.trim().split(':')) {
    const n=Number(part);
    if(part===''||!Number.isFinite(n)||n<0)throw new Error(`not a time: ${s}`);
    t=t*60+n;
  }
  return t;
}

export function videoPage(url:string):boolean {
  let host='';
  try {host=new URL(url).hostname.toLowerCase();} catch {return false;}
  return VIDEO_SITES.some(d=>host===d||host.endsWith(`.${d}`));
}

/** A file name stem without odd characters, 80 at most. */
export const safeStem=(s:string,fallback:string)=>s.replace(/[^\w\- ]+/g,'_').slice(0,80).trim()||fallback;

/** `<stem><ext>` in dir, or `<stem>-2<ext>`…: no stem already taken (any extension), so proxies and transcripts named after it never clash. */
export async function uniquePath(dir:string,stem:string,ext:string):Promise<string> {
  const taken=new Set((await readdir(dir).catch(()=>[] as string[])).map(f=>basename(f,extname(f)).toLowerCase()));
  for(let i=1;i<10_000;i++) {
    const s=i===1?stem:`${stem}-${i}`;
    if(!taken.has(s.toLowerCase()))return join(dir,s+ext);
  }
  throw new Error(`no free name for ${stem} in ${dir}`);
}

export interface ClipRange {start?:number;end?:number}

/** yt-dlp args for a clip into `tmp`: 1080p at most, H.264 and AAC first, 8 fragments at a time (a Twitch clip comes in small pieces). from REDACTED REDACTED/download.py */
export function ytdlpArgs(url:string,tmp:string,r:ClipRange&{thumbnail?:boolean}):string[] {
  const section=r.start!==undefined||r.end!==undefined?['--download-sections',`*${r.start??0}-${r.end??'inf'}`,'--force-keyframes-at-cuts']
    :['--match-filter',`duration<=${MAX_WHOLE_S}`];
  return ['--no-warnings','--no-progress','--no-playlist','--concurrent-fragments','8','-f','bv*[height<=1080]+ba/b','-S','res:1080,vcodec:h264,acodec:aac',
    ...section,...(r.thumbnail?['--write-thumbnail','--convert-thumbnails','jpg']:[]),
    '--merge-output-format','mp4','-o',join(tmp,'clip.%(ext)s'),'--print','after_move:title','--no-simulate','--encoding','utf-8','--',url];
}

export interface DownloadOptions {
  url:string;
  /** The footage folder; files go in its downloads/. */
  folder:string;
  name?:string;
  /** Clip of a video page, seconds or "m:ss". */
  start?:string|number;
  end?:string|number;
  thumbnail?:boolean;
  ytdlp?:string;
  fetch?:typeof fetch;
  signal?:AbortSignal;
}
export interface Downloaded {files:string[];kind:'clip'|'file';title?:string}

export async function download(o:DownloadOptions):Promise<Downloaded> {
  let u:URL;
  try {u=new URL(o.url);} catch {throw new Error(`not a link: ${o.url}`);}
  if(u.protocol!=='https:')throw new Error(`only an https link: ${o.url}`);
  const dest=join(o.folder,'downloads');
  await mkdir(dest,{recursive:true});
  const start=o.start!==undefined&&o.start!==''?seconds(o.start):undefined,end=o.end!==undefined&&o.end!==''?seconds(o.end):undefined;
  if(start!==undefined&&end!==undefined&&end<=start)throw new Error('end must come after start');
  if(videoPage(o.url))return clip(o,dest,{...(start!==undefined?{start}:{}),...(end!==undefined?{end}:{})});
  if(start!==undefined||end!==undefined||o.thumbnail)throw new Error(`start, end and thumbnail are for a video page only (${VIDEO_SITES.join(', ')})`);
  return {kind:'file',files:[await fetchFile(o,dest)]};
}

async function clip(o:DownloadOptions,dest:string,r:ClipRange):Promise<Downloaded> {
  const tmp=await mkdtemp(join(tmpdir(),'voxtale-dl-'));
  try {
    const ytdlp=o.ytdlp??process.env.VOXTALE_YTDLP??'yt-dlp';
    const res=await spawnText(ytdlp,ytdlpArgs(o.url,tmp,{...r,...(o.thumbnail?{thumbnail:true}:{})}),{timeoutMs:30*60_000,...(o.signal?{signal:o.signal}:{})})
      .catch(e=>{throw new Error(`yt-dlp could not run (${e instanceof Error?e.message:e}): install it (brew install yt-dlp) or give the file`);});
    const files=(await readdir(tmp)).sort();
    const video=files.find(f=>f.endsWith('.mp4'));
    if(res.code||!video) {
      const why=res.stderr.trim().slice(-300)||(r.start===undefined&&r.end===undefined?`longer than ${MAX_WHOLE_S/60} min: give start and end`:'nothing downloaded');
      throw new Error(`download of ${o.url} failed: ${why}`);
    }
    const title=res.stdout.trim().split('\n').at(-1)?.trim()||'video';
    const out=await uniquePath(dest,safeStem(o.name?basename(o.name,extname(o.name)):title,'video'),'.mp4');
    await rename(await editableAudio(join(tmp,video)),out);
    const files2=[out];
    const thumb=files.find(f=>f.endsWith('.jpg'));
    if(thumb) {
      const t=await uniquePath(dest,`${basename(out,'.mp4')} thumbnail`,'.jpg');
      await rename(join(tmp,thumb),t);
      files2.push(t);
    }
    return {kind:'clip',files:files2,title};
  } finally {
    await rm(tmp,{recursive:true,force:true});
  }
}

/** Opus (YouTube) in an MP4 Premiere will not read: the sound to AAC, the picture kept as is. from REDACTED REDACTED/download.py (premiere_audio) */
async function editableAudio(video:string):Promise<string> {
  const probe=await spawnText(ffprobePath(),['-v','error','-select_streams','a:0','-show_entries','stream=codec_name','-of','csv=p=0',video]).catch(()=>null);
  const codec=probe?.stdout.trim()??'';
  if(!codec||['aac','mp3','alac'].includes(codec)||codec.startsWith('pcm_'))return video;
  const out=video.replace(/\.mp4$/,'-aac.mp4');
  const r=await spawnText(ffmpegPath(),['-v','error','-y','-i',video,'-map','0:v','-map','0:a','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',out]);
  if(r.code)throw new Error(`sound to AAC failed: ${r.stderr.trim().slice(-300)}`);
  return out;
}

/** The extension a downloaded file gets: from the final URL, else its content type; null when not media. */
export function mediaExt(finalUrl:string,contentType:string|null):string|null {
  let ext='';
  try {ext=extname(new URL(finalUrl).pathname).toLowerCase();} catch {}
  if(MEDIA.has(ext))return ext;
  const t=TYPES[(contentType??'').split(';')[0]!.trim().toLowerCase()];
  return t??null;
}

async function fetchFile(o:DownloadOptions,dest:string):Promise<string> {
  const res=await (o.fetch??fetch)(o.url,{headers:{'User-Agent':'voxtale-editor'},redirect:'follow',...(o.signal?{signal:o.signal}:{})});
  if(!res.ok||!res.body)throw new Error(`download of ${o.url} failed: HTTP ${res.status}`);
  if(!res.url.startsWith('https:')&&res.url)throw new Error(`redirected off https: ${res.url}`);
  const ext=mediaExt(res.url||o.url,res.headers.get('content-type'));
  if(!ext)throw new Error(`not a sound, video or image (${res.headers.get('content-type')}): ${o.url}`);
  const size=Number(res.headers.get('content-length'));
  if(size>MAX_BYTES)throw new Error('file over 4 GB');
  let urlStem='';
  try {urlStem=basename(new URL(o.url).pathname,extname(new URL(o.url).pathname));} catch {}
  const out=await uniquePath(dest,safeStem(o.name?basename(o.name,extname(o.name)):urlStem,'download'),ext);
  // A cut-off download never passes for a finished file.
  const part=join(dest,`.${basename(out)}.part`);
  try {
    const w=createWriteStream(part,{flags:'wx'});
    let n=0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      n+=chunk.length;
      if(n>MAX_BYTES){w.destroy();throw new Error('file over 4 GB');}
      if(!w.write(chunk))await new Promise<void>(r=>w.once('drain',()=>r()));
    }
    await new Promise<void>((ok,bad)=>w.end((e?:Error|null)=>e?bad(e):ok()));
    if(existsSync(out))throw new Error(`${out} appeared while downloading`);
    await rename(part,out);
    return out;
  } finally {
    await unlink(part).catch(()=>{});
  }
}
