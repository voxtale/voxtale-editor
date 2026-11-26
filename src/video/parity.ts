import {ffmpegPath,ffprobePath} from './ffmpeg-path';
// Parity check between two renders of one EditDoc (desktop export vs cloud
// render): same length, same cuts, same sound. Frame differences at cuts show
// a frame slip; audio cross-correlation shows drift.
import {readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {parseLoudness,shown,type EditDoc,type LoudnessLevel} from '@voxtale/editdoc';
import {run} from './media';

const RATE=8000;

export interface ParityReport {
  frames:[number,number];
  duration:[number,number];
  /** Whole-file audio offset, ms; positive when `b` is late. */
  audioOffsetMs:number;
  loudness:[LoudnessLevel|undefined,LoudnessLevel|undefined];
  ssim:{mean:number;median:number;min:number};
  cuts:{time:number;frame:number;ssim:number;audioOffsetMs:number|null}[];
  problems:string[];
}

async function pcm(ffmpeg:string,file:string,signal?:AbortSignal):Promise<Float32Array> {
  const p=Bun.spawn([ffmpeg,'-hide_banner','-nostdin','-loglevel','error','-i',file,'-map','0:a:0','-ac','1','-ar',String(RATE),'-f','f32le','-'],{stdout:'pipe',stderr:'pipe'});
  const abort=()=>p.kill();
  signal?.addEventListener('abort',abort,{once:true});
  try {
    const buf=await new Response(p.stdout).arrayBuffer();
    if(await p.exited!==0)throw new Error(`ffmpeg could not read audio from ${file}`);
    return new Float32Array(buf);
  } finally {signal?.removeEventListener('abort',abort);}
}

/** Lag (samples) of `b` against `a` that best lines them up, within ±maxLag, over [from, to). */
export function bestLag(a:Float32Array,b:Float32Array,from:number,to:number,maxLag:number):{lag:number;score:number} {
  let best={lag:0,score:-Infinity};
  for(let lag=-maxLag;lag<=maxLag;lag++) {
    let dot=0,na=0,nb=0;
    for(let i=Math.max(from,-lag);i<Math.min(to,a.length,b.length-lag);i++) {
      const x=a[i]!,y=b[i+lag]!;
      dot+=x*y;na+=x*x;nb+=y*y;
    }
    const score=na&&nb?dot/Math.sqrt(na*nb):0;
    if(score>best.score)best={lag,score};
  }
  return best;
}

async function info(ffprobe:string,file:string,signal?:AbortSignal) {
  const j=JSON.parse(await run(ffprobe,['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames:format=duration','-of','json',file],signal));
  return {frames:Number(j.streams?.[0]?.nb_read_frames??0),duration:Number(j.format?.duration??0)};
}

/** Compares two renders of `doc`. Tolerances: one frame of length, 20 ms of audio, SSIM dips at cuts. */
export async function checkParity(o:{doc:EditDoc;a:string;b:string;work:string;ffmpeg?:string;ffprobe?:string;signal?:AbortSignal}):Promise<ParityReport> {
  const ffmpeg=o.ffmpeg??ffmpegPath(),ffprobe=o.ffprobe??ffprobePath();
  const fps=o.doc.fps.num/o.doc.fps.den;
  const [ia,ib]=await Promise.all([info(ffprobe,o.a,o.signal),info(ffprobe,o.b,o.signal)]);
  const stats=join(o.work,`ssim-${Date.now()}.txt`);
  await run(ffmpeg,['-hide_banner','-nostdin','-i',o.a,'-i',o.b,'-lavfi',`[0:v]setpts=PTS-STARTPTS[x];[1:v]setpts=PTS-STARTPTS[y];[x][y]ssim=stats_file='${stats}'`,'-f','null','-'],o.signal);
  const ssim=(await readFile(stats,'utf8')).trim().split('\n').map(l=>Number(/All:([\d.]+)/.exec(l)?.[1]??0));
  await rm(stats,{force:true});
  const sorted=[...ssim].sort((x,y)=>x-y);
  const median=sorted[Math.floor(sorted.length/2)]??0;
  const loud=async(f:string)=>parseLoudness(await run(ffmpeg,['-hide_banner','-nostdin','-i',f,'-map','0:a:0','-af','ebur128=peak=true:framelog=quiet','-f','null','-'],o.signal));
  const [la,lb,pa,pb]=await Promise.all([loud(o.a),loud(o.b),pcm(ffmpeg,o.a,o.signal),pcm(ffmpeg,o.b,o.signal)]);
  const whole=bestLag(pa,pb,0,Math.min(pa.length,pb.length,RATE*60),RATE/5);
  const cutTimes=[...new Set(shown(o.doc.tracks['a-roll']).map(i=>i.start).filter(t=>t>0))].sort((x,y)=>x-y);
  const cuts=cutTimes.map(time=>{
    const frame=Math.ceil(time*fps-1e-6);
    const window=ssim.slice(Math.max(0,frame-2),frame+3);
    const at=Math.round(time*RATE);
    const lag=bestLag(pa,pb,at-RATE/2,at+RATE/2,RATE/20);
    return {time,frame,ssim:window.length?Math.min(...window):0,audioOffsetMs:lag.score>0.5?lag.lag/RATE*1000:null};
  });
  const problems:string[]=[];
  if(Math.abs(ia.frames-ib.frames)>1)problems.push(`Frame counts differ: ${ia.frames} vs ${ib.frames}`);
  if(Math.abs(whole.lag/RATE*1000)>20)problems.push(`Audio offset ${Math.round(whole.lag/RATE*1000)} ms`);
  for(const c of cuts) {
    if(c.ssim<median-0.1)problems.push(`Picture differs at the cut at ${c.time.toFixed(3)}s (SSIM ${c.ssim.toFixed(3)} vs median ${median.toFixed(3)})`);
    if(c.audioOffsetMs!==null&&Math.abs(c.audioOffsetMs)>20)problems.push(`Sound slips ${c.audioOffsetMs.toFixed(1)} ms at the cut at ${c.time.toFixed(3)}s`);
  }
  if(la&&lb&&Math.abs(la.lufs-lb.lufs)>1)problems.push(`Loudness differs: ${la.lufs} vs ${lb.lufs} LUFS`);
  return {
    frames:[ia.frames,ib.frames],duration:[ia.duration,ib.duration],audioOffsetMs:whole.lag/RATE*1000,
    loudness:[la,lb],ssim:{mean:ssim.reduce((s,x)=>s+x,0)/(ssim.length||1),median,min:sorted[0]??0},cuts,problems,
  };
}
