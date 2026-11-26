import {ffmpegPath} from './ffmpeg-path';
// Gemini-video provider for clip moments: the model watches short chunks of
// the clip itself and sets the times. Chunks stay short because Gemini's times
// drift on long video (bd memory gemini-index-design-2026-09). Needs the file
// on this machine; scored against `dense` by tools/moments-eval.ts.
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ffmpeg,type Ff} from '@voxtale/frames';
import {promptStamp,promptText} from '../services/prompts';
import {askVideo} from './openrouter';
import {clipMomentsSchema,type ClipMoments,type MomentWord} from './moments';
import {MOMENTS_VIDEO_PROMPT_ID} from './prompts';

export type VideoModel=(system:string,text:string,mp4:Uint8Array)=>Promise<{json:unknown;model:string;costUsd?:number}>;
export interface GeminiVideoInput {hash:string;duration:number;words:MomentWord[];file:string}

const CHUNK=120;
const str=(x:unknown,max:number)=>typeof x==='string'?x.trim().slice(0,max):'';
const strs=(x:unknown,n:number,max:number)=>Array.isArray(x)?x.filter((v):v is string=>typeof v==='string'&&v.trim()!=='').slice(0,n).map(v=>v.trim().slice(0,max)):[];
const num=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)?x:Number.NaN;

export async function geminiVideoMoments(input:GeminiVideoInput,o:{model?:VideoModel;ff?:Ff;chunk?:number;concurrency?:number;progress?:(m:string)=>void}={}):Promise<ClipMoments> {
  const t0=Date.now(),ff=o.ff??ffmpeg(ffmpegPath(),300_000),model=o.model??askVideo,size=o.chunk??CHUNK;
  const dir=await mkdtemp(join(tmpdir(),'moments-video-'));
  const system=promptText(MOMENTS_VIDEO_PROMPT_ID);
  const starts=Array.from({length:Math.ceil(input.duration/size)},(_,k)=>k*size);
  const found:{start:number;end:number;raw:any}[]=[];
  let cost=0,used='',next=0;
  try {
    await Promise.all(Array.from({length:Math.min(o.concurrency??3,starts.length)},async()=>{
      while(next<starts.length) {
        const s=starts[next++]!,len=Math.min(size,input.duration-s),mp4=join(dir,`${s}.mp4`);
        // Small enough to send inline: 768 px, 2 fps, no sound (the words go as text).
        await ff(['-ss',String(s),'-t',String(len),'-i',input.file,'-an','-vf','fps=2,scale=768:-2','-c:v','libx264','-preset','veryfast','-crf','30','-movflags','+faststart',mp4]);
        const said=input.words.filter(w=>w.start>=s&&w.start<s+len).map(w=>`${(w.start-s).toFixed(1)} ${w.text}`).join('\n').slice(0,12000);
        try {
          const r=await model(system,`Chunk ${s.toFixed(0)}s-${(s+len).toFixed(0)}s of the clip, ${len.toFixed(0)}s long.\nWords (seconds from chunk start):\n${said||'(none)'}`,new Uint8Array(await readFile(mp4)));
          cost+=r.costUsd??0;used=r.model;
          const ms=(r.json as any)?.moments;
          for(const m of Array.isArray(ms)?ms:[]) {
            const a=num(m?.start),b=num(m?.end);
            if(!(a>=0&&b>a&&a<len+1))continue;
            found.push({start:s+a,end:s+Math.min(b,len),raw:m});
          }
        } catch(e) {o.progress?.(`Video chunk ${s}s failed: ${e instanceof Error?e.message:e}`);}
        o.progress?.(`Watched ${Math.min(input.duration,s+len).toFixed(0)}s of ${input.duration.toFixed(0)}s`);
      }
    }));
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
  if(!found.length)throw new Error('The video model described no moments');
  found.sort((a,b)=>a.start-b.start);
  const moments=found.map((m,k)=>({id:`M${String(k+1).padStart(3,'0')}`,start:+m.start.toFixed(2),end:+Math.max(m.start+0.1,m.end).toFixed(2),
    frame:+((m.start+m.end)/2).toFixed(2),description:str(m.raw?.description,1000),changed:str(m.raw?.changed,300),
    onScreenText:strs(m.raw?.onScreenText,8,200),subjects:strs(m.raw?.subjects,12,120)}));
  const p=promptStamp()[MOMENTS_VIDEO_PROMPT_ID];
  return clipMomentsSchema.parse({clipHash:input.hash,provider:'gemini-video',model:used,
    promptVersion:p?`${MOMENTS_VIDEO_PROMPT_ID}@${p.version}:${p.hash.slice(0,8)}`:MOMENTS_VIDEO_PROMPT_ID,every:1,moments,costUsd:Math.round(cost*1e6)/1e6,ms:Date.now()-t0});
}
