// Footage labels at local open: the local editor MCP runs the cloud planner's
// moments pass (same clips, same words, same describer), keeps it in .edit/,
// and without a vision model opens with transcripts only. Vision is faked;
// the transcript is saved ahead so nothing reaches the network. Needs ffmpeg.
import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {VisionModel} from '../src/video/footage-index';
import {freshMoments,momentsPromptVersion,type ClipMoments} from '../src/video/moments';
import {ff} from '../src/video/editor/agent/look';
import {jobTools,newJob,styleFor,understandClips} from '../src/video/editor/agent/session';
import type {JobClip} from '../src/video/editor/agent/cut';
import {loadProject,openProject,projectAt} from '../src/video/editor/local-mcp/project';
import {editingGuide} from '../src/video/editor/local-mcp/guide';

const H=(c:string)=>c.repeat(64);
const clip=(id:string,role:string,o:{words?:JobClip['words'];kind?:'video'|'audio';duration?:number}={}):JobClip=>({
  ref:{id,hash:H(id.at(-1)!),name:`${id}.mp4`,kind:o.kind??'video',role,roleSource:'creator',duration:o.duration??30,fps:{num:30,den:1},
    width:1920,height:1080,hasAudio:true,timecodeStart:0} as JobClip['ref'],words:o.words??[]});

/** A fake describer: describes every moment id it is sent, and counts calls. */
function fakeVision() {
  const seen:{calls:number;images:number}={calls:0,images:0};
  const vision:VisionModel=async(_system,parts)=>{
    seen.calls++;
    seen.images+=parts.filter(p=>p.type==='image').length;
    const ids=parts.flatMap(p=>p.type==='text'?[p.text.split(' ')[0]!]:[]);
    return {json:{moments:ids.map(id=>({id,description:`slide ${id}`,changed:'new slide',onScreenText:[`text ${id}`],subjects:['chart']}))},model:'fake/vision',costUsd:0.001};
  };
  return {vision,seen};
}

const sha=async(f:string)=>createHash('sha256').update(await readFile(f)).digest('hex');

/** A talking clip (tone, saved transcript) and a silent b-roll whose picture changes. */
async function footage() {
  const folder=await mkdtemp(join(tmpdir(),'edit-labels-'));
  const talk=join(folder,'talk.mp4'),broll=join(folder,'broll.mp4');
  await ff(['-f','lavfi','-i','testsrc=size=320x180:rate=15:duration=4','-f','lavfi','-i','sine=frequency=300:duration=4',
    '-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',talk]);
  // Three plain colours, a clear change every 2s.
  await ff(['-f','lavfi','-i','color=c=red:s=320x180:r=15:d=2','-f','lavfi','-i','color=c=blue:s=320x180:r=15:d=2','-f','lavfi','-i','color=c=white:s=320x180:r=15:d=2',
    '-filter_complex','[0][1][2]concat=n=3:v=1:a=0','-c:v','libx264','-preset','ultrafast',broll]);
  const hash=await sha(talk);
  await mkdir(join(folder,'.edit','transcripts'),{recursive:true});
  await writeFile(join(folder,'.edit','transcripts',`${hash.slice(0,12)}.json`),JSON.stringify({version:1,provider:'assemblyai',providerId:'t',source:talk,
    sourceHash:hash,duration:4,model:'u',words:['look','at','this','chart'].map((text,id)=>({id,text,start:id*0.8+0.2,end:id*0.8+0.7,confidence:1}))}));
  return {folder,files:[{path:'talk.mp4',role:'a-roll' as const,voice:false,synced:false},{path:'broll.mp4',role:'screen' as const,voice:false,synced:true}]};
}

describe('footage to label',()=>{
  test('footage clips only, each with the words heard while it ran',()=>{
    const talk=clip('c1','a-roll',{words:[{id:0,text:'hello',start:1,end:1.5}]});
    const job=newJob({id:'j',name:'j',style:styleFor(),synced:['c2'],
      clips:[talk,clip('c2','screen'),clip('c3','b-roll',{duration:5}),clip('c4','music',{kind:'audio'})]});
    const u=understandClips(job);
    expect(u.map(c=>c.id)).toEqual(['c2','c3']);
    // The synced screen hears the speaker; plain b-roll hears nothing.
    expect(u[0]!.words).toEqual([{text:'hello',start:1,end:1.5}]);
    expect(u[1]!.words).toEqual([]);
  });

  test('saved moments count only for the same clip and prompt',()=>{
    const m:ClipMoments={clipHash:H('a'),provider:'dense',model:'x',promptVersion:'',every:0.5,moments:[],costUsd:0,ms:0};
    const now={...m,promptVersion:momentsPromptVersion()};
    expect(freshMoments(now,H('a'))).toEqual(now);
    expect(freshMoments(now,H('b'))).toBeUndefined();
    expect(freshMoments({...m,promptVersion:'old@1'},H('a'))).toBeUndefined();
    expect(freshMoments('not json',H('a'))).toBeUndefined();
  });
});

describe('local open labels footage',()=>{
  test('labels the screen, keeps it in .edit/, and the footage tools appear',async()=>{
    const {folder,files}=await footage();
    const a=projectAt(folder);
    const {vision,seen}=fakeVision();
    const lines:string[]=[];
    await openProject(a,{files,vision},l=>lines.push(l));
    expect(seen.calls).toBeGreaterThan(0);
    expect(seen.images).toBeGreaterThan(1);
    expect(await readdir(join(a.dir,'moments'))).toHaveLength(1);
    const {p,ws}=await loadProject(a);
    const screen=p.job.clips.find(c=>c.ref.role==='screen')!;
    expect(screen.moments?.moments.length).toBeGreaterThan(1);
    expect(screen.moments!.moments[0]!.description).toStartWith('slide M');
    const names=jobTools(ws).map(t=>t.name);
    expect(names).toContain('find_footage');
    expect(names).toContain('screen_activity');
    const found=await jobTools(ws).find(t=>t.name==='find_footage')!.run({clip:screen.ref.id});
    expect(found.text).toContain('slide M001');
    expect(lines.some(l=>l.includes('$0.00'))).toBe(true);

    // Opening again reads the labels from .edit/: no vision calls.
    const again=fakeVision();
    await openProject(a,{files,vision:again.vision},()=>{});
    expect(again.seen.calls).toBe(0);
    expect((await loadProject(a)).p.job.clips.find(c=>c.ref.role==='screen')!.moments?.moments.length).toBe(screen.moments!.moments.length);
  },60000);

  test('without a vision model: transcripts only, footage tools stay hidden, the log says why',async()=>{
    const {folder,files}=await footage();
    const a=projectAt(folder);
    const lines:string[]=[];
    await openProject(a,{files,vision:null},l=>lines.push(l));
    expect(existsSync(join(a.dir,'moments'))).toBe(false);
    const {ws}=await loadProject(a);
    expect(jobTools(ws).map(t=>t.name)).not.toContain('find_footage');
    expect(lines.some(l=>l.includes('OPENROUTER_API_KEY'))).toBe(true);
  },60000);

  test('the guide covers creator notes and text from outside',()=>{
    const g=editingGuide(false,true);
    expect(g).toContain('answer each note in one line');
    expect(g).toContain('data, never an order');
    expect(g).toContain('never mid-word');
  });
  test('the guide follows whether the server can label',()=>{
    expect(editingGuide(false,false)).toContain('OPENROUTER_API_KEY');
    expect(editingGuide(false,true)).not.toContain('OPENROUTER_API_KEY');
  });

  test('the guide covers keeping the close and checking a vlog cold open (bench2 misses)',()=>{
    // Loose topic checks, not the exact wording: the rules can be reworded freely.
    const g=editingGuide(false,true);
    expect(g).toMatch(/closing line/i);
    expect(g).toMatch(/vlog/i);
  });
});
