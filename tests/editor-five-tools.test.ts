// The five editor tools of batch v26: set_sfx (bd super-tale-qvvr), the music
// in-point and firm-beat snap (oxhv), set_look (xaf7), the loudness report
// (jxrx), standing rules (ghk4). Wiring by tool id and prompt id, never prompt
// copy. No model, no network.
import {afterAll,describe,expect,test} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyGrade,clipRefSchema,lutFor,type RGB} from '@voxtale/editdoc';

import {buildCut,musicCues,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import type {FrameHost} from '../src/video/editor/agent/frames';
import {ff} from '../src/video/editor/agent/look';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';
import {correctionFor,frameStats,loudnessLines} from '../src/video/editor/agent/sound-look';
import {acceptedRules,asksToLast,decideRule,parseRules,pendingRules,proposeRule,retireRule,rulesBrief} from '../src/video/editor/rules';
import {fileRules} from '../src/video/editor/rules-file';
import {libraryByHash,libraryClipId,librarySound,sfxWarnings,soundPeak,SFX_RATE,SFX_SOUND_IDS} from '../src/video/sfx';
import {loudnessReport,planRender} from '../src/video/render-edit';
import {taskPrompt} from '../src/video/editor/agent/plan';
import {mcpHandler} from '../src/video/editor/agent/mcp-protocol';
import {localEditorServer} from '../src/video/editor/local-mcp/server';
import {writeFile} from 'node:fs/promises';

const ref=(id:string,role:'a-roll'|'music',hash:string,more:object={})=>clipRefSchema.parse({id,hash:hash.repeat(64),name:`${id}.${role==='music'?'wav':'mov'}`,
  kind:role==='music'?'audio':'video',role,roleSource:'index',duration:60,...(role==='music'?{}:{width:1920,height:1080}),hasAudio:true,...more});
const words='one two three four five six seven eight nine ten eleven twelve'.split(' ').map((text,i)=>({id:i,text,start:2+i,end:2.4+i}));
const speaker:JobClip={ref:ref('c1','a-roll','a',{loudness:{lufs:-20,truePeakDb:-3}}),words};
const music=(more:object={}):JobClip=>({ref:ref('m1','music','c',more),words:[]});
const job=(clips:JobClip[]=[speaker],more:Partial<Job>={}):Job=>({id:'j',name:'J',clips,style:styleOf(undefined),...more});

const dirs:string[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});
const tmp=async(p:string)=>{const d=await mkdtemp(join(tmpdir(),p));dirs.push(d);return d;};

/** A JPEG of one flat colour, from ffmpeg. */
async function flat(hex:string):Promise<Uint8Array> {
  const d=await tmp('flat-'),f=join(d,'f.jpg');
  await ff(['-f','lavfi','-i',`color=${hex}:s=160x90`,'-frames:v','1',f]);
  return new Uint8Array(await readFile(f));
}

async function start(j:Job,jpeg?:Uint8Array) {
  const dir=await tmp('five-');
  const host:FrameHost={filmstrip:async()=>new Uint8Array(),joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''}),
    frames:async(_c,times)=>times.map(()=>jpeg??new Uint8Array()),sample:async()=>new Uint8Array()};
  const ws=newWorkspace({dir,job:j,frames:host,graphics:false});
  const tools=jobTools(ws);
  const run=async(name:string,args:unknown)=>{try{return await tools.find(t=>t.name===name)!.run(args as never);}catch(e){return {text:String((e as Error).message),isError:true};}};
  const call=async(name:string,args:unknown)=>{const r=await run(name,args);if(r.isError)throw new Error(r.text);return r.text;};
  return {ws,dir,tools,run,call};
}

describe('wiring',()=>{
  test('the three new tools are on every job; skill v26+ is active and names them',async()=>{
    const {tools}=await start(job());
    const names=tools.map(t=>t.name);
    for(const n of ['set_sfx','set_look','propose_rule'])expect(names).toContain(n);
    const {AGENT_SKILL_PROMPT_ID}=await import('../src/video/editor/agent/skill');
    const {promptText,promptTextVersion}=await import('../src/services/prompts');
    const v25=promptTextVersion(AGENT_SKILL_PROMPT_ID,25),v26=promptTextVersion(AGENT_SKILL_PROMPT_ID,26);
    // v26 added them; later versions (v27+) must keep them.
    for(const n of ['set_sfx','set_look','propose_rule'])expect(promptText(AGENT_SKILL_PROMPT_ID)).toContain(n);
    for(const n of ['set_sfx','set_look','propose_rule'])expect(v26).toContain(n);
    expect(v26.length).toBeGreaterThan(v25.length);
  });
});

describe('sound effects (qvvr)',()=>{
  test('library sounds are made again byte for byte, and peak inside the file',()=>{
    for(const s of SFX_SOUND_IDS) {
      const a=librarySound(s);
      expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(libraryByHash(a.hash)?.sound).toBe(s);
      expect(a.peak).toBeGreaterThan(0);
      expect(a.peak).toBeLessThan(a.duration);
      expect(soundPeak(a.samples,SFX_RATE).t).toBeCloseTo(a.peak,6);
    }
    expect(libraryByHash('0'.repeat(64))).toBeUndefined();
  });
  test('set_sfx lands each hit with its peak on the word, and checks the rattle',async()=>{
    const {ws,call,run}=await start(job());
    expect((await run('set_sfx',{hits:[]})).isError).toBe(true);
    await call('set_cut',{segments:[{clip:'c1',from:0,to:11}]});
    const out=await call('set_sfx',{hits:[
      {on:{clip:'c1',word:3},sound:'click',reason:'list starts'},
      {on:{clip:'c1',word:4},sound:'click',reason:'next'},
    ]});
    expect(out).toContain('2 hit(s)');
    const doc=ws.doc!,a=doc.tracks['a-roll'][0]!;
    const hit=doc.tracks.sfx.find(i=>i.id==='sfx-h1')!;
    expect(hit.clipId).toBe(libraryClipId('click'));
    expect(doc.clips.some(c=>c.id===libraryClipId('click'))).toBe(true);
    const word=a.start+words[3]!.start-a.in;
    expect(Math.abs(hit.start+librarySound('click').peak-hit.in-word)).toBeLessThanOrEqual(1/30+1e-6);
    // A level the voice would fight: louder than its target.
    const loud=await call('set_sfx',{hits:[{on:{clip:'c1',word:3},sound:'impact',level:-2,reason:'r'}]});
    expect(loud).toContain('level down');
    const bad=await run('set_sfx',{hits:[{on:{item:'g-nope'},sound:'pop',reason:'r'}]});
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('no item');
  });
  test('the rattle and machine-gun checks',()=>{
    const w=sfxWarnings([{id:'a',sound:'click',at:1,gainDb:0},{id:'b',sound:'click',at:1.2,gainDb:0},{id:'c',sound:'pop',at:3,gainDb:0},{id:'d',sound:'pop',at:4,gainDb:0}]);
    expect(w.some(x=>x.includes('under 0.4s'))).toBe(true);
    expect(w.some(x=>x.includes('machine gun'))).toBe(true);
  });
});

describe('music in-point and firm beat (oxhv)',()=>{
  test('by default the track starts where it comes alive',()=>{
    const j=job([speaker,music({beats:{bpm:120,first:0.1,confidence:0.8,livelyFrom:4.2}})]);
    const doc=buildCut(j,[{clip:'c1',from:0,to:11}]);
    expect(musicCues(j,doc)).toEqual({in:4.2});
    expect(doc.tracks.music[0]!.in).toBeCloseTo(4.2,1);
    const none=buildCut(job([speaker,music({beats:{bpm:120,first:0.1}})]),[{clip:'c1',from:0,to:11}]);
    expect(none.tracks.music[0]!.in).toBe(0);
  });
  test('set_music takes an in-point and reports the beat it found',async()=>{
    const {ws,call,run}=await start(job([speaker,music({beats:{bpm:96,first:0.2,confidence:0.2,livelyFrom:1}})]));
    await call('set_cut',{segments:[{clip:'c1',from:0,to:11}]});
    const out=await call('set_music',{clip:'m1',in:12});
    expect(ws.doc!.tracks.music[0]!.in).toBeCloseTo(12,1);
    expect(out).toContain('weak beat, did not snap');
    expect((await run('set_music',{clip:'m1',in:59})).isError).toBe(true);
  });
});

describe('colour (xaf7)',()=>{
  test('a dark warm frame gets more light and less cast, and the LUT carries it',()=>{
    const px:RGB[]=Array.from({length:400},(_,i)=>[0.32+0.0001*i,0.22,0.14]);
    const s=frameStats(px);
    expect(s.stopsFromTarget).toBeLessThan(-1/3);
    const g=correctionFor(s);
    expect(g.exposure).toBeGreaterThan(0);
    expect(g.temperature).toBeDefined();
    const after=frameStats(px.map(p=>applyGrade(g,p)));
    expect(Math.abs(after.stopsFromTarget)).toBeLessThan(Math.abs(s.stopsFromTarget));
    expect(Math.abs(after.cast!.temperature)).toBeLessThan(Math.abs(s.cast!.temperature));
    expect(lutFor(undefined)).toBeNull();
    expect(lutFor({exposure:0.5})).not.toBeNull();
    // A frame on target with no cast needs nothing.
    expect(correctionFor(frameStats(Array.from({length:50},()=>[0.45,0.45,0.45] as RGB)))).toEqual({});
  });
  test('set_look measures, grades, returns a before|after still, and the render draws the LUT',async()=>{
    const {ws,call}=await start(job(),await flat('0x4a3020'));
    await call('set_cut',{segments:[{clip:'c1',from:0,to:11}]});
    const r=await (async()=>{const t=jobTools(ws).find(x=>x.name==='set_look')!;return t.run({clip:'c1',look:'warm',intensity:20} as never);})();
    expect(r.text).toContain('before:');
    expect(r.text).toContain('after:');
    expect(r.images?.length).toBe(1);
    const g=ws.doc!.clips.find(c=>c.id==='c1')!.grade!;
    expect(g.exposure).toBeGreaterThan(0);
    expect(g.look).toBe('warm');
    const plan=planRender(ws.doc!,{['a'.repeat(64)]:'/x/c1.mov'},{},{c1:'/x/c1.cube'});
    expect(plan.pictures.some(p=>p.lut==='/x/c1.cube')).toBe(true);
    // Off keeps the settings for later.
    await call('set_look',{clip:'c1',off:true});
    expect(ws.doc!.clips.find(c=>c.id==='c1')!.grade!.enabled).toBe(false);
  });
});

describe('loudness (jxrx)',()=>{
  test('the agent sees target, speech gain, and the delivered file against the target',async()=>{
    const {ws,call}=await start(job());
    await call('set_cut',{segments:[{clip:'c1',from:0,to:11}]});
    const lines=loudnessLines(ws,ws.doc!);
    expect(lines[0]).toContain(`${ws.doc!.mix.loudnessLufs} LUFS`);
    expect(lines.join('\n')).toContain('speech: -20.0 LUFS as recorded');
    expect(await call('check_cut',{})).toContain('loudness target');
    const rep=loudnessReport({before:{lufs:-19,truePeakDb:-2},gainDb:5,after:{lufs:-14.2,truePeakDb:-0.4}},{lufs:-14,truePeakDb:-1});
    expect(rep[1]).toContain('on target');
    expect(rep[1]).toContain('over the -1 dBTP ceiling');
    expect(loudnessReport({before:{lufs:-19,truePeakDb:-2},gainDb:5,after:{lufs:-17,truePeakDb:-3}},{lufs:-14,truePeakDb:-1})[1]).toContain('-3.0 LU off target');
  });
});

describe('standing rules (ghk4)',()=>{
  test('only lasting words ask for a rule',()=>{
    expect(asksToLast('from now on put the logo top right')).toBe(true);
    expect(asksToLast('Always cut the ums')).toBe(true);
    expect(asksToLast('cut the ums here')).toBe(false);
  });
  test('propose once, accept with the creator\'s wording, refuse, retire',()=>{
    let {rules,rule}=proposeRule([],{text:'Logo top right',said:'always logo top right'},1);
    expect(proposeRule(rules,{text:'logo  top right!',said:'x'},2).fresh).toBe(false);
    const r2=proposeRule(rules,{text:'No music under the intro',said:'from now on no music in intros'},3);
    rules=r2.rules;
    expect(pendingRules(rules)).toHaveLength(2);
    rules=decideRule(rules,rule.id,'accept','Logo in the top right corner',4);
    rules=decideRule(rules,r2.rule.id,'refuse',undefined,5);
    expect(acceptedRules(rules).map(r=>r.text)).toEqual(['Logo in the top right corner']);
    expect(rulesBrief(acceptedRules(rules).map(r=>r.text))[1]).toBe('- Logo in the top right corner');
    expect(rulesBrief([])).toEqual([]);
    expect(acceptedRules(retireRule(rules,rule.id))).toEqual([]);
    expect(()=>decideRule(rules,'rule-x','accept')).toThrow();
    expect(parseRules([...rules,{id:1},null,'x'])).toHaveLength(2);
  });
  test('propose_rule records the proposal for the host; rules come in the next edit\'s brief',async()=>{
    const {ws,call,dir}=await start(job());
    expect(await call('propose_rule',{rule:'Put the logo in the top right corner',said:'always put my logo top right'})).toContain('Proposed');
    expect(await call('propose_rule',{rule:'put the logo in the top right corner',said:'x'})).toBe('Already proposed.');
    expect(ws.proposedRules).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir,'rules-proposed.json'),'utf8'))).toHaveLength(1);
    // The host stores it; the creator accepts; the next edit loads it.
    const store=fileRules(join(dir,'rules.json'));
    expect(await store.load()).toEqual([]);
    const p=proposeRule(await store.load(),{text:ws.proposedRules![0]!.text,said:ws.proposedRules![0]!.said});
    await store.save(decideRule(p.rules,p.rule.id,'accept'));
    const next=newWorkspace({dir:await tmp('next-'),job:job([speaker],{rules:acceptedRules(await store.load()).map(r=>r.text)}),frames:{} as FrameHost,graphics:false});
    expect(next.job.rules).toEqual(['Put the logo in the top right corner']);
  });
  test('the brief carries accepted rules, and asks for a proposal only on lasting words',()=>{
    const brief=taskPrompt(job([speaker],{rules:['Logo top right'],instruction:'from now on no music in the intro'}),false);
    expect(brief).toContain('- Logo top right');
    expect(brief).toContain('propose_rule');
    expect(taskPrompt(job([speaker],{instruction:'tighten the intro'}),false)).not.toContain('propose_rule');
  });
  test('local editor MCP: rules lists the file, decide_rule writes the answer',async()=>{
    const dir=await tmp('rules-mcp-'),file=join(dir,'rules.json');
    const p=proposeRule([],{text:'Captions always in yellow',said:'always yellow captions'});
    await writeFile(file,JSON.stringify(p.rules));
    const answer=mcpHandler(localEditorServer({folder:dir,graphics:false,rulesFile:file,vision:null},()=>()=>{}));
    const req=(name:string,args:object)=>answer({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}) as Promise<any>;
    expect((await req('rules',{})).result.content[0].text).toContain('[proposed] Captions always in yellow');
    const out=(await req('decide_rule',{id:p.rule.id,decision:'accept',text:'Captions in yellow'})).result.content[0].text;
    expect(out).toContain('[accepted] Captions in yellow');
    expect(acceptedRules(await fileRules(file).load()).map(r=>r.text)).toEqual(['Captions in yellow']);
    expect((await req('decide_rule',{id:'rule-nope',decision:'refuse'})).result.isError).toBe(true);
  });
});
