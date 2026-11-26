import {ffmpegPath} from './ffmpeg-path';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileHash,locked,maybeJson,readJson,writeJson} from './artifacts';
import {probe,run} from './media';
import type {Edit} from './model';
import {transcriptSchema,normalizeTranscript,type Transcript} from './transcript-model';
export * from './transcript-model';
export async function loadTranscript(path:string,edit:Edit) {
  const t=transcriptSchema.parse(await readJson(path));
  if(t.sourceHash!==await fileHash(edit.source))throw new Error('Transcript belongs to different source footage');
  return t;
}
type Fetch=(url:string,init?:RequestInit)=>Promise<Response>;
type TranscribeOptions={progress?:(message:string)=>void;fetch?:Fetch;pollMs?:number;timeoutMs?:number;transcriptId?:string};
export async function transcribe(edit:Edit,output:string,options:TranscribeOptions={}) {
  const sourceHash=await fileHash(edit.source);
  return assembly(resolve(output),edit.source,sourceHash,async()=>{
    const info=await probe(edit.source);
    if(!info.video||!info.audio)throw new Error('Transcription requires video footage with an audio track');
    return {duration:info.duration,audio:async(scratch:string)=>{
      const audio=join(scratch,'audio.flac');
      options.progress?.('Extracting audio for AssemblyAI');
      await run(ffmpegPath(),['-v','error','-nostdin','-y','-i',edit.source,'-vn','-ac','1','-ar','16000','-c:a','flac',audio]);
      return audio;
    }};
  },options);
}
/** Transcribe audio already extracted elsewhere (desktop ingest uploads mono 16 kHz FLAC). */
export async function transcribeAudio(audio:string,output:string,source:{name:string;hash:string;duration:number},options:TranscribeOptions={}) {
  return assembly(resolve(output),source.name,source.hash,async()=>({duration:source.duration,audio:async()=>audio}),options);
}
async function assembly(output:string,source:string,sourceHash:string,prepare:()=>Promise<{duration:number;audio:(scratch:string)=>Promise<string>}>,options:TranscribeOptions) {
  return locked(`${output}.lock`,async()=>{
    const cached=await maybeJson(output);
    if(cached) {const t=transcriptSchema.parse(cached);if(t.sourceHash!==sourceHash)throw new Error('Existing transcript is for different footage');options.progress?.('Using saved transcript');return t;}
    const info=await prepare();
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
  });
}
