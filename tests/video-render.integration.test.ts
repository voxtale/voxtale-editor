import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run,probe} from '../src/video/media';

// Explicit opt-in: downloads Chrome on first use and renders actual MP4s.
const renderTest=process.env.VIDEO_RENDER_TEST==='1'?test:test.skip;
renderTest('CLI renders cuts, B-roll, music and immutable revisions with synced audio',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'voxtale-render-test-'));
 const cli=join(import.meta.dir,'../src/cli.ts');
 try {
  const source=join(dir,'person footage.mp4');
  // Synthetic AV fixture: first half 440Hz, second half 880Hz, separated by a cut.
  await run('ffmpeg',['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=4',
   '-f','lavfi','-i',"aevalsrc=if(lt(t\\,2)\\,0.2*sin(2*PI*440*t)\\,0.2*sin(2*PI*880*t)):s=48000:d=4",
   '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
  await run('ffmpeg',['-v','error','-nostdin','-y','-f','lavfi','-i','color=c=navy:s=640x360','-frames:v','1',join(dir,'card.png')]);
  await run('ffmpeg',['-v','error','-nostdin','-y','-f','lavfi','-i','sine=frequency=110:duration=1',join(dir,'music.wav')]);
  const edit=join(dir,'edit.json');
  await run('bun',[cli,'video','init','--source',source,'--out',edit]);
  const patch=join(dir,'patch.json');
  await writeFile(patch,JSON.stringify({width:640,height:360,scenes:[
   {id:'first',in:0.5,out:1.5,graphics:[{id:'timed',in:0.6,out:1.4,text:'Keep the best take',style:'chapter'}]},
   {id:'second',in:2.5,out:3.5,title:'A visual with original speech',titleStyle:'card',broll:{path:'card.png',kind:'image'}}],
   captions:[{start:2.6,end:3.4,text:'Caption after the cut'}]}));
  const revised=join(dir,'revised.json');
  await run('bun',[cli,'video','revise',edit,'--patch',patch,'--out',revised]);
  const output=join(dir,'v1');
  await run('bun',[cli,'video','render',revised,'--out',output]);
  const report=JSON.parse(await readFile(join(output,'report.json'),'utf8'));
  expect(report.frames).toBe(60);expect(report.status).toBe('complete');
  expect((await probe(join(output,'video.mp4'))).duration).toBeCloseTo(2,0);
  // Decode samples well inside each retained shot, ensuring the second segment
  // uses source audio from 2.5s rather than continuing from the first cut.
  for(const [at,hz] of [[0.2,440],[1.2,880]]) {
   const pcm=join(dir,`sample-${hz}.raw`);
   await run('ffmpeg',['-v','error','-y','-ss',String(at),'-i',join(output,'video.mp4'),'-t','0.3','-vn','-ac','1','-ar','48000','-f','f32le',pcm]);
   const bytes=await readFile(pcm);const samples=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
   let crosses=0;for(let i=1;i<samples.length;i++)if(samples[i-1]!<=0 && samples[i]!>0)crosses++;
   expect(Math.abs(crosses/(samples.length/48000)-hz!)).toBeLessThan(12);
  }
  await expect(run('bun',[cli,'video','render',revised,'--out',output])).rejects.toThrow();
  expect(JSON.parse(await readFile(join(output,'report.json'),'utf8')).editHash).toBe(report.editHash);
  await writeFile(patch,JSON.stringify({music:{path:'music.wav',volume:0.08},accent:'#00BBAA',scenes:[{id:'clip',in:0,out:1,broll:{path:'person footage.mp4',kind:'video',in:2}}]}));
  const v2=join(dir,'v2.json');await run('bun',[cli,'video','revise',revised,'--patch',patch,'--out',v2]);
  await run('bun',[cli,'video','preview',v2,'--out',join(dir,'v2')]);
  expect(JSON.parse(await readFile(join(dir,'v2','report.json'),'utf8')).status).toBe('complete');
 } finally {await rm(dir,{recursive:true,force:true});}
},120000);
