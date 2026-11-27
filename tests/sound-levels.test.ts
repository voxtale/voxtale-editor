// Cutting by sound level: 10 ms levels, findCuts,
// cuts in the quietest spot, and `clean` segments in buildCut. Synthetic
// levels only: no file, no ffmpeg.
import {describe,expect,test} from 'bun:test';
import {clipRefSchema} from '@voxtale/editdoc';
import {LEVEL_STEP,answerFrameCall,badFrameCall,levelFrames,packLevels,unpackLevels,type FrameHost} from '@voxtale/frames';

import {buildCut,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {findCuts,isFiller,keptSpans,quietest,threshold,type Levels} from '../src/video/sound-levels';

const ROOM=-70,TALK=-20;
const levels=(seconds:number,f:(t:number)=>number):Levels=>({step:LEVEL_STEP,db:Array.from({length:Math.round(seconds/LEVEL_STEP)},(_,k)=>f((k+0.5)*LEVEL_STEP))});
/** Loud inside these spans, room tone elsewhere. */
const talk=(seconds:number,spans:[number,number][])=>levels(seconds,t=>spans.some(([a,b])=>t>=a&&t<b)?TALK:ROOM);
const W=[{id:0,text:'Hello',start:1,end:1.4},{id:1,text:'um',start:2,end:2.2},{id:2,text:'world.',start:3,end:3.4}];
const clip=(words:JobClip['words'],duration=6):JobClip=>({ref:clipRefSchema.parse({id:'c1',hash:'a'.repeat(64),name:'a.mov',kind:'video',role:'a-roll',roleSource:'index',duration,width:640,height:360,hasAudio:true}),words});
const jobOf=(c:JobClip):Job=>({id:'j',name:'J',clips:[c],style:styleOf(undefined)});

describe('levels',()=>{
  test('10 ms windows in dBFS, packed one byte a step',()=>{
    const rate=8000,s=new Float32Array(rate);
    for(let i=rate/2;i<rate;i++)s[i]=Math.sin(2*Math.PI*440*i/rate);
    const db=levelFrames(s,rate);
    expect(db.length).toBe(100);
    expect(db[10]).toBe(-100);
    expect(db[80]).toBe(-3); // a full-scale sine: half power
    expect(unpackLevels(packLevels(db))).toEqual(db);
  });
  test('the quietest spot between two words',()=>{
    const lv=levels(2,t=>t>=0.9&&t<0.92?-60:TALK);
    expect(quietest(lv,0.5,1.5)).toBeCloseTo(0.9,6);
  });
  test('threshold sits between room and voice',()=>{
    const t=threshold(talk(6,[[1,1.4],[3,3.4]]).db);
    expect(t).toBeGreaterThan(ROOM);
    expect(t).toBeLessThan(TALK);
  });
  test('fillers',()=>{
    for(const w of ['um','Uh,','erm','hmm','euh'])expect(isFiller(w)).toBe(true);
    for(const w of ['ah','well','umbrella'])expect(isFiller(w)).toBe(false);
  });
});

describe('findCuts',()=>{
  const lv=talk(6,[[1,1.4],[2,2.2],[3,3.4]]);
  test('drops the um and shortens the pauses, never inside a kept word',()=>{
    const cuts=findCuts([{source:'c1',in:0.5,out:4}],{c1:W},{c1:lv},{pause:0.25,fillers:true});
    expect(cuts.some(c=>c.reason==='hesitation'&&c.a<=2&&c.b>=2.2)).toBe(true);
    for(const w of [W[0]!,W[2]!])for(const c of cuts)expect(c.b<=w.start+1e-6||c.a>=w.end-1e-6).toBe(true);
    const kept=keptSpans(0.5,4,cuts);
    // The air that plays between the two kept words is about the pause asked for.
    const air=(kept[0]![1]-1.4)+(3-kept[1]![0]);
    expect(kept.length).toBe(2);
    expect(air).toBeGreaterThan(0.15);
    expect(air).toBeLessThan(0.35);
  });
  test('fillers kept: only pauses go, the um stays',()=>{
    const cuts=findCuts([{source:'c1',in:0.5,out:4}],{c1:W},{c1:lv},{pause:0.25,fillers:false});
    expect(cuts.every(c=>c.reason==='pause')).toBe(true);
    expect(keptSpans(0.5,4,cuts).some(([a,b])=>a<=2&&b>=2.2)).toBe(true);
  });
  test('a clip with no words is left alone',()=>{
    expect(findCuts([{source:'c1',in:0,out:4}],{c1:[]},{c1:lv},{pause:0.25,fillers:true})).toEqual([]);
  });
});

describe('buildCut by level',()=>{
  const c=clip(W),lv=talk(6,[[1,1.4],[2,2.2],[3,3.4]]);
  test('a clean segment splits where the sound says, and drops the um',()=>{
    const doc=buildCut(jobOf(c),[{clip:'c1',from:0,to:2,pace:'slow',clean:{}}],{levels:()=>lv});
    const items=doc.tracks['a-roll'];
    expect(items.length).toBe(2);
    expect(items.some(i=>i.in<2.2&&i.out>2)).toBe(false);
    expect(items.every(i=>i.reason?.startsWith('(cleaned)'))).toBe(true);
    expect(new Set(items.map(i=>i.id)).size).toBe(items.length);
  });
  test('without levels a clean segment cuts by words as before',()=>{
    const plain=buildCut(jobOf(c),[{clip:'c1',from:0,to:2,pace:'slow'}]);
    const blind=buildCut(jobOf(c),[{clip:'c1',from:0,to:2,pace:'slow',clean:{}}]);
    expect(blind.tracks['a-roll']).toEqual(plain.tracks['a-roll']);
  });
  test('words that run together: the edge goes to the trough, not halfway',()=>{
    // Kept word 1.05-1.4 with its neighbour ending at 1.0: the quiet dip is at 1.01, early in the gap.
    const words=[{id:0,text:'so',start:0.6,end:1},{id:1,text:'this',start:1.05,end:1.4},{id:2,text:'works',start:1.45,end:1.8}];
    const dip=levels(4,t=>t>=1.01&&t<1.02?-60:t>=0.6&&t<1.8?TALK:ROOM);
    const doc=buildCut(jobOf(clip(words,4)),[{clip:'c1',from:1,to:2}],{levels:()=>dip});
    const half=buildCut(jobOf(clip(words,4)),[{clip:'c1',from:1,to:2}]);
    expect(doc.tracks['a-roll'][0]!.in).toBeLessThanOrEqual(half.tracks['a-roll'][0]!.in);
    expect(doc.tracks['a-roll'][0]!.in).toBeCloseTo(1,2);
  });
});

describe('levels over the relay',()=>{
  test('a levels call is checked and answered',async()=>{
    expect(badFrameCall({op:'levels',clip:'a'.repeat(64)})).toBeNull();
    expect(badFrameCall({op:'levels',clip:'../x'})).toBe('bad levels');
    const host={levels:async()=>Uint8Array.of(1,2,3)} as unknown as FrameHost;
    const r=await answerFrameCall(host,{op:'levels',clip:'a'.repeat(64)});
    expect(r.ok).toBe(true);
    expect([...r.files.levels!.bytes]).toEqual([1,2,3]);
  });
});
