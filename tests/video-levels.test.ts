// Speech level per segment: measured from the sound, matched toward the
// middle level of the cut, applied as a-roll gain at finish.
import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipRefSchema} from '@voxtale/editdoc';
import {ffmpeg,localFrames} from '@voxtale/frames';

import {styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {editorTools,type Workspace} from '../src/video/editor/agent/tools';
import {LEVEL_MAX_DB,levelGains,speechLevel} from '../src/video/levels';

const tone=(amp:number,seconds:number,rate=8000)=>Float32Array.from({length:seconds*rate},(_,i)=>amp*Math.sin(2*Math.PI*200*i/rate));

describe('speech level',()=>{
  test('level of a tone, in dB re full scale',()=>{
    expect(speechLevel(tone(0.5,1),8000)!).toBeCloseTo(-9,0);
    expect(speechLevel(tone(0.5,1),8000)!-speechLevel(tone(0.125,1),8000)!).toBeCloseTo(12,0);
  });
  test('pauses do not pull the level down',()=>{
    const talk=tone(0.5,1),withPause=new Float32Array(3*8000);
    withPause.set(talk,0);
    expect(speechLevel(withPause,8000)!).toBeCloseTo(speechLevel(talk,8000)!,0);
  });
  test('no sound has no level',()=>{
    expect(speechLevel(new Float32Array(8000),8000)).toBeUndefined();
    expect(speechLevel(new Float32Array(0),8000)).toBeUndefined();
  });
  test('gains pull toward the median, leave small differences, and stop at the cap',()=>{
    expect(levelGains([-20,-20.5,-24,-40,-20.2,undefined])).toEqual([0,0,3.5,LEVEL_MAX_DB,0,0]);
    expect(levelGains([-30])).toEqual([0]);
    expect(levelGains([undefined,undefined])).toEqual([0,0]);
  });
});

describe('levels at finish (ffmpeg)',()=>{
  let dir='';
  const hash='a'.repeat(64);
  const words='one two three four five six seven eight nine ten eleven twelve'.split(' ').map((text,i)=>({id:i,text,start:1+i*0.6,end:1.4+i*0.6}));
  const speaker:JobClip={ref:clipRefSchema.parse({id:'c1',hash,name:'c1.mov',kind:'video',role:'a-roll',roleSource:'index',duration:10,width:640,height:360,hasAudio:true}),words};
  const job:Job={id:'j',name:'J',clips:[speaker],style:styleOf(undefined)};
  beforeAll(async()=>{
    dir=await mkdtemp(join(tmpdir(),'levels-'));
    // Loud for six seconds, then 12 dB down.
    await ffmpeg()(['-f','lavfi','-i','color=c=black:s=640x360:r=30:d=10','-f','lavfi','-i','sine=f=220:r=48000:d=10','-af',"volume='if(lt(t,6),0.5,0.125)':eval=frame",'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',join(dir,'a.mp4')]);
  },60_000);
  afterAll(async()=>{await rm(dir,{recursive:true,force:true});});

  test('the quiet segment comes up; the others stay',async()=>{
    const ws:Workspace={dir:join(dir,'ws'),job,segments:[],placements:[],captions:[],zooms:[],broll:[],text:[],chapters:[],graphics:{},graphicsEnabled:false,
      frames:localFrames({sources:{[hash]:join(dir,'a.mp4')},dir:join(dir,'frames')})};
    await Bun.write(join(ws.dir,'.keep'),'');
    const tool=(name:string)=>editorTools(ws).find(t=>t.name===name)!;
    await tool('set_cut').run({segments:[{clip:'c1',from:0,to:2},{clip:'c1',from:4,to:6},{clip:'c1',from:9,to:11}]});
    expect(ws.doc!.tracks['a-roll'].map(i=>i.gainDb)).toEqual([0,0,0]);
    await tool('watch_cut').run({});
    const done=await tool('finish').run({summary:'A summary long enough to pass.'});
    expect(done.isError).toBeFalsy();
    expect(done.text).toContain('1 segment');
    expect(ws.doc!.tracks['a-roll'].map(i=>i.gainDb)).toEqual([0,0,LEVEL_MAX_DB]);
  },60_000);

  test('a host that cannot read sound leaves levels alone',async()=>{
    const host=localFrames({sources:{[hash]:join(dir,'a.mp4')},dir:join(dir,'frames3')});
    delete host.audio;
    const ws:Workspace={dir:join(dir,'ws2'),job,segments:[],placements:[],captions:[],zooms:[],broll:[],text:[],chapters:[],graphics:{},graphicsEnabled:false,frames:host};
    await Bun.write(join(ws.dir,'.keep'),'');
    const tool=(name:string)=>editorTools(ws).find(t=>t.name===name)!;
    await tool('set_cut').run({segments:[{clip:'c1',from:0,to:2},{clip:'c1',from:9,to:11}]});
    await tool('watch_cut').run({});
    expect((await tool('finish').run({summary:'A summary long enough to pass.'})).isError).toBeFalsy();
    expect(ws.doc!.tracks['a-roll'].map(i=>i.gainDb)).toEqual([0,0]);
  },60_000);
});
