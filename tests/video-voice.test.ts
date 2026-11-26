// What code hears beyond the words: stressed words, lines said again, the
// real edges of a word, and what goes wrong across a join.
import {describe,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipRefSchema} from '@voxtale/editdoc';
import {VOICE_STEP,packVoice,unpackVoice,voiceFrames,type FrameHost} from '@voxtale/frames';

import {buildCut,packTranscript,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {editorTools,type Workspace} from '../src/video/editor/agent/tools';
import {findRetakes,joinSound,retakeText,stressedWords,voiceOf,wordEdge,type Voice} from '../src/video/voice';

const ROOM=-70,TALK=-30;
/** A voice track from a level and pitch per second. */
const voice=(seconds:number,f:(t:number)=>{db:number;f0?:number}):Voice=>{
  const n=Math.round(seconds/VOICE_STEP),db=new Float32Array(n),f0=new Float32Array(n);
  for(let k=0;k<n;k++){const x=f(k*VOICE_STEP);db[k]=x.db;f0[k]=x.f0??0;}
  return {db,f0};
};
const say=(text:string,t0=1,each=0.3,gap=0.1)=>text.split(' ').map((w,i)=>({id:i,text:w,start:t0+i*(each+gap),end:t0+i*(each+gap)+each}));
type W=ReturnType<typeof say>[number];
/** Talk at TALK while a word is on, the room between; `loud` words are 9 dB up and higher. */
const spoken=(words:W[],loud:number[]=[],early=0)=>voice(words.at(-1)!.end+2,t=>{
  const w=words.find(x=>t>=x.start-early&&t<x.end);
  return w?{db:TALK+(loud.includes(w.id)?9:0),f0:loud.includes(w.id)?190:120}:{db:ROOM};
});

describe('voice track',()=>{
  test('packs to two bytes a step and comes back close',()=>{
    const fs=[{db:-30.2,f0:118},{db:-71,f0:0},{db:-3,f0:300}];
    const back=unpackVoice(packVoice(fs));
    back.forEach((b,k)=>{
      expect(Math.abs(b.db-fs[k]!.db)).toBeLessThanOrEqual(0.25);
      expect(fs[k]!.f0?Math.abs(12*Math.log2(b.f0/fs[k]!.f0)):b.f0).toBeLessThan(0.2);
    });
  });
  test('level and pitch of a tone',()=>{
    const rate=8000,tone=Float32Array.from({length:rate},(_,i)=>0.5*Math.sin(2*Math.PI*150*i/rate));
    const v=voiceOf(packVoice(voiceFrames(tone,rate)));
    expect(v.db[10]!).toBeCloseTo(-9,0);
    expect(Math.abs(v.f0[10]!-150)).toBeLessThan(4);
  });
});

describe('stressed words',()=>{
  const words=say('the biggest shift is that writing code is becoming less of the whole job now');
  test('the louder, higher words, and only those',()=>{
    expect([...stressedWords(spoken(words,[2,6]),words)].sort((a,b)=>a-b)).toEqual([2,6]);
  });
  test('flat speech stresses nothing',()=>{
    expect(stressedWords(spoken(words),words).size).toBe(0);
  });
  test('the transcript marks them',()=>{
    const c:JobClip={ref:clipRefSchema.parse({id:'c1',hash:'a'.repeat(64),name:'a.mov',kind:'video',role:'a-roll',roleSource:'index',duration:20,hasAudio:true}),words};
    expect(packTranscript(c,0.5,new Set([2]))).toContain('biggest *shift* is');
    expect(packTranscript(c)).not.toContain('*');
  });
});

describe('lines said again',()=>{
  test('a false start and its retake are one group, cut by word id',()=>{
    const words=say('so today we can increasingly give it we can increasingly give an agent a goal. and that changes the job.');
    const g=findRetakes(words);
    expect(g).toHaveLength(1);
    expect(g[0]!.takes.map(t=>[t.from,t.to])).toEqual([[2,6],[7,14]]);
    expect(retakeText(g)).toContain('take 2 [7-14');
  });
  test('three tries chain into one group; takes carry delivery when the sound is known',()=>{
    const words=say('which means we will which means we will need which means we will need people who understand systems.');
    const g=findRetakes(words,spoken(words));
    expect(g).toHaveLength(1);
    expect(g[0]!.takes).toHaveLength(3);
    expect(g[0]!.takes[2]!.delivery!.loudDb).toBeCloseTo(TALK,0);
  });
  test('a common phrase used twice in passing is not a retake',()=>{
    const words=say('a lot of people think this is easy and honestly i used to think the same until i saw what a lot of teams do');
    expect(findRetakes(words)).toEqual([]);
  });
});

describe('word edges',()=>{
  const words=[{id:0,text:'first.',start:1,end:1.4},{id:1,text:'second',start:3,end:3.4}];
  // The sound of each word starts 0.1s before its transcript time.
  const v=spoken(words,[],0.1);
  test('a word is heard before its transcript start',()=>{
    expect(wordEdge(v,3,'in',1.4)).toBeCloseTo(2.9,1);
  });
  test('never past the neighbouring word, never the wrong way',()=>{
    expect(wordEdge(v,3,'in',2.96)).toBeGreaterThanOrEqual(2.96);
    expect(wordEdge(v,1.4,'out',3)).toBeCloseTo(1.4,1);
    const hum=voice(10,()=>({db:TALK}));
    expect(3-wordEdge(hum,3,'in',0)).toBeLessThanOrEqual(0.31);
  });
  test('the cut starts before the heard edge, not inside the word',()=>{
    const c:JobClip={ref:clipRefSchema.parse({id:'c1',hash:'a'.repeat(64),name:'a.mov',kind:'video',role:'a-roll',roleSource:'index',duration:10,width:640,height:360,hasAudio:true}),words};
    const job:Job={id:'j',name:'J',clips:[c],style:styleOf(undefined)};
    const plain=buildCut(job,[{clip:'c1',from:1,to:1}]).tracks['a-roll'][0]!.in;
    const heard=buildCut(job,[{clip:'c1',from:1,to:1}],{edge:(_c,t,side,limit)=>wordEdge(v,t,side,limit)}).tracks['a-roll'][0]!.in;
    // Without the sound, the lead stops at the heard edge (rounded out to its frame); with it, before.
    expect(plain).toBeGreaterThanOrEqual(2.9-1e-9);
    expect(heard).toBeLessThan(2.85);
  });
});

describe('sound across a join',()=>{
  const words=say('one two three four five six seven eight',1,0.4,0.6);
  const v=spoken(words);
  test('a cut in the pauses is clean',()=>{
    expect(joinSound({voice:v,t:words[1]!.end+0.2,ends:true},{voice:v,t:words[5]!.start-0.2})).toEqual([]);
  });
  test('a cut inside a word says which side is clipped',()=>{
    const notes=joinSound({voice:v,t:words[1]!.end+0.2,ends:true},{voice:v,t:words[5]!.start+0.1});
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('first word');
    expect(joinSound({voice:v,t:words[1]!.end-0.1,ends:true},{voice:v,t:words[5]!.start-0.2})[0]).toContain('last word');
  });
  test('a change of room, a level step and a pitch jump mid-sentence are heard',()=>{
    const noisy=voice(12,t=>words.some(w=>t>=w.start&&t<w.end)?{db:TALK+10,f0:180}:{db:ROOM+12});
    const notes=joinSound({voice:v,t:words[1]!.end+0.2},{voice:noisy,t:words[5]!.start-0.2}).join('\n');
    expect(notes).toContain('room noise steps up');
    expect(notes).toContain('louder');
    expect(notes).toContain('jumps up');
    // The same join at a sentence end: a new pitch is how a new sentence starts.
    expect(joinSound({voice:v,t:words[1]!.end+0.2,ends:true},{voice:noisy,t:words[5]!.start-0.2}).join('\n')).not.toContain('jumps');
  });
  test('no sound measured, nothing claimed',()=>{
    expect(joinSound({t:1},{voice:v,t:2})).toEqual([]);
  });
});

describe('in the agent tools',()=>{
  const hash='a'.repeat(64);
  const words=say('so today we can increasingly give it we can increasingly give an agent a real goal. and that changes the whole job for us.',1,0.3,0.1);
  const mk=(host:Partial<FrameHost>):Workspace=>({dir:mkdtempSync(join(tmpdir(),'voice-test-')),
    job:{id:'j',name:'J',style:styleOf(undefined),clips:[{ref:clipRefSchema.parse({id:'c1',hash,name:'a.mov',kind:'video',role:'a-roll',roleSource:'index',duration:20,width:640,height:360,hasAudio:true}),words}]},
    segments:[],placements:[],captions:[],zooms:[],broll:[],text:[],chapters:[],graphics:{},graphicsEnabled:false,
    frames:{filmstrip:async()=>new Uint8Array(),joins:async()=>new Uint8Array(),frames:async(_c,ts)=>ts.map(()=>null),graphic:async()=>({ok:false,report:'no'}),...host}});
  const pack=(v:Voice)=>packVoice(Array.from(v.db,(db,k)=>({db,f0:v.f0[k]!})));
  const run=(ws:Workspace,name:string,args:Record<string,unknown>={})=>editorTools(ws).find(t=>t.name===name)!.run(args);

  test('the transcript shows stress and retakes; a join cut at heard word edges raises no sound note',async()=>{
    let asked=0;
    const ws=mk({voice:async()=>{asked++;return pack(spoken(words,[15]));}});
    const text=(await run(ws,'get_transcript')).text!;
    expect(text).toContain('*goal.*');
    expect(text).toContain('Said more than once');
    // Whole words either side: the cut snaps to the sound, so nothing is clipped.
    const cut=(await run(ws,'set_cut',{segments:[{clip:'c1',from:7,to:13},{clip:'c1',from:19,to:23}]})).text!;
    expect(cut).not.toContain('sound at joins');
    expect(asked).toBe(1);
  });
  test('a host that cannot read sound: plain transcript, retakes still found from the words',async()=>{
    const ws=mk({});
    const text=(await run(ws,'get_transcript')).text!;
    expect(text).not.toContain('*');
    expect(text).toContain('Said more than once');
    expect((await run(ws,'set_cut',{segments:[{clip:'c1',from:7,to:16}]})).isError).toBeFalsy();
  });
});
