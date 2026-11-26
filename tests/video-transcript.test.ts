import {expect,test} from 'bun:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {editSchema} from '../src/video/model';
import {run} from '../src/video/media';
import {transcribe} from '../src/video/transcript';
test('AssemblyAI jobs resume after polling failure without uploading or billing twice',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'video-transcript-test-'));
 const saved=process.env.ASSEMBLYAI_API_KEY;process.env.ASSEMBLYAI_API_KEY='test';
 try {
  const source=join(dir,'source.mp4');
  await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=s=320x240:d=2','-f','lavfi','-i','sine=duration=2','-c:v','libx264','-c:a','aac','-shortest',source]);
  const edit=editSchema.parse({version:1,name:'Test',source,scenes:[{id:'a',in:0,out:2}]});
  const output=join(dir,'transcript.json');let uploads=0,submits=0,polls=0;
  const request=async(url:string,init?:RequestInit)=>{
   if(url.endsWith('/upload')){uploads++;return Response.json({upload_url:'https://example.com/audio'});}
   if(init?.method==='POST'){
    submits++;const body=JSON.parse(String(init.body));expect(body.disfluencies).toBe(true);
    expect(body.speech_models).toContain('universal-3-5-pro');return Response.json({id:'job-123'});
   }
   polls++;if(polls===1)throw new Error('Temporary connection loss');
   return Response.json({id:'job-123',status:'completed',speech_model_used:'universal-3-5-pro',words:[{text:'Hello.',start:100,end:700,confidence:0.99}]});
  };
  await expect(transcribe(edit,output,{fetch:request,pollMs:0})).rejects.toThrow('Temporary');
  expect(JSON.parse(await readFile(`${output}.state.json`,'utf8')).id).toBe('job-123');
  const transcript=await transcribe(edit,output,{fetch:request,pollMs:0});
  expect(transcript.words[0]!.start).toBe(0.1);expect(uploads).toBe(1);expect(submits).toBe(1);
  delete process.env.ASSEMBLYAI_API_KEY;
  await transcribe(edit,output,{fetch:async()=>{throw new Error('Cache should not call provider');}});
  expect(polls).toBe(2);
 }finally {if(saved)process.env.ASSEMBLYAI_API_KEY=saved;else delete process.env.ASSEMBLYAI_API_KEY;await rm(dir,{recursive:true,force:true});}
},15000);
