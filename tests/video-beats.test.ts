// The beat grid: tempo found from sound by code, and a cut that lands on it.
import {describe,expect,test} from 'bun:test';
import {clipRefSchema} from '@voxtale/editdoc';

import {beatGrid,findBeats,nearestBeat} from '../src/video/beats';
import {buildCut,checkCut,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';

const RATE=11025;
/** A decaying thump every beat, over a quiet tone. */
const clicks=(bpm:number,first:number,seconds:number)=>{
  const out=new Float32Array(RATE*seconds),period=60/bpm;
  for(let i=0;i<out.length;i++) {
    const t=i/RATE,since=((t-first)%period+period)%period;
    out[i]=0.8*Math.sin(2*Math.PI*90*t)*Math.exp(-30*since)+0.02*Math.sin(2*Math.PI*440*t);
  }
  return out;
};

describe('finding the beat',()=>{
  test('tempo and first beat of a steady pulse',()=>{
    for(const [bpm,first] of [[128,0.37],[93.5,0.2],[70,0.05]] as const) {
      const b=findBeats(clicks(bpm,first,60),RATE)!;
      expect(Math.abs(b.bpm-bpm)).toBeLessThan(0.3);
      expect(Math.abs(b.first-first)).toBeLessThan(0.03);
    }
  });
  test('sound with no pulse has no grid',()=>{
    let seed=7;
    const noise=Float32Array.from({length:RATE*30},()=>((seed=(seed*1103515245+12345)%2147483648)/2147483648-0.5)*0.4);
    expect(findBeats(noise,RATE)).toBeUndefined();
    expect(findBeats(new Float32Array(RATE*30),RATE)).toBeUndefined();
    expect(findBeats(clicks(120,0,3),RATE)).toBeUndefined();
  });
});

const ref=(id:string,role:'a-roll'|'b-roll'|'music',hash:string,more:object={})=>clipRefSchema.parse({id,hash:hash.repeat(64),name:`${id}.mov`,
  kind:role==='music'?'audio':'video',role,roleSource:'index',duration:60,...(role==='music'?{}:{width:1920,height:1080}),hasAudio:role!=='b-roll',...more});
// Words 0.4s long, 0.6s of silence between each pair.
const words='one two three four five six seven eight nine ten eleven twelve'.split(' ').map((text,i)=>({id:i,text,start:2+i,end:2.4+i}));
const speaker:JobClip={ref:ref('c1','a-roll','a'),words};
const cutaway:JobClip={ref:ref('c2','b-roll','b'),words:[]};
const music=(beats?:{bpm:number;first:number}):JobClip=>({ref:ref('m1','music','c',beats?{beats}:{}),words:[]});
const job=(m:JobClip):Job=>({id:'j',name:'J',clips:[speaker,cutaway,m],style:styleOf(undefined)});
const segs=[{clip:'c1',from:0,to:1},{clip:'c1',from:3,to:4},{clip:'c1',from:6,to:7},{clip:'c1',from:9,to:11}];

describe('the grid on the timeline',()=>{
  test('beats follow the bed, through a loop and an in point',()=>{
    const doc={clips:[ref('m1','music','c',{beats:{bpm:120,first:0.25}})]};
    const g=beatGrid(doc,[{clipId:'m1',in:0,start:0,end:2,status:'applied'},{clipId:'m1',in:1,start:10,end:11,status:'applied'}])!;
    expect(g.times.map(t=>+t.toFixed(2))).toEqual([0.25,0.75,1.25,1.75,10.25,10.75]);
    expect(nearestBeat(g,0.8,0.1)).toBeCloseTo(0.75);
    expect(nearestBeat(g,1,0.1)).toBeUndefined();
    expect(beatGrid({clips:[ref('m1','music','c')]},[{clipId:'m1',in:0,start:0,end:2,status:'applied'}])).toBeUndefined();
  });
});

describe('a cut on the beat',()=>{
  // v5 (bd super-tale-oxhv): the voice leads. Speech joins stay on the words; only free gestures snap, and only to a firm beat.
  const plain=buildCut(job(music()),segs);
  const onBeat=buildCut(job(music({bpm:100,first:0.1})),segs);
  test('speech joins stay where the words put them',()=>{
    expect(onBeat.tracks['a-roll'].map(i=>[i.in,i.out,i.start,i.end])).toEqual(plain.tracks['a-roll'].map(i=>[i.in,i.out,i.start,i.end]));
    expect(checkCut(job(music({bpm:100,first:0.1})),onBeat,segs).metrics.joinsOnBeat).toBeUndefined();
  });
  test('music with no beat leaves the cut as it was',()=>{
    const none=buildCut({...job(music()),clips:[speaker,cutaway]},segs);
    expect(plain.tracks['a-roll'].map(i=>[i.in,i.out])).toEqual(none.tracks['a-roll'].map(i=>[i.in,i.out]));
  });
  const broll=[{id:'b',broll:'c2',clip:'c1',word:9,seconds:2,reason:'r'}];
  const was=buildCut(job(music()),segs,{broll}).tracks['b-roll'][0]!;
  // A grid with a beat 80 ms after where the shot would start.
  const near=(confidence?:number)=>music({bpm:100,first:+((was.start+0.08)%0.6).toFixed(3),...(confidence!==undefined?{confidence}:{})} as {bpm:number;first:number});
  test('footage starts on a firm beat when one is close, and keeps its length',()=>{
    const j=job(near(0.8)),doc=buildCut(j,segs,{broll});
    const shot=doc.tracks['b-roll'][0]!,grid=beatGrid(doc,doc.tracks.music)!;
    const frame=doc.fps.den/doc.fps.num;
    expect(shot.start).not.toBeCloseTo(was.start,2);
    expect(nearestBeat(grid,shot.start,frame)).toBeDefined();
    expect(shot.end-shot.start).toBeCloseTo(was.end-was.start,3);
    expect(shot.out-shot.in).toBeCloseTo(shot.end-shot.start,3);
    expect(checkCut(j,doc,segs).metrics.changesOnBeat).toBe('1/1');
  });
  test('a weak beat snaps nothing, and the check says so',()=>{
    const j=job(near(0.2)),doc=buildCut(j,segs,{broll});
    expect(doc.tracks['b-roll'][0]!.start).toBeCloseTo(was.start,3);
    const m=checkCut(j,doc,segs).metrics;
    expect(String(m.musicBeat)).toContain('weak beat');
    expect(String(m.musicBeat)).toContain('did not snap');
    expect(m.changesOnBeat).toBeUndefined();
  });
});

describe('music shape',()=>{
  const j=job(music());
  const all=[{clip:'c1',from:0,to:11}];
  test('music comes in on its word and leaves a dropped line bare',()=>{
    const whole=buildCut(j,all).tracks.music;
    expect(whole).toHaveLength(1);
    expect(whole[0]!.start).toBe(0);
    const doc=buildCut(j,all,{music:{from:{clip:'c1',word:2},drops:[{clip:'c1',from:6,to:7}]}});
    const ms=doc.tracks.music,word=(id:number)=>doc.tracks['a-roll'][0]!.start+words[id]!.start-doc.tracks['a-roll'][0]!.in;
    expect(ms).toHaveLength(2);
    expect(ms[0]!.start).toBeCloseTo(word(2),0);
    expect(ms[0]!.end).toBeLessThanOrEqual(word(6));
    expect(ms[1]!.start).toBeGreaterThanOrEqual(word(7)+0.4-0.05);
    // The bed picks up where the track would be, so its beat does not slip.
    expect(ms[1]!.in-ms[0]!.in).toBeCloseTo(ms[1]!.start-ms[0]!.start,2);
    expect(ms[0]!.fadeOut).toBeLessThan(1);
  });
  test('a drop on a cut line changes nothing; a start word that was cut means the start',()=>{
    const doc=buildCut(j,[{clip:'c1',from:3,to:11}],{music:{from:{clip:'c1',word:0},drops:[{clip:'c1',from:1,to:2}]}});
    expect(doc.tracks.music).toHaveLength(1);
    expect(doc.tracks.music[0]!.start).toBe(0);
  });
});

describe('effects by kind',()=>{
  test('name first, then length',async()=>{
    const {sfxKind}=await import('../src/video/audio');
    expect(sfxKind({name:'Whoosh 03.wav',duration:0.3})).toBe('sweep');
    expect(sfxKind({name:'ui-pop.mp3',duration:1.2})).toBe('tick');
    expect(sfxKind({name:'a.wav',duration:0.2})).toBe('tick');
    expect(sfxKind({name:'a.wav',duration:1.4})).toBe('sweep');
  });
  test('chapters get the sweep, text gets the tick',()=>{
    const fx=(id:string,name:string,duration:number,hash:string):JobClip=>({ref:clipRefSchema.parse({id,hash:hash.repeat(64),name,kind:'audio',role:'sfx',roleSource:'creator',duration,hasAudio:true}),words:[]});
    const style=styleOf(undefined);
    const jj:Job={id:'j',name:'J',clips:[speaker,fx('s1','pop.wav',0.2,'d'),fx('s2','whoosh.wav',1,'e')],style:{...style,audio:{...style.audio,sfx:'punchy'}}};
    const doc=buildCut(jj,[{clip:'c1',from:0,to:11}],{chapters:[{clip:'c1',word:0,title:'A'},{clip:'c1',word:4,title:'B'}],
      text:[{id:'t',clip:'c1',word:8,seconds:2,template:'callout',text:'Hi',position:'auto',reason:'r'}]});
    const by=(what:string)=>doc.tracks.sfx.filter(s=>s.reason!.includes(what)).map(s=>s.clipId);
    expect(by('chapter')).toEqual(['s2']);
    expect(by('text')).toEqual(['s1']);
  });
});
