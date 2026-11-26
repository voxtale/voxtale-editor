// Where a cut lands against the sound: frame rounding that never eats a kept
// word, word edges that leave breath and stretched pauses out, and what the
// agent hears back after a cut.
import {describe,expect,test} from 'bun:test';
import {FPS_30,clipRefSchema,snapDown,snapUp} from '@voxtale/editdoc';
import {VOICE_STEP} from '@voxtale/frames';

import {afterClose,buildCut,cutSound,outward,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {quietTo,saidTwice,speechIn,wordEdge,type Voice} from '../src/video/voice';

const ROOM=-70,TALK=-30;
const voice=(seconds:number,f:(t:number)=>{db:number;f0?:number}):Voice=>{
  const n=Math.round(seconds/VOICE_STEP),db=new Float32Array(n),f0=new Float32Array(n);
  for(let k=0;k<n;k++){const x=f((k+0.5)*VOICE_STEP);db[k]=x.db;f0[k]=x.f0??0;}
  return {db,f0};
};
const clip=(words:JobClip['words'],duration=10):JobClip=>({ref:clipRefSchema.parse({id:'c1',hash:'a'.repeat(64),name:'a.mov',kind:'video',role:'a-roll',roleSource:'index',duration,width:640,height:360,hasAudio:true}),words});
const jobOf=(c:JobClip):Job=>({id:'j',name:'J',clips:[c],style:styleOf(undefined)});
const frame=1/30;

describe('frame rounding',()=>{
  test('a word 5ms past a frame boundary keeps its first sound',()=>{
    // Frame 60 is 2.0s. A word heard from 2.005 with no lead left: the nearest frame would also be
    // 2.0, but 2.012 would round to 2.0 and 2.02 to 2.033, past the word's start. Outward is always 2.0.
    expect(outward(2.005,'in',2.005,0,FPS_30)).toBeCloseTo(2,6);
    expect(outward(2.02,'in',2.02,0,FPS_30)).toBeCloseTo(2,6);
    // An out 5ms before a frame boundary (frame 75 = 2.5s) ends on it, not on the frame before.
    expect(outward(2.495,'out',2.495,9,FPS_30)).toBeCloseTo(2.5,6);
  });
  test('rounds inward only when outward would reach a cut neighbour and inward still holds the word',()=>{
    // Neighbour's sound ends at 1.99; the edge at 1.995 floors to 1.9667, inside the neighbour.
    expect(outward(1.995,'in',2.04,1.99,FPS_30)).toBeCloseTo(2,6);
    // No inward frame holds the word: outward wins, even into the neighbour.
    expect(outward(1.995,'in',1.998,1.99,FPS_30)).toBeCloseTo(1+29/30,6);
  });
  test('frame helpers: exact frames stay put',()=>{
    expect(snapDown(2,FPS_30)).toBe(2);
    expect(snapUp(2,FPS_30)).toBe(2);
    expect(snapDown(2+0.005,FPS_30)).toBe(2);
    expect(snapUp(2+0.005,FPS_30)).toBeCloseTo(2+frame,9);
  });
  test('every kept word sits whole inside its piece, at fast pace too',()=>{
    // Word edges 5ms off frame boundaries, pauses just long enough to cut.
    const words=Array.from({length:8},(_,i)=>({id:i,text:`w${i}`,start:1.005+i*0.8,end:1.495+i*0.8}));
    const c=clip(words),doc=buildCut(jobOf(c),[{clip:'c1',from:0,to:7,pace:'fast'}]);
    const items=doc.tracks['a-roll'];
    expect(items.length).toBeGreaterThan(1);
    for(const w of words)expect(items.some(i=>i.in<=w.start+1e-9&&i.out>=w.end-1e-9)).toBe(true);
    for(const i of items){expect(Math.abs(i.in*30-Math.round(i.in*30))).toBeLessThan(1e-6);expect(Math.abs(i.out*30-Math.round(i.out*30))).toBeLessThan(1e-6);}
  });
});

describe('word edges from the sound',()=>{
  test('an in-breath the transcript put inside the word is trimmed off',()=>{
    // Transcript: word 2.0-2.6. Breath (unvoiced, 25 dB under the voice) 2.0-2.15, a 0.1s hush, voice from 2.25.
    const v=voice(6,t=>t>=2&&t<2.15?{db:TALK-25}:t>=2.25&&t<2.6?{db:TALK,f0:120}:{db:ROOM});
    expect(wordEdge(v,2,'in',0,2.6)).toBeCloseTo(2.25,1);
    // An s run straight into the vowel is the word's, however quiet.
    const s=voice(6,t=>t>=2&&t<2.15?{db:TALK-25}:t>=2.15&&t<2.6?{db:TALK,f0:120}:{db:ROOM});
    expect(wordEdge(s,2,'in',0,2.6)).toBeLessThanOrEqual(2);
    // Without the other end it never moves inward.
    expect(wordEdge(v,2,'in',0)).toBeLessThanOrEqual(2);
  });
  test('a breath before the word does not pull the cut back into it',()=>{
    const v=voice(6,t=>t>=1.6&&t<1.95?{db:TALK-25}:t>=1.95&&t<2.6?{db:TALK,f0:120}:{db:ROOM});
    expect(wordEdge(v,2,'in',0,2.6)).toBeGreaterThan(1.9);
  });
  test('a word stretched over a pause ends where its sound does',()=>{
    // Transcript: "script" 3.0-4.4. Voice 3.0-3.4, a quiet click at 4.0 (25 dB under, voiced).
    const v=voice(8,t=>t>=3&&t<3.4?{db:TALK,f0:120}:t>=4&&t<4.06?{db:TALK-25,f0:100}:{db:ROOM});
    expect(wordEdge(v,4.4,'out',6,3)).toBeCloseTo(3.4,1);
    const c=clip([{id:0,text:'the',start:2.5,end:2.9},{id:1,text:'script',start:3,end:4.4},{id:2,text:'next',start:5,end:5.4}]);
    const doc=buildCut(jobOf(c),[{clip:'c1',from:0,to:1}],{edge:(_c,t,side,limit,other)=>wordEdge(v,t,side,limit,other)});
    expect(doc.tracks['a-roll'][0]!.out).toBeLessThan(3.8);
  });
  test('a quiet "ts" at the end of the word stays',()=>{
    // "markets" in S1: the vowel, then unvoiced hiss 26 dB under the voice to the transcript end.
    const v=voice(8,t=>t>=3&&t<3.3?{db:TALK,f0:120}:t>=3.3&&t<3.45?{db:TALK-26}:{db:ROOM});
    expect(wordEdge(v,3.45,'out',6,3)).toBeGreaterThanOrEqual(3.44);
  });
  test('two real syllables split by a gap both stay',()=>{
    const v=voice(8,t=>(t>=3&&t<3.3)||(t>=3.55&&t<3.9)?{db:TALK,f0:120}:{db:ROOM});
    expect(wordEdge(v,3.9,'out',6,3)).toBeCloseTo(3.9,1);
  });
  test('a short unvoiced onset touching the word is the word; a long one is breath',()=>{
    // An s (unvoiced, 24 dB under the voice, 26 over a quiet room) from 1.92 straight into the word at 2.0.
    const room=-80;
    const s=voice(6,t=>t>=1.92&&t<2?{db:TALK-24}:t>=2&&t<2.5?{db:TALK,f0:120}:{db:room});
    expect(wordEdge(s,2,'in',0)).toBeCloseTo(1.92,1);
    // A 0.3s breath touching the word does not move its edge.
    const b=voice(6,t=>t>=1.7&&t<2?{db:TALK-24}:t>=2&&t<2.5?{db:TALK,f0:120}:{db:room});
    expect(wordEdge(b,2,'in',0)).toBeGreaterThanOrEqual(1.98);
  });
  test('voice before a short catch is the start of the word; after a word, it is not the word',()=>{
    // Voice 1.86-1.94, a 0.06s dip, the transcript word from 2.0.
    const v=voice(6,t=>(t>=1.86&&t<1.94)||(t>=2&&t<2.5)?{db:TALK,f0:120}:{db:ROOM});
    expect(wordEdge(v,2,'in',0)).toBeCloseTo(1.86,1);
    const w=voice(6,t=>(t>=2&&t<2.5)||(t>=2.56&&t<2.7)?{db:TALK,f0:120}:{db:ROOM});
    expect(wordEdge(w,2.5,'out',2.8)).toBeCloseTo(2.5,2);
  });
  test('the lead pad stops at a click before the word',()=>{
    // A click 1.82-1.88, room, the word from 2.0.
    const v=voice(6,t=>t>=1.82&&t<1.88?{db:TALK-12}:t>=2&&t<2.5?{db:TALK,f0:120}:{db:ROOM});
    expect(quietTo(v,2,'in',1.5)).toBeCloseTo(1.88,2);
    expect(quietTo(v,2.5,'out',3)).toBe(3);
    const c=clip([{id:0,text:'word',start:2,end:2.5}]);
    const doc=buildCut(jobOf(c),[{clip:'c1',from:0,to:0}],{edge:(_c,t,side,limit,other)=>wordEdge(v,t,side,limit,other),quiet:(_c,t,side,limit)=>quietTo(v,t,side,limit)});
    const i=doc.tracks['a-roll'][0]!.in;
    expect(i).toBeGreaterThanOrEqual(1.88-1e-9);
    expect(i).toBeLessThanOrEqual(2);
  });
  test('denoised audio: breath over a silent room does not extend a word',()=>{
    // Room at -100 (denoised): room + 20 would count a -50 breath. The clamp to 26 under the voice does not.
    const v=voice(6,t=>t>=2&&t<2.5?{db:TALK,f0:120}:t>=2.5&&t<2.8?{db:TALK-22}:{db:-100});
    expect(wordEdge(v,2.5,'out',5)).toBeLessThan(2.55);
    expect(speechIn(v,2.5,2.8)).toBe(0);
    expect(speechIn(v,2,2.5)).toBeGreaterThan(0.45);
  });
});

describe('what the cut sounds like',()=>{
  const words='one two three four five six'.split(' ').map((text,i)=>({id:i,text,start:1+i,end:1.6+i}));
  const v=voice(10,t=>words.some(w=>t>=w.start-0.02&&t<w.end+0.02)?{db:TALK,f0:120}:{db:ROOM});
  const speech=(_c:string,a:number,b:number)=>speechIn(v,a,b);
  test('a clean cut has no tight joins and no stray words',()=>{
    const c=clip(words),job=jobOf(c),segs=[{clip:'c1',from:0,to:1},{clip:'c1',from:4,to:5}];
    const s=cutSound(job,buildCut(job,segs,{edge:(_c,t,side,limit,other)=>wordEdge(v,t,side,limit,other)}),segs,speech);
    expect(s).toEqual({tight:[],stillHeard:[]});
  });
  test('a join inside sound is tight, and a cut word the piece still plays is heard',()=>{
    const c=clip(words),job=jobOf(c),segs=[{clip:'c1',from:0,to:1},{clip:'c1',from:4,to:5}];
    const doc=buildCut(job,segs);
    // Push the first piece's out into "three" (cut), mid-word.
    const items=doc.tracks['a-roll'],first=items[0]!,grow=3.3-first.out;
    first.out+=grow;first.end+=grow;
    for(const i of items.slice(1)){i.start+=grow;i.end+=grow;}
    const s=cutSound(job,doc,segs,speech);
    expect(s.tight[0]).toMatch(/^tight join at \d+\.\ds: no silence after "three"/);
    expect(s.stillHeard.join('\n')).toContain('"three"');
  });
});

describe('said twice back to back',()=>{
  const w=(text:string)=>text.split(' ').map((t,i)=>({id:i,text:t,start:i*0.3,end:i*0.3+0.25}));
  test('stutters and restarts, one word to three',()=>{
    expect(saidTwice(w('and that that is it'))).toEqual(['[1-2 0.3s] "that that"']);
    expect(saidTwice(w('so you need to you need to love it'))[0]).toContain('"you need to you need to"');
    expect(saidTwice(w('Especially, especially when'))).toHaveLength(1);
  });
  test('no doubles, no lines',()=>{
    expect(saidTwice(w('a lot of people think this is a lot'))).toEqual([]);
  });
});

describe('after the close',()=>{
  const said=['so','that','was','the','lie','there','have','been','many','great','lies'];
  const c=clip(said.map((text,id)=>({id,text,start:id<5?id*0.5:4+id*0.6,end:(id<5?id*0.5:4+id*0.6)+0.3})),30);
  const job=jobOf(c);
  test('shows the line the source says just after the last kept word',()=>{
    const line=afterClose(job,buildCut(job,[{clip:'c1',from:0,to:4}]));
    expect(line).toContain('"there have been many great lies"');
    expect(line).toContain('c1 at 7.0');
  });
  test('says nothing when the source is done or the line is past the look window',()=>{
    expect(afterClose(job,buildCut(job,[{clip:'c1',from:0,to:10}]))).toBeUndefined();
    expect(afterClose(job,buildCut(job,[{clip:'c1',from:0,to:4}]),2)).toBeUndefined();
  });
  test('reads past a closing shot too',()=>{
    expect(afterClose(job,buildCut(job,[{clip:'c1',in:0,out:6}]))).toContain('"there have been many great lies"');
  });
});
