import {join,resolve} from 'node:path';
import {mkdir,stat,readdir} from 'node:fs/promises';
import {digest,fileHash,locked,maybeJson,writeJson} from './artifacts';
import type {Edit} from './model';
import {transcribe} from './transcript';
import {stage,stageDoc} from './stages';

export async function produce(edit:Edit,out:string,options:{model?:string;progress?:(message:string)=>void}={}) {
  out=resolve(out);
  return locked(`${out}.lock`,async()=>{
    // Fail before incurring transcription costs if a later stage has no key.
    if(!process.env.ASSEMBLYAI_API_KEY||!process.env.OPENROUTER_API_KEY)throw new Error('produce requires ASSEMBLYAI_API_KEY and OPENROUTER_API_KEY');
    const inputHash=digest({edit,sourceHash:await fileHash(edit.source),model:options.model??process.env.VIDEO_EDIT_MODEL??'anthropic/claude-sonnet-4.6'});
    const old=await maybeJson(join(out,'production.json'));
    if(old&&old.inputHash!==inputHash)throw new Error('Production inputs changed: choose a new --out directory');
    await mkdir(out,{recursive:true});
    if(!old&&(await readdir(out)).length)throw new Error('Production folder contains other files: choose a new --out directory');
    await writeJson(join(out,'production.json'),{version:1,inputHash});
    await writeJson(join(out,'input.json'),edit);
    const transcript=join(out,'transcript.json');
    await transcribe(edit,transcript,{progress:options.progress});
    const takes=await stage('takes',edit,transcript,join(out,'takes'),options);
    const final=await stage('graphics',takes,transcript,join(out,'graphics'),{...options,inputDoc:await stageDoc(join(out,'takes'))});
    // Retry rendering in a fresh directory; preserve any failed or prior outputs.
    let revision=1;
    for(;;revision++) {
      const folder=join(out,`preview-${revision}`),report=await maybeJson(join(folder,'report.json'));
      if(report?.status==='complete'&&report.editHash===digest(final)) {return join(folder,'video.mp4');}
      if(await stat(folder).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))continue;
      const {render}=await import('./render');await render(final,folder,true,options.progress);return join(folder,'video.mp4');
    }
  });
}
