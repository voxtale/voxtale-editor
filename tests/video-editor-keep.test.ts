// The creator's own edits survive agent tool calls: items they own or changed
// by hand stay, locked tracks stay untouched, and only an agent call that
// names a creator item changes it (keeping the fields they set by hand).
import {afterAll,describe,expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipRefSchema,handEdits,keepCreatorItems,retime,type ClipRef,type EditDoc} from '@voxtale/editdoc';

import {styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import type {FrameHost} from '../src/video/editor/agent/frames';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';
import type {Workspace} from '../src/video/editor/agent/tools';

const ref=(id:string,role:ClipRef['role'],hash:string,over:Partial<ClipRef>={})=>clipRefSchema.parse({id,hash:hash.repeat(64),name:`${id}.mp4`,
  kind:role==='music'?'audio':'video',role,roleSource:'creator',duration:role==='music'?120:40,fps:{num:30,den:1},
  ...(role==='music'?{}:{width:1920,height:1080}),hasAudio:true,timecodeStart:0,...over});
// 60 words, one every half second: word i says at 1+0.5i.
const words=Array.from({length:60},(_,i)=>({id:i,text:i%10===9?`w${i}.`:`w${i}`,start:1+i*0.5,end:1.4+i*0.5}));
const job=():Job=>({id:'j',name:'Keep',clips:[{ref:ref('c1','a-roll','a'),words},{ref:ref('c2','b-roll','b',{hasAudio:false,duration:30}),words:[]},{ref:ref('c3','music','d'),words:[]}] as JobClip[],style:styleOf(undefined)});
const host:FrameHost={filmstrip:async()=>new Uint8Array(),frames:async()=>[],joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''})};

const dirs:string[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});

async function start() {
  const dir=await mkdtemp(join(tmpdir(),'keep-'));dirs.push(dir);
  const ws=newWorkspace({dir,job:job(),frames:host,graphics:false});
  const tools=jobTools(ws);
  const call=async(name:string,args:unknown)=>{
    const r=await tools.find(t=>t.name===name)!.run(args as never);
    if(r.isError)throw new Error(r.text);
    return r.text;
  };
  // One segment a sentence, as a real cut has: zooms and trims work per segment.
  await call('set_cut',{segments:Array.from({length:6},(_,k)=>({clip:'c1',from:k*10,to:k*10+9}))});
  return {ws,call};
}

/** The creator makes `id` on `kind` theirs (as the app does on any hand change). */
function claim(ws:Workspace,kind:keyof EditDoc['tracks'],id:string,over:Record<string,unknown>={}) {
  const doc=ws.doc!;
  const items=doc.tracks[kind] as {id:string;owner:string}[];
  const i=items.findIndex(x=>x.id===id);
  expect(i).toBeGreaterThanOrEqual(0);
  items[i]={...items[i]!,...over,owner:'creator'};
  return items[i]!;
}
const ids=(ws:Workspace,kind:keyof EditDoc['tracks'])=>(ws.doc!.tracks[kind] as {id:string}[]).map(x=>x.id);

describe('creator items survive agent calls on other ranges',()=>{
  test('zoom: a hand zoom stays when the agent sets zooms elsewhere',async()=>{
    const {ws,call}=await start();
    await call('set_zooms',{spans:[{clip:'c1',from:20,to:26,why:'thesis'}]});
    const z=ws.doc!.tracks.zoom.find(x=>/key line/.test(x.reason??''))!;
    const mine=claim(ws,'zoom',z.id,{scale:1.3,id:'hand-zoom'});
    const text=await call('set_zooms',{spans:[{clip:'c1',from:45,to:50,why:'number'}]});
    const kept=ws.doc!.tracks.zoom.find(x=>x.id==='hand-zoom')!;
    expect(kept).toMatchObject({scale:1.3,owner:'creator',start:(mine as any).start,end:(mine as any).end});
    expect(ws.doc!.tracks.zoom.some(x=>x.owner==='agent'&&x.start>=23)).toBe(true);
    expect(text).toContain('kept the creator');
  });
  test('captions: hand-edited lines stay when the agent recaptions elsewhere',async()=>{
    const {ws,call}=await start();
    await call('set_captions',{spans:[{clip:'c1',from:0,to:5}]});
    const first=ws.doc!.tracks.captions[0]!;
    claim(ws,'captions',first.id,{text:'My own words'});
    await call('set_captions',{spans:[{clip:'c1',from:40,to:45}]});
    const caps=ws.doc!.tracks.captions;
    expect(caps.find(c=>c.id===first.id)).toMatchObject({text:'My own words',owner:'creator'});
    expect(caps.some(c=>c.owner==='agent'&&c.start>15)).toBe(true);
  });
  test('text: a hand-styled card stays when the agent places another',async()=>{
    const {ws,call}=await start();
    await call('place_text',{id:'tt',template:'callout',text:'Fast',clip:'c1',word:4,seconds:2,reason:'r'});
    claim(ws,'text','t-tt',{look:{color:'#FFD400'},position:'top'});
    await call('place_text',{id:'tt2',template:'title',text:'Free',clip:'c1',word:40,seconds:2,reason:'r'});
    expect(ws.doc!.tracks.text.find(x=>x.id==='t-tt')).toMatchObject({look:{color:'#FFD400'},position:'top',owner:'creator'});
    expect(ids(ws,'text')).toContain('t-tt2');
  });
  test('b-roll: a hand-trimmed shot stays when the agent shows other footage',async()=>{
    const {ws,call}=await start();
    ws.viewed=new Set(['c2']);// looked at already (look-first gate)
    await call('show_footage',{id:'bb',footage:'c2',clip:'c1',word:10,seconds:3,in:2,reason:'r'});
    const b=ws.doc!.tracks['b-roll'][0]!;
    claim(ws,'b-roll',b.id,{end:b.end-1/3*1,out:b.out-1/3});
    await call('show_footage',{id:'bb2',footage:'c2',clip:'c1',word:40,seconds:3,in:10,reason:'r'});
    expect(ws.doc!.tracks['b-roll'].find(x=>x.id===b.id)).toMatchObject({owner:'creator',end:b.end-1/3});
    expect(ids(ws,'b-roll').some(i=>i.startsWith('b-bb2'))).toBe(true);
  });
  test('music: a hand-set bed stays; agent music that would play over it is left out',async()=>{
    const {ws,call}=await start();
    const m=ws.doc!.tracks.music[0]!;
    expect(m).toBeDefined();
    claim(ws,'music',m.id,{gainDb:-30});
    const text=await call('set_music',{from:{clip:'c1',word:20}});
    const music=ws.doc!.tracks.music;
    expect(music.find(x=>x.id===m.id)).toMatchObject({gainDb:-30,owner:'creator'});
    expect(music.filter(x=>x.owner==='agent')).toHaveLength(0);
    expect(text).toContain(`kept the creator's own items as they are: ${m.id}`);
  });
});

describe('locks, names, recuts',()=>{
  test('a locked track stays exactly as it was; a locked cut refuses set_cut',async()=>{
    const {ws,call}=await start();
    await call('set_zooms',{spans:[{clip:'c1',from:20,to:26,why:'t'}]});
    const before=structuredClone(ws.doc!.tracks.zoom);
    ws.doc!.policy.zoom='locked';
    const text=await call('set_zooms',{spans:[]});
    expect(ws.doc!.tracks.zoom).toEqual(before);
    expect(text).toContain('locked by the creator');
    ws.doc!.policy['a-roll']='locked';
    await expect(call('set_cut',{segments:[{clip:'c1',from:0,to:30}]})).rejects.toThrow(/locked the cut/);
  });
  test('an agent zoom over a creator zoom is left out',async()=>{
    const {ws,call}=await start();
    await call('set_zooms',{spans:[{clip:'c1',from:20,to:26,why:'t'}]});
    const z=ws.doc!.tracks.zoom.find(x=>/key line/.test(x.reason??''))!;
    claim(ws,'zoom',z.id,{id:'hand-z'});
    const text=await call('set_zooms',{spans:[{clip:'c1',from:20,to:26,why:'t'}]});
    expect(ws.doc!.tracks.zoom.filter(x=>x.owner==='agent'&&x.start<(z.end)&&x.end>z.start)).toHaveLength(0);
    expect(text).toContain('overlaps creator item hand-z');
  });
  test('an agent zoom that only grazes a creator zoom is cut short, not dropped',async()=>{
    const {ws,call}=await start();
    await call('set_zooms',{spans:[{clip:'c1',from:20,to:26,why:'t'}]});
    const z=ws.doc!.tracks.zoom.find(x=>/key line/.test(x.reason??''))!;
    // The creator drags its end half a second into the next sentence (S4's hand edit).
    const mine=claim(ws,'zoom',z.id,{id:'hand-z',end:z.end+0.5,scale:1.3}) as unknown as {end:number};
    const text=await call('set_zooms',{spans:[{clip:'c1',from:20,to:26,why:'t'},{clip:'c1',from:30,to:36,why:'next'}]});
    const zooms=ws.doc!.tracks.zoom;
    expect(zooms.find(x=>x.id==='hand-z')).toMatchObject({scale:1.3,end:mine.end});
    const next=zooms.find(x=>x.owner==='agent'&&/next/.test(x.reason??''))!;
    expect(next).toBeDefined();
    expect(next.start).toBeCloseTo(mine.end,6);
    expect(next.easeIn).toBeLessThanOrEqual(next.end-next.start);
    expect(text).toMatch(/cut to [\d.]+-[\d.]+s: creator item hand-z holds the rest/);
  });
  test('naming a creator item by id changes it, but the hand-set fields stay theirs',async()=>{
    const {ws,call}=await start();
    await call('place_text',{id:'tt',template:'lowerThird',text:'Old',clip:'c1',word:4,seconds:2,reason:'r'});
    claim(ws,'text','t-tt',{look:{color:'#FFD400',fontFamily:'Georgia'},position:'top'});
    ws.hand={'t-tt':['look','position']};
    const text=await call('place_text',{id:'tt',template:'lowerThird',text:'New',clip:'c1',word:30,seconds:2,reason:'r'});
    const t=ws.doc!.tracks.text.find(x=>x.id==='t-tt')!;
    expect(t).toMatchObject({text:'New',look:{color:'#FFD400',fontFamily:'Georgia'},position:'top',owner:'creator'});
    expect(t.start).toBeGreaterThan(10);
    expect(text).toContain('kept their hand-set look, position');
  });
  test('remove_item by id takes a creator item off; agent items go through their own tool',async()=>{
    const {ws,call}=await start();
    await call('set_zooms',{spans:[{clip:'c1',from:20,to:26,why:'t'},{clip:'c1',from:40,to:46,why:'t'}]});
    const [a,b]=ws.doc!.tracks.zoom.filter(x=>/key line/.test(x.reason??''));
    claim(ws,'zoom',a!.id,{id:'hand-z'});
    await call('remove_item',{kind:'item',id:'hand-z'});
    expect(ids(ws,'zoom')).not.toContain('hand-z');
    await expect(call('remove_item',{kind:'item',id:b!.id})).rejects.toThrow(/is yours/);
  });
  test('a recut moves creator items with their words, and drops those whose words went',async()=>{
    const {ws,call}=await start();
    await call('place_text',{id:'tt',template:'callout',text:'Kept',clip:'c1',word:30,seconds:2,reason:'r'});
    await call('place_text',{id:'gone',template:'callout',text:'Cut',clip:'c1',word:5,seconds:2,reason:'r'});
    const was=claim(ws,'text','t-tt') as unknown as {start:number;end:number};
    claim(ws,'text','t-gone');
    const text=await call('set_cut',{segments:Array.from({length:5},(_,k)=>({clip:'c1',from:k*10+10,to:k*10+19}))});
    const t=ws.doc!.tracks.text.find(x=>x.id==='t-tt')!;
    // Words 0-9 (5 s of speech) left the cut: the card moves up by about that.
    expect(was.start-t.start).toBeGreaterThan(4);
    expect(was.start-t.start).toBeLessThan(6.5);
    expect(ids(ws,'text')).not.toContain('t-gone');
    expect(text).toContain('t-gone (its words were cut)');
  });
});

describe('hand edits on disk',()=>{
  test('changed and new items become the creator\'s; deleted agent items are declined',async()=>{
    const {ws,call}=await start();
    await call('place_text',{id:'tt',template:'callout',text:'Fast',clip:'c1',word:4,seconds:2,reason:'r'});
    await call('place_text',{id:'t2',template:'callout',text:'Free',clip:'c1',word:30,seconds:2,reason:'r'});
    const written=structuredClone(ws.doc!);
    const disk=structuredClone(written);
    disk.tracks.text=disk.tracks.text.filter(x=>x.id!=='t-t2').map(x=>x.id==='t-tt'?{...x,look:{color:'#FFD400'}}:x);
    disk.markers.push({id:'hand-ch',time:2,kind:'chapter',title:'Intro',owner:'agent',status:'applied'});
    const h=handEdits(written,disk);
    expect(h.hand['t-tt']).toEqual(['look']);
    expect(h.hand['hand-ch']).toEqual(['*']);
    expect(h.doc.tracks.text.find(x=>x.id==='t-tt')!.owner).toBe('creator');
    expect(h.doc.markers.find(x=>x.id==='hand-ch')!.owner).toBe('creator');
    expect(h.deleted).toEqual(['t-t2']);
    // The agent's rebuild over it: t2 stays deleted, tt keeps its colour.
    const {doc,report}=keepCreatorItems(h.doc,written);
    expect(doc.tracks.text.map(x=>x.id)).toEqual(['t-tt']);
    expect(doc.tracks.text[0]!.look).toEqual({color:'#FFD400'});
    expect(report.dropped).toEqual([{id:'t-t2',why:'the creator deleted it'}]);
  });
  test('hand trims to the cut stay when the call does not recut',async()=>{
    const {ws,call}=await start();
    const a=ws.doc!.tracks['a-roll'][0]!;
    claim(ws,'a-roll',a.id,{out:a.out-1,end:a.end-1});
    await call('set_zooms',{spans:[{clip:'c1',from:20,to:26,why:'t'}]});
    expect(ws.doc!.tracks['a-roll'][0]).toMatchObject({owner:'creator',end:a.end-1});
  });
});

describe('retime',()=>{
  test('maps an output second to the same source moment in another cut',()=>{
    const it=(id:string,s:number,e:number,i:number)=>({id,clipId:'c1',start:s,end:e,in:i,out:i+e-s,owner:'agent' as const,status:'applied' as const,gainDb:0});
    const from=[it('a',0,10,0)],to=[it('b',0,4,6)];
    expect(retime(7,from,to)).toBeCloseTo(1);
    expect(retime(2,from,to)).toBeUndefined();
  });
});
