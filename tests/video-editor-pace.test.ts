// Rhythm in the agent's cut: pace per segment, held beats, chapters, a lead
// on footage, a cold open, and the jump report.
import {describe,expect,test} from 'bun:test';
import {clipRefSchema} from '@voxtale/editdoc';

import {buildCut,checkCut,styleOf,visibleJumps,type Job,type JobClip} from '../src/video/editor/agent/cut';

const ref=(id:string,role:'a-roll'|'b-roll',hash:string)=>clipRefSchema.parse({id,hash:hash.repeat(64),name:`${id}.mov`,kind:'video',role,roleSource:'index',
  duration:60,width:1920,height:1080,hasAudio:role==='a-roll'});
// Words 0.4s long, 0.6s apart, so a pause sits between every pair.
const words='one two three four five six seven eight nine ten eleven twelve'.split(' ').map((text,i)=>({id:i,text,start:2+i,end:2.4+i}));
const speaker:JobClip={ref:ref('c1','a-roll','a'),words};
const cutaway:JobClip={ref:ref('c2','b-roll','b'),words:[]};
const job:Job={id:'j',name:'J',clips:[speaker,cutaway],style:{...styleOf(undefined),pace:{...styleOf(undefined).pace,maxPauseSeconds:0.8}}};
const len=(d:ReturnType<typeof buildCut>)=>d.tracks['a-roll'].at(-1)!.end;

describe('pace',()=>{
  test('a fast stretch trims the pauses a normal one keeps, and runs shorter',()=>{
    const normal=buildCut(job,[{clip:'c1',from:0,to:5}]),fast=buildCut(job,[{clip:'c1',from:0,to:5,pace:'fast'}]);
    expect(normal.tracks['a-roll']).toHaveLength(1);
    expect(fast.tracks['a-roll']).toHaveLength(6);
    expect(len(fast)).toBeLessThan(len(normal));
  });
  test('a hold keeps the pause after the line, never into the next word',()=>{
    const out=(hold?:number)=>buildCut(job,[{clip:'c1',from:0,to:2,...(hold?{hold}:{})}]).tracks['a-roll'][0]!.out;
    expect(out()).toBeCloseTo(4.54,1);
    expect(out(0.4)).toBeCloseTo(4.8,1);
    expect(out(2)).toBeLessThan(words[3]!.start);
  });
  test('joins report the gap a viewer hears',()=>{
    const segs=[{clip:'c1',from:0,to:2,hold:0.4},{clip:'c1',from:6,to:8}];
    const c=checkCut(job,buildCut(job,segs),segs);
    // The 0.4s hold, plus the next line's lead; edges round outward to the frame, so a frame or two more.
    expect(c.joins[0]).toMatch(/gap 0\.(4\d|50)s/);
  });
});

describe('structure',()=>{
  test('chapters follow their word and drop with it',()=>{
    const doc=buildCut(job,[{clip:'c1',from:0,to:2},{clip:'c1',from:6,to:8}],
      {chapters:[{clip:'c1',word:0,title:'Intro'},{clip:'c1',word:4,title:'Cut'},{clip:'c1',word:6,title:'Point'}]});
    expect(doc.markers.map(m=>m.title)).toEqual(['Intro','Point']);
    expect(doc.markers[1]!.time).toBeCloseTo(doc.tracks['a-roll'][1]!.start,1);
  });
  test('footage with a lead starts before its word',()=>{
    const at=(lead?:number)=>buildCut(job,[{clip:'c1',from:0,to:11}],
      {broll:[{id:'b',broll:'c2',clip:'c1',word:6,seconds:2,reason:'r',...(lead?{lead}:{})}]}).tracks['b-roll'][0]!.start;
    expect(at()-at(0.4)).toBeCloseTo(0.4,1);
  });
  test('a teaser may replay its words; any other reuse is a problem',()=>{
    const reused=(teaser:boolean)=>{
      const segs=[{clip:'c1',from:6,to:7,...(teaser?{teaser}:{})},{clip:'c1',from:0,to:8}];
      return checkCut(job,buildCut(job,segs),segs).problems.filter(p=>p.includes('used twice'));
    };
    expect(reused(true)).toHaveLength(0);
    expect(reused(false)).toHaveLength(1);
  });
});

describe('visible jumps',()=>{
  const segs=[{clip:'c1',from:0,to:2},{clip:'c1',from:6,to:8}];
  test('a cut where the eyes move is reported; one under footage is not',()=>{
    const moved=(_c:string,t:number)=>({x:t<5?0.4:0.6,y:0.4});
    // Code punches in on a jump cut by default; a cut left wide is the one to report.
    const wide=(d:ReturnType<typeof buildCut>)=>({...d,tracks:{...d.tracks,zoom:[]}});
    expect(visibleJumps(buildCut(job,segs),moved)).toHaveLength(0);
    expect(visibleJumps(wide(buildCut(job,segs)),moved)).toHaveLength(1);
    expect(visibleJumps(wide(buildCut(job,segs)),()=>({x:0.5,y:0.4}))).toHaveLength(0);
    const covered=buildCut(job,segs,{broll:[{id:'b',broll:'c2',clip:'c1',word:2,seconds:3,reason:'r'}]});
    expect(visibleJumps(wide(covered),moved)).toHaveLength(0);
  });
});
