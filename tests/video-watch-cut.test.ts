// watch_cut: frames of the output timeline, layers stacked as the render
// stacks them. Plan by code; one real ffmpeg sheet.
import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipRefSchema,pipBox} from '@voxtale/editdoc';
import {ffmpeg,localFrames} from '@voxtale/frames';

import {buildCut,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {drawPreview,previewShots,previewTimes,PREVIEW_MAX} from '../src/video/editor/agent/preview';
import {editorTools,type Workspace} from '../src/video/editor/agent/tools';

const words='one two three four five six seven eight nine ten eleven twelve'.split(' ').map((text,i)=>({id:i,text,start:1+i*0.6,end:1.4+i*0.6}));
const hash=(c:string)=>c.repeat(64);
const W=640,H=360;
const speaker:JobClip={ref:clipRefSchema.parse({id:'c1',hash:hash('a'),name:'c1.mov',kind:'video',role:'a-roll',roleSource:'index',duration:10,width:W,height:H,hasAudio:true}),words};
const screen:JobClip={ref:clipRefSchema.parse({id:'s1',hash:hash('b'),name:'s1.mov',kind:'video',role:'screen',roleSource:'index',duration:10,width:W,height:H,hasAudio:false}),words:[]};
const job:Job={id:'j',name:'J',clips:[speaker,screen],style:styleOf(undefined)};
const segs=[{clip:'c1',from:0,to:11}];
const cut=()=>buildCut(job,segs,{broll:[{id:'x',broll:'s1',clip:'c1',word:5,seconds:3,in:1,speed:2,pip:'top-left',reason:'r'}]});
const hashOf=(id:string)=>job.clips.find(c=>c.ref.id===id)?.ref.hash;

describe('watch_cut plan',()=>{
  test('times sit mid-slice and stop at the cap',()=>{
    expect(previewTimes(0,8,4)).toEqual([1,3,5,7]);
    expect(previewTimes(0,60,99)).toHaveLength(PREVIEW_MAX);
  });
  test('each frame stacks what the render stacks: speaker, footage at its speed, corner speaker',()=>{
    const doc=cut(),b=doc.tracks['b-roll'][0]!;
    const [before,during]=previewShots(doc,[b.start-0.5,b.start+1],hashOf,()=>undefined);
    expect(before!.layers.map(l=>l.clip)).toEqual([hash('a')]);
    expect(before!.notes).toEqual(['speaker']);
    expect(during!.layers.map(l=>l.clip)).toEqual([hash('a'),hash('b'),hash('a')]);
    // One second in at 2x is two source seconds on.
    expect(during!.layers[1]!.t).toBeCloseTo(b.in+2,3);
    expect(during!.layers[2]!.box).toEqual(pipBox(doc.canvas,'top-left'));
    expect(during!.layers[2]!.t).toBeCloseTo(during!.layers[0]!.t,6);
    expect(during!.notes.join(' ')).toContain('2x');
  });
  test('a gap in the cut is named',()=>{
    const doc=cut(),end=Math.max(...doc.tracks['a-roll'].map(i=>i.end));
    expect(previewShots(doc,[end+5],hashOf,()=>undefined)[0]!.notes[0]).toContain('NO SPEAKER');
  });
});

describe('watch_cut sheet (ffmpeg)',()=>{
  let dir='';
  const ff=ffmpeg();
  const sources:Record<string,string>={};
  beforeAll(async()=>{
    dir=await mkdtemp(join(tmpdir(),'watch-cut-'));
    sources[hash('a')]=join(dir,'a.mp4');
    sources[hash('b')]=join(dir,'b.mp4');
    // Speaker: black. Footage: white.
    await ff(['-f','lavfi','-i',`color=c=black:s=${W}x${H}:r=30:d=10`,'-f','lavfi','-i','sine=f=440:r=48000:d=10','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',sources[hash('a')]!]);
    await ff(['-f','lavfi','-i',`color=c=white:s=${W}x${H}:r=30:d=10`,'-c:v','libx264','-pix_fmt','yuv420p',sources[hash('b')]!]);
  },60_000);
  afterAll(async()=>{await rm(dir,{recursive:true,force:true});});

  const grey=async(jpg:Uint8Array)=>{
    const p=Bun.spawn(['ffmpeg','-v','error','-i','pipe:0','-f','rawvideo','-pix_fmt','gray','-'],{stdin:'pipe',stdout:'pipe'});
    p.stdin.write(jpg);p.stdin.end();
    const probe=Bun.spawn(['ffprobe','-v','error','-show_entries','stream=width,height','-of','csv=p=0','pipe:0'],{stdin:'pipe',stdout:'pipe'});
    probe.stdin.write(jpg);probe.stdin.end();
    const [w,h]=(await new Response(probe.stdout).text()).trim().split(',').map(Number);
    return {px:new Uint8Array(await new Response(p.stdout).arrayBuffer()),w:w!,h:h!};
  };

  test('the sheet shows the speaker, then the footage with the speaker in its corner',async()=>{
    const doc=cut(),b=doc.tracks['b-roll'][0]!;
    const shots=previewShots(doc,[b.start-0.5,b.start+1],hashOf,()=>undefined);
    const sheet=await drawPreview({shots,canvas:doc.canvas,frames:localFrames({sources,dir:join(dir,'frames')}),dir:join(dir,'preview'),ff});
    const {px,w,h}=await grey(sheet);
    const cell=(w-4)/2;
    const at=(x:number,y:number)=>px[Math.round(y)*w+Math.round(x)]!;
    // Left cell: the speaker (black). Right cell: footage (white) with the speaker (black) top-left.
    expect(at(cell/2,h/2)).toBeLessThan(40);
    expect(at(cell+4+cell*0.7,h*0.7)).toBeGreaterThan(215);
    const k=cell/doc.canvas.width,box=pipBox(doc.canvas,'top-left');
    expect(at(cell+4+(box.x+box.width/2)*k,(box.y+box.height/2)*k)).toBeLessThan(40);
  },60_000);

  test('text behind the speaker: the cut-out speaker goes back over the graphic',async()=>{
    const webm=join(dir,'g.webm');
    await ff(['-f','lavfi','-i',`color=c=white:s=${W}x${H}:r=30:d=1`,'-c:v','libvpx-vp9','-pix_fmt','yuva420p',webm]);
    const shot={t:1,layers:[{clip:hash('a'),t:1,fit:'cover' as const}],graphics:[{webm,t:0.5,behind:true}],notes:[] as string[]};
    // Mask: the left half of the still is the speaker.
    const cutout=async(still:string,out:string)=>{await ff(['-i',still,'-vf','geq=lum=if(lt(X\\,W/2)\\,255\\,0),format=gray',out]);return true;};
    const sheet=await drawPreview({shots:[shot],canvas:{width:W,height:H},frames:localFrames({sources,dir:join(dir,'frames2')}),dir:join(dir,'preview2'),ff,cutout});
    const {px,w,h}=await grey(sheet);
    const at=(x:number,y:number)=>px[Math.round(y)*w+Math.round(x)]!;
    expect(at(w*0.25,h/2)).toBeLessThan(40);
    expect(at(w*0.75,h/2)).toBeGreaterThan(215);
    expect(shot.notes).toContain('speaker cut out over the graphic');
  },60_000);

  test('finish sends an unwatched cut back once; a full watch clears it',async()=>{
    const ws:Workspace={dir:join(dir,'ws'),job,segments:[],placements:[],captions:[],zooms:[],broll:[],text:[],chapters:[],graphics:{},graphicsEnabled:false,
      frames:localFrames({sources,dir:join(dir,'frames2')})};
    await Bun.write(join(ws.dir,'.keep'),'');
    const tool=(name:string)=>editorTools(ws).find(t=>t.name===name)!;
    await tool('set_cut').run({segments:segs});
    expect((await tool('finish').run({summary:'A summary long enough to pass.'})).isError).toBe(true);
    const seen=await tool('watch_cut').run({});
    expect(seen.images).toHaveLength(1);
    expect(seen.text).toContain('speaker');
    expect((await tool('finish').run({summary:'A summary long enough to pass.'})).isError).toBeFalsy();
    expect(ws.finished).toBeDefined();
  },60_000);
});
