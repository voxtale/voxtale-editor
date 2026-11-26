// A clip placed whole as its own segment of the cut, speech or not: set_cut's
// shot form, through the EditDoc, the render plan and both exports.
import {afterAll,describe,expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipRefSchema,parseEditDoc,toFcpxml,toOtio,type ClipRef} from '@voxtale/editdoc';

import {buildCut,checkCut,isShotItem,styleOf,type Job,type JobClip,type Segment} from '../src/video/editor/agent/cut';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';
import type {FrameHost} from '../src/video/editor/agent/frames';
import {planRender} from '../src/video/render-edit';

const ref=(id:string,role:ClipRef['role'],hash:string,over:Partial<ClipRef>={})=>clipRefSchema.parse({id,hash:hash.repeat(64),name:`${id}.mp4`,
  kind:role==='music'?'audio':'video',role,roleSource:'creator',duration:role==='music'?60:20,fps:{num:30,den:1},
  ...(role==='music'?{}:{width:1920,height:1080}),hasAudio:true,timecodeStart:0,...over});
const words='so here is the thing and that is the end of it'.split(' ').map((text,i)=>({id:i,text,start:1+i*0.5,end:1.4+i*0.5}));
const speaker:JobClip={ref:ref('c1','a-roll','a'),words};
const silent:JobClip={ref:ref('c2','b-roll','b',{hasAudio:false,duration:8}),words:[]};
const ambient:JobClip={ref:ref('c3','b-roll','c',{duration:6}),words:[]};
const bed:JobClip={ref:ref('c4','music','d'),words:[]};
const job:Job={id:'j',name:'Shots',clips:[speaker,silent,ambient,bed],style:styleOf(undefined)};
const segs:Segment[]=[{clip:'c1',from:0,to:4},{clip:'c2',in:1,out:4},{clip:'c3',audio:'mute'},{clip:'c1',from:5,to:11}];
const media=Object.fromEntries(job.clips.map(c=>[c.ref.hash,`/media/${c.ref.id}.mp4`]));
const doc=buildCut(job,segs);
const aroll=doc.tracks['a-roll'];
const shots=aroll.filter(isShotItem);

describe('shot segments in the cut',()=>{
  test('a silent clip and a muted ambient clip sit between spoken segments, in order',()=>{
    expect(aroll.map(i=>i.clipId)).toEqual(['c1','c2','c3','c1']);
    expect(shots.map(i=>[i.clipId,i.in,i.out])).toEqual([['c2',1,4],['c3',0,6]]);
    // No sound of its own, or muted: the floor.
    expect(shots.map(i=>i.gainDb)).toEqual([-60,-60]);
    expect(buildCut(job,[{clip:'c3'}]).tracks['a-roll'][0]!.gainDb).toBe(0);
    // Back to back with no gaps.
    for(let k=1;k<aroll.length;k++)expect(aroll[k]!.start).toBeCloseTo(aroll[k-1]!.end,3);
  });
  test('no captions, zooms or eyes over a shot',()=>{
    const cap=buildCut(job,segs,{captions:[{clip:'c1',from:0,to:11}]});
    const over=(i:{start:number;end:number})=>shots.some(s=>s.start<i.end-1e-6&&s.end>i.start+1e-6);
    expect(cap.tracks.captions.length).toBeGreaterThan(0);
    expect(cap.tracks.captions.filter(over)).toHaveLength(0);
    expect(doc.tracks.zoom.filter(over)).toHaveLength(0);
  });
  test('footage-only edits work: no speaker needed',()=>{
    const quiet:Job={...job,clips:[silent,ambient]};
    const d=buildCut(quiet,[{clip:'c3',in:0,out:2},{clip:'c2'}]);
    expect(d.tracks['a-roll'].map(i=>i.clipId)).toEqual(['c3','c2']);
    expect(d.canvas).toEqual({width:1920,height:1080});
  });
  test('bad ranges are refused; overlapping ranges and the joins are reported',()=>{
    expect(()=>buildCut(job,[{clip:'c4'}])).toThrow(/only video/);
    expect(()=>buildCut(job,[{clip:'c2',in:9}])).toThrow(/past its end/);
    expect(()=>buildCut(job,[{clip:'c2',in:1,out:1.2}])).toThrow(/shorter/);
    const twice:Segment[]=[{clip:'c2',in:0,out:3},{clip:'c2',in:2,out:5}];
    expect(checkCut(job,buildCut(job,twice),twice).problems.some(p=>p.includes('both play c2'))).toBe(true);
    const c=checkCut(job,doc,segs);
    expect(c.joins).toHaveLength(3);
    expect(c.joins[0]).toContain('[shot c2');
    expect(c.joins[1]).toContain('muted');
    expect(c.metrics.shots).toBe(2);
  });
});

describe('through the EditDoc, render and export',()=>{
  test('the doc round-trips through the schema',()=>{
    const back=parseEditDoc(JSON.parse(JSON.stringify(doc))).doc;
    expect(back.tracks['a-roll'].filter(isShotItem)).toEqual(shots);
  });
  test('the render plan draws every shot and plays no sound for a muted or silent one',()=>{
    const p=planRender(doc,media);
    for(const s of shots)expect(p.pictures.some(x=>x.itemId===s.id)).toBe(true);
    const sounds=p.sounds.map(s=>s.path);
    expect(sounds.filter(x=>x==='/media/c1.mp4').length).toBeGreaterThanOrEqual(2);
    expect(sounds).not.toContain('/media/c2.mp4');
    expect(sounds).not.toContain('/media/c3.mp4');
    // Kept sound plays.
    expect(planRender(buildCut(job,[{clip:'c1',from:0,to:4},{clip:'c3'}]),media).sounds.map(s=>s.path)).toContain('/media/c3.mp4');
  });
  test('FCPXML puts the shots on the spine; OTIO leaves muted ones off the audio',()=>{
    const clipPath=(c:ClipRef)=>`/media/${c.name}`;
    const xml=toFcpxml(doc,{clipPath});
    const spine=xml.slice(xml.indexOf('<spine>'),xml.indexOf('</spine>'));
    const order=[...spine.matchAll(/<asset-clip [^>]*name="([^"]+)"/g)].map(m=>m[1]);
    expect(order.filter(n=>aroll.some(i=>i.id===n))).toEqual(aroll.map(i=>i.id));
    const otio=toOtio(doc,{clipPath}) as any;
    const tracks=otio.tracks.children as any[];
    const names=(t:string)=>tracks.find(x=>x.name===t).children.filter((c:any)=>c.OTIO_SCHEMA==='Clip.2'||c.OTIO_SCHEMA?.startsWith('Clip')).map((c:any)=>c.name);
    expect(names('A-roll')).toEqual(aroll.map(i=>i.id));
    expect(names('A-roll audio')).toEqual(aroll.filter(i=>!isShotItem(i)).map(i=>i.id));
  });
});

describe('set_cut tool',()=>{
  const dirs:string[]=[];
  afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});
  const host:FrameHost={filmstrip:async()=>new Uint8Array(),frames:async()=>[],joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''})};
  test('takes word and shot segments mixed, and reports the shots',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'shots-'));dirs.push(dir);
    const ws=newWorkspace({dir,job,frames:host,graphics:false});
    ws.viewed=new Set(job.clips.map(c=>c.ref.id));ws.looked=new Set(ws.viewed);// looked at already, close too (look-first gates)
    const tool=jobTools(ws).find(t=>t.name==='set_cut')!;
    const out=await tool.run({segments:segs});
    expect(ws.doc!.tracks['a-roll'].filter(isShotItem).map(i=>[i.clipId,i.gainDb])).toEqual([['c2',-60],['c3',-60]]);
    expect(out.text).toContain('[shot c2');
  });
});
