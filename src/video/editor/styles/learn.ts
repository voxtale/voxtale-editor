// Learn a style from reference videos, on this machine, without a model:
// voxtale_native/analyse.py measures each one (cuts, zooms, flashes, captions,
// speech, sound, look, contact sheets), TS adds the cuts-on-beat check, and
// the ranges land in the style (style.json measured[usage], rules.md, a
// REPORT.md). yt-dlp fetches a reference only when the creator gives a URL.
import {existsSync} from 'node:fs';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {basename,extname,join,resolve} from 'node:path';
import {spawnText} from '../../../spawn';
import {beatsOfFile} from '../../beats';
import {ff} from '../agent/look';
import {mustStyle,saveInfo,saveRules,slugOf,withMeasuredSection,type Style} from './folder';
import {cutsOnBeat,measuredLines,reportMarkdown,summaryOf,targetsOf,type Report,type Targets} from './targets';

const ROOT=join(import.meta.dir,'../../../..');
export const ANALYSE_SCRIPT=join(ROOT,'voxtale_native/analyse.py');
const VIDEO_EXT=['.mp4','.mov','.m4v','.mkv','.webm','.avi'];

export interface Word {text:string;start:number;end:number}
export interface AnalyseRequest {video:string;out:string;words?:Word[];only?:string;exclude?:string}
export interface AnalyseResult {report:Report;cut_times:number[]}
export type Analyser=(r:AnalyseRequest)=>Promise<AnalyseResult>;

/** The analyser through uv (fetches numpy and scipy once), else the project's Python. */
export function localAnalyser(uv=process.env.VOXTALE_EDITOR_UV??process.env.SUPERTALE_UV??'uv'):Analyser {
  return async req=>{
    const venv=resolve(ROOT,process.env.VOXTALE_EDITOR_PYTHON??process.env.SUPERTALE_PYTHON??'.venv/bin/python');
    const useUv=await spawnText(uv,['--version'],{timeoutMs:10_000}).then(r=>!r.code,()=>false);
    if(!useUv&&!existsSync(venv))throw new Error('learn_style needs uv (https://docs.astral.sh/uv/) or a .venv with numpy and scipy');
    const [cmd,args]=useUv?[uv,['run','--quiet','--script',ANALYSE_SCRIPT]]:[venv,[ANALYSE_SCRIPT]];
    // A long video takes minutes: it reads every frame twice.
    const r=await spawnText(cmd,args,{stdin:JSON.stringify(req),timeoutMs:60*60_000});
    const out=JSON.parse(r.stdout||'{}') as AnalyseResult&{error?:string};
    if(out.error||!out.report)throw new Error(`analyse ${basename(req.video)}: ${out.error??r.stderr.trim().slice(-300)}`);
    return out;
  };
}

/** Word times beside a video: <name>.words.json, an array of {text,start,end} in seconds (or {words:[...]}). */
export async function sidecarWords(video:string):Promise<Word[]|undefined> {
  const base=video.slice(0,video.length-extname(video).length);
  for(const f of [`${base}.words.json`,`${video}.words.json`]) {
    if(!existsSync(f))continue;
    const raw=JSON.parse(await readFile(f,'utf8'));
    const ws=(Array.isArray(raw)?raw:raw?.words) as unknown[];
    if(!Array.isArray(ws))continue;
    return ws.filter((w):w is Word=>!!w&&typeof (w as Word).text==='string'&&typeof (w as Word).start==='number'&&typeof (w as Word).end==='number');
  }
  return undefined;
}

/** Reference videos: files, and the videos inside folders. */
export async function videosIn(paths:string[]):Promise<string[]> {
  const out:string[]=[];
  for(const p of paths.map(x=>resolve(x))) {
    if(!existsSync(p))throw new Error(`no file or folder ${p}`);
    const names=await readdir(p).catch(()=>undefined);
    if(names)out.push(...names.filter(n=>VIDEO_EXT.includes(extname(n).toLowerCase())).sort().map(n=>join(p,n)));
    else out.push(p);
  }
  return [...new Set(out)];
}

/** Download a reference the creator named into the style's references/. yt-dlp must be installed. */
export async function fetchReference(s:Style,url:string,ytdlp=process.env.VOXTALE_YTDLP??'yt-dlp'):Promise<string> {
  if(!/^https?:\/\//.test(url))throw new Error('url: an http(s) link');
  const dir=join(s.dir,'references');
  await mkdir(dir,{recursive:true});
  const r=await spawnText(ytdlp,['--no-playlist','-f','bv*+ba/b','-S','res:1080,vcodec:h264,acodec:aac','--merge-output-format','mp4',
    '-o',join(dir,'%(title).80s [%(id)s].%(ext)s'),'--print','after_move:filepath','--',url],{timeoutMs:30*60_000})
    .catch(e=>{throw new Error(`yt-dlp could not run (${e instanceof Error?e.message:e}); install it or pass the downloaded file`);});
  const file=r.stdout.trim().split('\n').pop()?.trim();
  if(r.code||!file||!existsSync(file))throw new Error(`yt-dlp: ${r.stderr.trim().slice(-300)}`);
  return file;
}

export interface LearnOptions {
  /** Files or folders of reference videos. */
  videos:string[];
  /** What these references are for: "long", "short", "intro"... One style keeps targets per usage. */
  usage?:string;
  only?:string;
  exclude?:string;
  analyse?:Analyser;
  /** Beat finder, for cuts on beat; default ffmpeg on this machine. */
  beats?:typeof beatsOfFile;
  log?:(line:string)=>void;
}
export interface Learned {style:Style;usage:string;targets:Targets;summary:string[];report:string;sheets:string[];skipped:string[]}

export async function learnStyle(root:string,name:string,o:LearnOptions):Promise<Learned> {
  let s=await mustStyle(root,name);
  const usage=(o.usage?.trim()||'default').slice(0,40),log=o.log??(()=>{});
  const analyse=o.analyse??localAnalyser(),beats=o.beats??beatsOfFile;
  const videos=await videosIn(o.videos);
  if(!videos.length)throw new Error('no reference videos found');
  const reports:Report[]=[],sheets:string[]=[],skipped:string[]=[];
  for(const v of videos) {
    const out=join(s.dir,'references','analysis',slugOf(basename(v,extname(v)))||'video');
    const words=await sidecarWords(v);
    await mkdir(out,{recursive:true});
    log(`${basename(v)}: measuring${words?` (${words.length} words from the sidecar)`:' (no .words.json: speech and captions not measured)'}`);
    try {
      const r=await analyse({video:v,out,...(words?{words}:{}),...(o.only?{only:o.only}:{}),...(o.exclude?{exclude:o.exclude}:{})});
      const b=await beats(v,ff).catch(()=>undefined);
      const onBeat=cutsOnBeat(r.cut_times,b);
      r.report.shots={...r.report.shots,cuts_on_beat:onBeat??null,beat_confidence:b?.confidence??null,bpm:b?.bpm??null};
      await writeFile(join(out,'report.json'),JSON.stringify(r.report,null,1));
      reports.push(r.report);
      const listed=await readdir(join(out,'sheets')).catch(()=>[] as string[]);
      sheets.push(...listed.filter(f=>f.endsWith('.jpg')).sort().map(f=>join(out,'sheets',f)));
    } catch(e) {
      skipped.push(`${basename(v)}: ${e instanceof Error?e.message:e}`);
      log(`${basename(v)}: skipped`);
    }
  }
  if(!reports.length)throw new Error(`no reference could be measured:\n${skipped.join('\n')}`);
  const targets=targetsOf(reports),summary=summaryOf(targets,reports.length),names=reports.map(r=>r.video);
  const md=reportMarkdown(usage,reports,targets);
  const report=join(s.dir,'references',`REPORT-${slugOf(usage)||'default'}.md`);
  await writeFile(report,md);
  s=await saveInfo(s,{...s.info,references:[...new Set([...(s.info.references??[]),...names])],
    measured:{...s.info.measured,[usage]:{summary,targets,videos:names,at:new Date().toISOString()}}});
  s=await saveRules(s,withMeasuredSection(s.rules,usage,measuredLines(targets,names)));
  return {style:s,usage,targets,summary,report,sheets,skipped};
}
