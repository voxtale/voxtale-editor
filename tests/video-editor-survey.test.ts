// Look before choosing: stills at both edges, camera movement and shot size
// measured from frames, index labels checked against them, a candidate ranking
// that must cover every clip and field, and the gates that refuse unseen
// footage once. From bench2 (asm-1, asm-6, seq-19/21/23/25). No model, no network.
import {afterAll,describe,expect,test} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipIndexSchema,clipRefSchema,type ClipIndex,type ClipRef} from '@voxtale/editdoc';

import {styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import type {FrameHost} from '../src/video/editor/agent/frames';
import {ff} from '../src/video/editor/agent/look';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';
import {labelFlags,measureMovement,rankCandidates,SAMPLE_H,SAMPLE_W,surveyTimes,type Look} from '../src/video/editor/agent/survey';

const W=SAMPLE_W,H=SAMPLE_H;
// A smooth picture with no repeat inside a few pixels: shifts and scales are unambiguous.
const scene=(x:number,y:number)=>128+50*Math.sin(x*0.21+0.3)*Math.cos(y*0.17)+40*Math.sin((x+2*y)*0.09)+25*Math.cos(x*0.05-y*0.33);
function frame(scale:number,dx:number,dy:number):Uint8Array {
  const f=new Uint8Array(W*H),cx=(W-1)/2,cy=(H-1)/2;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)f[y*W+x]=Math.max(0,Math.min(255,Math.round(scene(cx+(x-cx-dx)/scale,cy+(y-cy-dy)/scale))));
  return f;
}
const pushIn=(n:number,step=1.015)=>Array.from({length:n},(_,k)=>frame(step**k,0,0));
const panning=(n:number,px=1)=>Array.from({length:n},(_,k)=>frame(1,-k*px,0));
const still=(n:number)=>Array.from({length:n},()=>frame(1,0,0));

describe('stills and movement',()=>{
  test('stills include the first and the last frame',()=>{
    const t=surveyTimes(4,30);
    expect(t).toHaveLength(5);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBeCloseTo(4-1/30,3);
  });
  test('push-in, pan and static are told apart',()=>{
    expect(measureMovement(pushIn(12)).movement).toBe('push-in');
    expect(measureMovement(pushIn(12)).scale).toBeGreaterThan(1.1);
    expect(measureMovement(pushIn(12,1/1.015)).movement).toBe('pull-out');
    const pan=measureMovement(panning(14));
    expect(pan.movement).toBe('pan right');
    expect(measureMovement(still(10))).toMatchObject({movement:'static',scale:1,dx:0,dy:0});
    // asm-1's right slot-3 clip: about 4.5% over 40 frames, too slow for any one step.
    expect(measureMovement(pushIn(40,1.0011)).movement).toBe('push-in');
    expect(measureMovement(panning(14,0.25)).movement).toBe('pan right');
  });
});

const seg=(id:string,start:number,end:number,over:Record<string,unknown>={})=>({id,start,end,description:'a person',subjects:[],action:'',setting:'',
  shotType:'medium',onScreenText:[],quality:{blur:false,exposure:'ok',shaky:false},usable:true,...over});
const index=(hash:string,segments:ReturnType<typeof seg>[]):ClipIndex=>clipIndexSchema.parse({clipHash:hash.repeat(64),promptVersion:'t',model:'t',summary:'footage',roleGuess:'b-roll',segments});

describe('index labels against frames',()=>{
  test('a still label over a measured push-in, a size the face contradicts, an unlabelled and a long segment are flagged',()=>{
    const ix=index('d',[
      seg('S001',0,4,{description:'woman stands facing forward in a field',face:{x:0.5,y:0.4,w:0.1,h:0.2}}),
      seg('S002',4,6,{shotType:'close',face:{x:0.5,y:0.4,w:0.05,h:0.08}}),
      seg('S003',6,8,{usable:null}),
      seg('S004',8,16),
    ]);
    const push:Look={movement:'push-in',scale:1.12,dx:0,dy:0,fit:0.4,change:0.05};
    const flags=labelFlags(ix,(a)=>a<4?push:undefined);
    const by=(id:string)=>flags.filter(f=>f.segment===id).map(f=>f.why).join(' | ');
    expect(by('S001')).toContain('frames show push-in');
    expect(by('S002')).toContain('says close');
    expect(by('S003')).toContain('never labelled');
    expect(by('S004')).toContain('at most 2 stills');
    // Labels that agree with the frames pass.
    expect(labelFlags(index('d',[seg('S001',0,4,{face:{x:0.5,y:0.4,w:0.1,h:0.2}})]),()=>push)).toEqual([]);
  });
});

describe('ranking candidates',()=>{
  const fields=['subject','shot size','camera movement'];
  const sc=(clip:string,a:number,b:number,c:number,size='medium shot',move='static')=>[
    {clip,field:'subject',score:a,seen:'a woman in a field'},{clip,field:'shot size',score:b,seen:size},{clip,field:'camera movement',score:c,seen:move}];
  const measured=(id:string)=>id==='c6'?{look:{movement:'push-in',scale:1.1,dx:0,dy:0,fit:0.4,change:0.04} as Look,size:'medium' as const}:{look:{movement:'static',scale:1,dx:0,dy:0,fit:0,change:0} as Look,size:'close' as const};
  test('ranks by total, and flags what the agent saw against the measures',()=>{
    const r=rankCandidates({fields,candidates:['c5','c6'],viewed:new Set(['c5','c6']),measured,
      scores:[...sc('c5',2,0,2,'tight close-up','static'),...sc('c6',2,2,2,'knees-up medium','still camera')]});
    expect(r.ranked.map(x=>x.clip)).toEqual(['c6','c5']);
    expect(r.flags.join()).toContain('c6 camera movement: you saw it still; the frames measure push-in');
    expect(r.missing).toEqual([]);
  });
  test('every field for every candidate, every candidate scored and looked at',()=>{
    const r=rankCandidates({fields,candidates:['c5','c6','c7'],viewed:new Set(['c5']),measured,
      scores:[...sc('c5',2,2,2),sc('c6',1,1,1)[0]!]});
    expect(r.missing).toEqual(['c6: shot size','c6: camera movement']);
    expect(r.unviewed).toEqual(['c6']);
    expect(r.unscored).toEqual(['c7']);
  });
});

// Tool level: a speaker, and three wordless clips like asm-1's.
const ref=(id:string,role:ClipRef['role'],hash:string,over:Partial<ClipRef>={})=>clipRefSchema.parse({id,hash:hash.repeat(64),name:`${id}.mp4`,
  kind:'video',role,roleSource:'creator',duration:40,fps:{num:30,den:1},width:1920,height:1080,hasAudio:true,timecodeStart:0,...over});
const words=Array.from({length:60},(_,i)=>({id:i,text:i%10===9?`w${i}.`:`w${i}`,start:1+i*0.5,end:1.4+i*0.5}));
const quiet={hasAudio:false,duration:8};
const job=():Job=>({id:'j',name:'Survey',style:styleOf(undefined),clips:[
  {ref:ref('c1','a-roll','a'),words},
  {ref:ref('c5','b-roll','b',quiet),words:[],index:index('b',[seg('S001',0,8,{description:'close-up of a woman',shotType:'close',face:{x:0.5,y:0.4,w:0.2,h:0.4}})])},
  {ref:ref('c6','b-roll','c',quiet),words:[],index:index('c',[seg('S001',0,4,{description:'woman stands facing forward',face:{x:0.5,y:0.4,w:0.1,h:0.2}}),seg('S002',4,8,{face:{x:0.5,y:0.4,w:0.1,h:0.2}})])},
  {ref:ref('c7','b-roll','e',quiet),words:[]},
] as JobClip[]});

const dirs:string[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});

let jpeg:Uint8Array;
async function start() {
  const dir=await mkdtemp(join(tmpdir(),'survey-'));dirs.push(dir);
  if(!jpeg) {
    await ff(['-f','lavfi','-i','color=gray:s=64x36','-frames:v','1',join(dir,'g.jpg')]);
    jpeg=new Uint8Array(await readFile(join(dir,'g.jpg')));
  }
  const asked:string[]=[];
  const host:FrameHost={filmstrip:async()=>new Uint8Array(),joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''}),
    frames:async(_c,times)=>{asked.push(times.join(','));return times.map(()=>jpeg);},
    // c6 ('c' hash) pushes in; the others hold still.
    sample:async(clip)=>{const fs=clip.startsWith('c')?pushIn(40,1.004):still(40);const out=new Uint8Array(fs.length*W*H);fs.forEach((f,k)=>out.set(f,k*W*H));return out;}};
  const ws=newWorkspace({dir,job:job(),frames:host,graphics:false});
  const tools=jobTools(ws);
  const run=async(name:string,args:unknown)=>{try{return await tools.find(t=>t.name===name)!.run(args as never);}catch(e){return {text:String((e as Error).message),isError:true};}};
  const call=async(name:string,args:unknown)=>{const r=await run(name,args);if(r.isError)throw new Error(r.text);return r.text;};
  return {ws,run,call,asked};
}

describe('survey_clips and the look-first gates',()=>{
  test('survey shows edge stills, measures, and flags the wrong label',async()=>{
    const {ws,call,asked}=await start();
    const out=await call('survey_clips',{});
    expect(asked[0]!.split(',')[0]).toBe('0');
    expect(out).toContain('c6');
    expect(out).toMatch(/c6[^\n]*\n {2}camera: push-in/);
    expect(out).toContain('LOW CONFIDENCE S001: reads as a still shot, but the frames show push-in');
    expect(out).toMatch(/c5[^\n]*\n.*\n {2}shot size: close/);
    expect(out).toContain('every footage clip looked at');
    expect([...ws.viewed!]).toEqual(['c5','c6','c7']);
    expect(await call('survey_clips',{})).toContain('every footage clip has been looked at');
  });
  test('show_footage refuses an unseen clip once; set_cut shots wait for every clip once',async()=>{
    const {run,call}=await start();
    await call('set_cut',{segments:[{clip:'c1',from:0,to:59}]});
    const first=await run('show_footage',{id:'aa',footage:'c5',clip:'c1',word:10,seconds:2,in:1,reason:'r'});
    expect(first.isError).toBe(true);
    expect(first.text).toContain('look at c5 first');
    expect((await run('show_footage',{id:'aa',footage:'c5',clip:'c1',word:10,seconds:2,in:1,reason:'r'})).isError).toBeFalsy();
    const shots=[{clip:'c1',from:0,to:30},{clip:'c6',in:0,out:3},{clip:'c1',from:31,to:59}];
    // c6 is placed unseen: refused every time, not once.
    for(let k=0;k<2;k++) {
      const refused=await run('set_cut',{segments:shots});
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('look at c6 before you place it');
    }
    // c6 seen; c7 (not placed) not looked at yet is refused once only.
    await call('survey_clips',{clips:['c6']});
    const once=await run('set_cut',{segments:shots});
    expect(once.isError).toBe(true);
    expect(once.text).toContain('c7 not looked at yet');
    expect((await run('set_cut',{segments:shots})).isError).toBeFalsy();
  });
  test('wordless shots side by side wait for a close look at each',async()=>{
    const {run,call,ws}=await start();
    await call('survey_clips',{});
    const shots=[{clip:'c1',from:0,to:30},{clip:'c6',in:0,out:3},{clip:'c7',in:0,out:3},{clip:'c1',from:31,to:59},{clip:'c5',in:0,out:3}];
    for(let k=0;k<2;k++) {
      const no=await run('set_cut',{segments:shots});
      expect(no.isError).toBe(true);
      expect(no.text).toContain('seen only as survey stills: c6, c7');
      expect(no.text).not.toContain('c5');
    }
    await call('timeline_view',{clip:'c6',start:0,end:8});
    expect((await run('set_cut',{segments:shots})).text).toContain('seen only as survey stills: c7');
    await call('timeline_view',{clip:'c7',start:0,end:8});
    expect((await run('set_cut',{segments:shots})).isError).toBeFalsy();
    expect([...ws.looked!]).toEqual(['c6','c7']);
  });
  test('clips whose frames cannot be read never hold the cut',async()=>{
    const {run,ws}=await start();
    ws.frames={...ws.frames,filmstrip:async()=>{throw new Error('no frames');}};
    await run('survey_clips',{});
    expect((await run('timeline_view',{clip:'c6',start:0,end:8})).isError).toBe(true);
    (ws.unseeable??=new Set()).add('c7');
    ws.viewed!.add('c7');
    expect((await run('set_cut',{segments:[{clip:'c1',from:0,to:30},{clip:'c6',in:0,out:3},{clip:'c7',in:0,out:3}]})).isError).toBeFalsy();
  });
  test('a clip the agent marks unsure waits for a close look, talk clips too (seq-26)',async()=>{
    const {run,call}=await start();
    await call('survey_clips',{});
    // c1 speaks, so no footage gate holds it; marking it unsure does, every time.
    const shots=[{clip:'c5',in:0,out:3},{clip:'c1',from:0,to:30}];
    for(let k=0;k<2;k++) {
      const no=await run('set_cut',{segments:shots,unsure:['c1','c5']});
      expect(no.isError).toBe(true);
      expect(no.text).toContain('unsure where c1, c5 go');
    }
    await call('timeline_view',{clip:'c1',start:0,end:40});
    // A note that says so counts too.
    const noted=await run('set_cut',{segments:[{clip:'c5',in:0,out:3,note:'could swap with the talk line'},{clip:'c1',from:0,to:30}]});
    expect(noted.text).toContain('unsure where c5 goes');
    await call('timeline_view',{clip:'c5',start:0,end:8});
    expect((await run('set_cut',{segments:shots,unsure:['c1','c5']})).isError).toBeFalsy();
    // Unsure names a clip not in the cut: nothing to wait on.
    expect((await run('set_cut',{segments:[{clip:'c1',from:0,to:30}],unsure:['c7']})).isError).toBeFalsy();
  });
  test('a lone footage shot passes at once after a survey',async()=>{
    const {run,call}=await start();
    await call('survey_clips',{});
    expect((await run('set_cut',{segments:[{clip:'c1',from:0,to:30},{clip:'c6',in:0,out:3}]})).isError).toBeFalsy();
  });
  test('rank_candidates refuses unseen clips, then ranks and checks movement against the frames',async()=>{
    const {run,call}=await start();
    const scores=[
      {clip:'c5',field:'shot size',score:0,seen:'tight close-up'},{clip:'c5',field:'camera movement',score:0,seen:'static'},
      {clip:'c6',field:'shot size',score:2,seen:'medium, knees up'},{clip:'c6',field:'camera movement',score:1,seen:'static'},
    ];
    const args={slot:'slot 4: medium-wide, slow push-in',fields:['shot size','camera movement'],candidates:['c5','c6'],scores};
    const no=await run('rank_candidates',args);
    expect(no.isError).toBe(true);
    expect(no.text).toContain('look at c5, c6 first');
    await call('survey_clips',{clips:['c5','c6']});
    const out=await call('rank_candidates',args);
    expect(out).toMatch(/1\. c6 3\n2\. c5 0/);
    expect(out).toContain('c6 camera movement: you saw it still; the frames measure push-in');
  });
});

describe('editor skill versions',()=>{
  test('v24 lays the survey-then-look rule on v23 without touching it',async()=>{
    const {AGENT_SKILL_PROMPT_ID}=await import('../src/video/editor/agent/skill');
    const {promptTextVersion}=await import('../src/services/prompts');
    const v23=promptTextVersion(AGENT_SKILL_PROMPT_ID,23),v24=promptTextVersion(AGENT_SKILL_PROMPT_ID,24);
    expect(v24).not.toBe(v23);
    expect(v24.length).toBeGreaterThan(v23.length);
  });
  test('v25 only adds to v24 (every v24 line kept)',async()=>{
    const {AGENT_SKILL_PROMPT_ID}=await import('../src/video/editor/agent/skill');
    const {promptTextVersion}=await import('../src/services/prompts');
    const v24=promptTextVersion(AGENT_SKILL_PROMPT_ID,24),v25=promptTextVersion(AGENT_SKILL_PROMPT_ID,25);
    const lines=new Set(v25.split('\n'));
    expect(v24.split('\n').filter(l=>!lines.has(l))).toEqual([]);
    expect(v25.length).toBeGreaterThan(v24.length);
  });
});
