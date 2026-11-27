import {ffmpegPath} from './ffmpeg-path';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileHash,locked,maybeJson,readJson,writeJson} from './artifacts';
import {probe,run} from './media';
import type {Edit} from './model';
import {transcriptSchema,normalizeTranscript,normalizeLocalTranscript,type Transcript} from './transcript-model';
import {chooseEngine,transcribeLocal,type EngineChoice,type LocalModel,type LocalOptions} from './local-transcribe';
export {chooseEngine,ENGINE_LABEL,MissingModelError,missingModelMessage,localModel,FETCH_SCRIPT} from './local-transcribe';
export * from './transcript-model';
export async function loadTranscript(path:string,edit:Edit) {
  const t=transcriptSchema.parse(await readJson(path));
  if(t.sourceHash!==await fileHash(edit.source))throw new Error('Transcript belongs to different source footage');
  return t;
}
type Fetch=(url:string,init?:RequestInit)=>Promise<Response>;
export type TranscribeOptions={progress?:(message:string)=>void;fetch?:Fetch;pollMs?:number;timeoutMs?:number;transcriptId?:string;
  /** local | assemblyai | auto; default VOXTALE_EDITOR_TRANSCRIBE, else auto (AssemblyAI when ASSEMBLYAI_API_KEY is set, else local). */
  engine?:string;
  /** Local engine pieces and the engine itself (tests inject a stub). */
  local?:Omit<LocalOptions,'progress'>;
  /** The local model state (tests inject one); default models/parakeet/ in the repo. */
  model?:LocalModel};
/** The engine a transcribe call with these options would use (throws MissingModelError like it). For tool output before a long run. */
export const transcribeEngine=(options:TranscribeOptions={}):EngineChoice=>chooseEngine({...(options.engine?{requested:options.engine}:{}),...(options.model?{model:options.model}:{}),injectedFetch:!!options.fetch||!!options.transcriptId});
export async function transcribe(edit:Edit,output:string,options:TranscribeOptions={}) {
  const sourceHash=await fileHash(edit.source);
  return transcribeWith(resolve(output),edit.source,sourceHash,async()=>{
    const info=await probe(edit.source);
    if(!info.video||!info.audio)throw new Error('Transcription requires video footage with an audio track');
    return {duration:info.duration,input:edit.source,audio:async(scratch:string)=>{
      const audio=join(scratch,'audio.flac');
      options.progress?.('Extracting audio');
      await run(ffmpegPath(),['-v','error','-nostdin','-y','-i',edit.source,'-vn','-ac','1','-ar','16000','-c:a','flac',audio]);
      return audio;
    }};
  },options);
}
/**
 * Transcribe audio already extracted elsewhere (desktop ingest, a sequence's
 * joined passages, a live piece): any file ffmpeg reads. The one call for
 * every caller; the engine follows transcribeEngine(options).
 */
export async function transcribeAudio(audio:string,output:string,source:{name:string;hash:string;duration:number},options:TranscribeOptions={}) {
  return transcribeWith(resolve(output),source.name,source.hash,async()=>({duration:source.duration,input:audio,audio:async()=>audio}),options);
}
type Prepared={duration:number;input:string;audio:(scratch:string)=>Promise<string>};
async function transcribeWith(output:string,source:string,sourceHash:string,prepare:()=>Promise<Prepared>,options:TranscribeOptions) {
  return locked(`${output}.lock`,async()=>{
    const cached=await maybeJson(output);
    if(cached) {const t=transcriptSchema.parse(cached);if(t.sourceHash!==sourceHash)throw new Error('Existing transcript is for different footage');options.progress?.(`Using saved transcript (${t.provider})`);return t;}
    // A half-done AssemblyAI job resumes on AssemblyAI, whatever the default: it is paid for already.
    const pending=await maybeJson(`${output}.state.json`);
    const choice=pending?.id?chooseEngine({requested:'assemblyai'}):transcribeEngine(options);
    const info=await prepare();
    options.progress?.(`Engine: ${choice.label} (${choice.why})`);
    if(choice.engine==='local') {
      const raw=await transcribeLocal(info.input,info.duration,{...options.local,...(options.progress?{progress:options.progress}:{})});
      const t=normalizeLocalTranscript(raw,source,sourceHash,info.duration);
      await writeJson(output,t);return t;
    }
    return assembly(output,source,sourceHash,info,options);
  });
}
async function assembly(output:string,source:string,sourceHash:string,info:Prepared,options:TranscribeOptions) {
  {
    const key=process.env.ASSEMBLYAI_API_KEY;if(!key)throw new Error('Set ASSEMBLYAI_API_KEY for transcription');
    const base=process.env.ASSEMBLYAI_REGION==='eu'?'https://api.eu.assemblyai.com/v2':'https://api.assemblyai.com/v2';
    const request=options.fetch??fetch;
    async function api(path:string,init:RequestInit={}) {
      const res=await request(`${base}${path}`,{...init,headers:{authorization:key!,...init.headers},signal:AbortSignal.timeout(120000)});
      if(!res.ok)throw new Error(`AssemblyAI ${res.status}: ${(await res.text()).slice(0,600)}`);
      return await res.json() as any;
    }
    const statePath=`${output}.state.json`;
    let state=await maybeJson(statePath);
    if(state && (state.sourceHash!==sourceHash||state.base!==base))throw new Error('Saved transcription job has a different source or region');
    if(options.transcriptId){state={sourceHash,base,id:options.transcriptId,status:'submitted'};await writeJson(statePath,state);}
    if(state?.status==='submitting'&&!state.id)throw new Error('Submission outcome is unknown. Find the job in AssemblyAI and resume with --transcript-id ID; do not submit it twice.');
    if(!state?.id) {
      const scratch=await mkdtemp(join(tmpdir(),'voxtale-transcribe-'));
      try {
        const audio=await info.audio(scratch);
        options.progress?.('Uploading audio to AssemblyAI');
        const uploaded=await api('/upload',{method:'POST',headers:{'content-type':'application/octet-stream'},body:await readFile(audio)});
        if(typeof uploaded.upload_url!=='string')throw new Error('AssemblyAI returned no upload URL');
        state={sourceHash,base,status:'submitting'};await writeJson(statePath,state);
        const result=await api('/transcript',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({audio_url:uploaded.upload_url,speech_models:['universal-3-5-pro','universal-2'],disfluencies:true,punctuate:true,format_text:false})});
        if(typeof result.id!=='string')throw new Error('AssemblyAI returned no transcript ID; inspect your provider dashboard');
        state={...state,status:'submitted',id:result.id};await writeJson(statePath,state);
      }finally {await rm(scratch,{recursive:true,force:true});}
    }
    const deadline=Date.now()+(options.timeoutMs??1800000);let last='';
    while(Date.now()<deadline) {
      const raw=await api(`/transcript/${encodeURIComponent(state.id)}`);
      if(raw.status!==last){last=raw.status;options.progress?.(`AssemblyAI: ${last}`);}
      if(raw.status==='error')throw new Error(`AssemblyAI transcription failed: ${raw.error}`);
      if(raw.status==='completed') {
        await writeJson(`${output}.assemblyai.json`,raw);
        const normalized=normalizeTranscript(raw,source,sourceHash,info.duration);
        await writeJson(output,normalized);return normalized;
      }
      if(!['queued','processing'].includes(raw.status))throw new Error(`Unknown AssemblyAI state: ${raw.status}`);
      await sleep(options.pollMs??3000);
    }
    throw new Error('Transcription still running. Repeat the command to resume the saved job.');
  }
}
