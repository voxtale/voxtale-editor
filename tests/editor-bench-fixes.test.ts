// Fixes from AgenticVBench tasks we lost (bench2 summary, "Mechanics"):
// timeline_view edges, wordless talk clips, render size/fps/fit, canvas shape.
import {afterAll,beforeAll,describe,expect,it} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localFrames,stripTimes} from '@voxtale/frames';
import {clipRefSchema} from '@voxtale/editdoc';
import {buildCut,canvasClip,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {transcriptSchema} from '../src/video/transcript-model';
import {loadProject,noSpeech,openProject,projectAt} from '../src/video/editor/local-mcp/project';

const hasFfmpeg=Bun.spawnSync(['ffmpeg','-version']).exitCode===0;
let dir='';
beforeAll(async()=>{dir=await mkdtemp(join(tmpdir(),'bench-fixes-'));});
afterAll(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});

const ff=async(args:string[])=>{
  const p=Bun.spawn(['ffmpeg','-hide_banner','-loglevel','error','-y',...args],{stdout:'pipe',stderr:'pipe'});
  const out=new Uint8Array(await new Response(p.stdout).arrayBuffer());
  if(await p.exited!==0)throw new Error(await new Response(p.stderr).text());
  return out;
};

describe('timeline_view edges (asm-6)',()=>{
  it('first cell at start, last at end, the rest evenly between',()=>{
    expect(stripTimes(0,2.1)).toEqual([0,0.3,0.6,0.9,1.2,1.5,1.8,2.1].map(x=>expect.closeTo(x,9)) as number[]);
  });
  it.skipIf(!hasFfmpeg)('shows a moment that lives only in the first and last frame',async()=>{
    // 2 s black clip, white only on frame 0 and on the final frame (59).
    const src=join(dir,'edges.mp4');
    await ff(['-f','lavfi','-i','color=black:s=320x180:r=30:d=2','-vf',"drawbox=c=white:t=fill:enable='eq(n,0)+eq(n,59)'",'-pix_fmt','yuv420p',src]);
    const host=localFrames({sources:{h:src},dir:join(dir,'frames')});
    const png=join(dir,'strip.png');
    await Bun.write(png,await host.filmstrip('h',0,2));
    const gray=await ff(['-i',png,'-vf','scale=800:-2,format=gray','-f','rawvideo','-']);
    const w=800,h=gray.length/w,cell=w/8;
    const mean=(k:number)=>{let s=0,n=0;for(let y=0;y<Math.min(h,40);y++)for(let x=k*cell+10;x<(k+1)*cell-10;x++){s+=gray[y*w+x]!;n++;}return s/n;};
    expect(mean(0)).toBeGreaterThan(200);
    expect(mean(7)).toBeGreaterThan(200);
    for(const k of [1,3,6])expect(mean(k)).toBeLessThan(40);
  },30_000);
});

describe('open: a talk clip with no words (seq-21, seq-25)',()=>{
  it('knows a no-speech failure from any other',()=>{
    const empty=transcriptSchema.safeParse({version:1,provider:'assemblyai',providerId:'t',source:'s',sourceHash:'h',duration:2,model:'u',words:[]});
    expect(empty.success).toBe(false);
    expect(noSpeech(empty.error)).toBe(true);
    expect(noSpeech(new Error('Transcription requires video footage with an audio track'))).toBe(true);
    expect(noSpeech(new Error('AssemblyAI 401: bad key'))).toBe(false);
  });
  it.skipIf(!hasFfmpeg)('opens it as broll with a warning; the rest of the open goes on',async()=>{
    const folder=await mkdtemp(join(dir,'open-'));
    const talk=join(folder,'talk.mp4'),mute=join(folder,'mute.mp4');
    await ff(['-f','lavfi','-i','testsrc=size=320x180:rate=15:duration=3','-f','lavfi','-i','sine=frequency=300:duration=3','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',talk]);
    await ff(['-f','lavfi','-i','testsrc=size=320x180:rate=15:duration=2','-c:v','libx264','-preset','ultrafast',mute]);
    // The real talk clip's transcript is saved ahead, so nothing reaches the network.
    const hash=createHash('sha256').update(await readFile(talk)).digest('hex');
    await mkdir(join(folder,'.edit','transcripts'),{recursive:true});
    await writeFile(join(folder,'.edit','transcripts',`${hash.slice(0,12)}.json`),JSON.stringify({version:1,provider:'assemblyai',providerId:'t',source:talk,
      sourceHash:hash,duration:3,model:'u',words:['hi','there'].map((text,id)=>({id,text,start:id+0.2,end:id+0.7,confidence:1}))}));
    const a=projectAt(folder),lines:string[]=[];
    await openProject(a,{files:[{path:'talk.mp4',role:'a-roll',voice:false,synced:false},{path:'mute.mp4',role:'a-roll',voice:false,synced:false}],vision:null},l=>lines.push(l));
    const {p}=await loadProject(a);
    expect(p.job.clips.map(c=>[c.ref.name,c.ref.role])).toEqual([['talk.mp4','a-roll'],['mute.mp4','b-roll']]);
    expect(lines.some(l=>/mute\.mp4 has no spoken words.*opened as broll/.test(l))).toBe(true);
  },60_000);
});

describe('canvas shape from the clips in the cut (asm-8)',()=>{
  const ref=(id:string,width:number,height:number,role='b-roll')=>clipRefSchema.parse({id,hash:createHash('sha256').update(id).digest('hex'),name:`${id}.mp4`,kind:'video',role,roleSource:'creator',
    duration:4,fps:{num:24,den:1},width,height,hasAudio:false,timecodeStart:0});
  // Three 16:9 candidates opened first, two 2.37:1 shots picked.
  const clips:JobClip[]=[ref('w1',1920,1080),ref('w2',1920,1080),ref('w3',1920,1080),ref('s1',1920,810),ref('s2',1920,810)].map(r=>({ref:r,words:[]}));
  const job:Job={id:'j',name:'J',clips,style:styleOf(undefined)};
  it('takes the shape of the picked clips, not the most opened',()=>{
    const d=buildCut(job,[{clip:'s1'},{clip:'s2'}]);
    expect(d.canvas).toEqual({width:1920,height:810});
  });
  it('the shape with the most screen time wins a mix',()=>{
    expect(canvasClip(job,[{clipId:'w1',in:0,out:1},{clipId:'s1',in:0,out:3}]).id).toBe('s1');
    expect(canvasClip(job,[{clipId:'w1',in:0,out:3},{clipId:'s1',in:0,out:1}]).id).toBe('w1');
  });
  it('a speaker in the cut still sets it',()=>{
    const talk={ref:ref('t',1080,1920,'a-roll'),words:[{id:0,text:'hi',start:0.5,end:1}]};
    expect(canvasClip({...job,clips:[...clips,talk]},[{clipId:'s1',in:0,out:3},{clipId:'t',in:0,out:1}]).id).toBe('t');
  });
});
