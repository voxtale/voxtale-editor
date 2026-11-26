// The agent planner's seams without a model: the loopback MCP endpoint, and
// the plan job driven by a fake harness that calls the tools over HTTP.
import {describe,expect,test} from 'bun:test';
import {clipIngestSchema,clipRefSchema,parseEditDoc,segmentsFromCuts} from '@voxtale/editdoc';

import {serveTools} from '../src/video/editor/agent/mcp-http';
import {planWithAgent,type FrameHost} from '../src/video/editor/agent/plan';
import {defineTool,z,type AgentRunner,type AgentTask} from '../src/video/editor/agent/port';
import {runVideoPlanJob,type VideoStorage} from '../src/video/editor/jobs';
import {traceRecorder} from '../src/video/editor/trace';

async function rpc(task:Pick<AgentTask,'server'>,method:string,params:unknown={},id=1) {
  const r=await fetch(task.server!.url,{method:'POST',headers:{...task.server!.headers,'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  return (await r.json() as any);
}

describe('MCP endpoint',()=>{
  test('lists, validates and calls tools behind its token',async()=>{
    const tool=defineTool({name:'add',description:'Add two numbers',input:{a:z.number(),b:z.number().optional()},
      run:async({a,b})=>({text:String(a+(b??0))})});
    const server=await serveTools([tool]);
    try {
      expect((await fetch(server.url,{method:'POST',body:'{}'})).status).toBe(401);
      const s={server};
      expect((await rpc(s,'initialize',{protocolVersion:'2025-06-18'})).result.capabilities).toEqual({tools:{}});
      const [listed]=(await rpc(s,'tools/list')).result.tools;
      expect(listed).toMatchObject({name:'add',inputSchema:{type:'object',required:['a']}});
      expect((await rpc(s,'tools/call',{name:'add',arguments:{a:2,b:3}})).result).toEqual({content:[{type:'text',text:'5'}]});
      expect((await rpc(s,'tools/call',{name:'add',arguments:{a:'x'}})).result.isError).toBe(true);
      expect((await rpc(s,'tools/call',{name:'nope'})).error.code).toBe(-32602);
      const note=await fetch(server.url,{method:'POST',headers:server.headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
      expect(note.status).toBe(202);
    } finally {await server.close();}
  });
});

const A='a'.repeat(64);
const texts='so today I want to I want to show you the new app it is fast and it is free'.split(' ');
const transcript={version:1,provider:'assemblyai',providerId:'t',source:'take.mov',sourceHash:A,duration:20,model:'u',
  words:texts.map((text,i)=>({id:i,text,start:1+i*0.5,end:1.4+i*0.5,confidence:0.99}))};
const ingest=clipIngestSchema.parse({hash:A,name:'a.mov',kind:'video',duration:20,fps:{num:30,den:1},width:1920,height:1080,hasAudio:true,role:'a-roll',
  segments:segmentsFromCuts(20,[]).map(({id,start,end,stills})=>({id,start,end,stills}))});

function setup() {
  const objects=new Map<string,string|Uint8Array>();
  const storage:VideoStorage={
    download:async()=>{throw new Error('no download');},
    bytes:async key=>{const v=objects.get(key);if(v===undefined)throw new Error(`no ${key}`);return typeof v==='string'?new TextEncoder().encode(v):v;},
    put:async(key,body)=>{objects.set(key,body);},
  };
  const prefix=`users/u1/video/clips/${A}/`;
  objects.set(`${prefix}index.json`,JSON.stringify({clipHash:A,promptVersion:'v',model:'m',summary:'',roleGuess:'a-roll',segments:[],missing:[]}));
  objects.set(`${prefix}transcript.json`,JSON.stringify(transcript));
  const edit=async()=>({edit:{id:'e1',owner:'u1',name:'Demo',revision:0},
    clips:[{hash:A,prefix,ingest,indexKey:`${prefix}index.json`,transcriptKey:`${prefix}transcript.json`}],revision:1,docKey:'users/u1/video/edits/e1/rev-1.json'});
  return {objects,storage,edit};
}

// Drops the repeated "I want to" (words 3-5) and finishes, like a short agent run.
const fakeRunner:AgentRunner={name:'fake',run:async task=>{
  expect(task.tools.map(t=>t.name)).toContain('set_cut');
  const transcriptText=(await rpc(task,'tools/call',{name:'get_transcript',arguments:{}})).result.content[0].text;
  expect(transcriptText).toContain('today');
  task.said?.('Words 3-5 repeat "I want to"; cutting them.');
  await rpc(task,'tools/call',{name:'set_cut',arguments:{segments:[{clip:'c1',from:0,to:2},{clip:'c1',from:6,to:19}]}},2);
  // An unwatched cut is sent back once; the second finish stands.
  const early=await rpc(task,'tools/call',{name:'finish',arguments:{summary:'Cut the false start and kept the rest.'}},3);
  expect(early.result.isError).toBe(true);
  await rpc(task,'tools/call',{name:'finish',arguments:{summary:'Cut the false start and kept the rest.'}},4);
  return {stop:'success',turns:3,costUsd:null,toolCalls:[],finalText:'done'};
}};

describe('video-plan job with an agent',()=>{
  test('the agent cuts through the tools; the job stores its doc as an agent revision',async()=>{
    const {objects,storage,edit}=setup();
    let got:{notes:string[];stage:string;graphics:unknown[]}|undefined;
    const out=await runVideoPlanJob({edit,storage,progress:async()=>{},
      ready:async(_r,notes,graphics,stage)=>{got={notes,stage,graphics};},
      agent:{runner:fakeRunner,sources:async hashes=>Object.fromEntries(hashes.map(h=>[h,'/footage/a.mov']))}});
    expect(got).toMatchObject({stage:'agent',graphics:[]});
    expect(out.notes[0]).toBe('Cut the false start and kept the rest.');
    const doc=parseEditDoc(JSON.parse(objects.get(out.docKey) as string)).doc;
    expect(doc.revision).toBe(1);
    expect(doc.tracks['a-roll'].length).toBe(2);
  });

  test('the trace keeps one step per call, with the agent\'s words and the cut each call left',async()=>{
    const {storage,edit}=setup();
    const trace=traceRecorder({id:'j1',type:'video-plan'});
    await runVideoPlanJob({edit,storage,trace,progress:async()=>{},ready:async()=>{},
      agent:{runner:fakeRunner,sources:async hashes=>Object.fromEntries(hashes.map(h=>[h,'/footage/a.mov']))}});
    const run=trace.finish().agent!;
    expect(run).toMatchObject({runner:'fake',stop:'success',clips:[{id:'c1',role:'a-roll'}]});
    expect(run.steps.map(s=>s.tool)).toEqual(['get_transcript','set_cut','finish','finish']);
    const [read,cut,,done]=run.steps;
    expect(read!.cut).toBeUndefined();
    expect(cut!.said).toContain('repeat');
    expect(cut!.cut!.aroll.map(a=>a.text)).toEqual(['so today I','want to show you the new app it is fast and it is free']);
    // finish changes nothing on the timeline, so it carries no cut.
    expect(done!.cut).toBeUndefined();
  });

  test('falls back to the story stages when a clip file is not on this computer',async()=>{
    const {storage,edit}=setup();
    const planner=async(_s:string,input:any,schema:any)=>{
      const p=schema.properties??{};
      if(p.removals)return {plan:{removals:[],summary:'s'},model:'m',usage:null};
      if(p.beats)return {plan:{beats:[{id:'all',role:'progress',title:'All',content:'All',passages:input.passages.map((x:any)=>x.id)}],dropped:[],summary:'s'},model:'m',usage:null};
      return {plan:{items:[]},model:'m',usage:null};
    };
    let stage='';let notes:string[]=[];
    await runVideoPlanJob({edit,storage,progress:async()=>{},planner,
      ready:async(_r,n,_g,s)=>{stage=s;notes=n;},
      agent:{runner:{name:'never',run:async()=>{throw new Error('should not run');}},sources:async hashes=>Object.fromEntries(hashes.map(h=>[h,null]))}});
    expect(stage).toBe('story');
    expect(notes[0]).toContain('not on this computer');
  });

  test('a cloud run checks the creator\'s desktop has every clip before the agent starts, else plans with the story stages',async()=>{
    const {storage,edit}=setup();
    const planner=async(_s:string,input:any,schema:any)=>{
      const p=schema.properties??{};
      if(p.removals)return {plan:{removals:[],summary:'s'},model:'m',usage:null};
      if(p.beats)return {plan:{beats:[{id:'all',role:'progress',title:'All',content:'All',passages:input.passages.map((x:any)=>x.id)}],dropped:[],summary:'s'},model:'m',usage:null};
      return {plan:{items:[]},model:'m',usage:null};
    };
    const asked:unknown[]=[];
    const host=(fail:boolean):FrameHost=>({
      filmstrip:async()=>new Uint8Array(),frames:async()=>[],graphic:async()=>({ok:false,report:''}),
      joins:async pairs=>{asked.push(pairs);if(fail)throw new Error('VoxTale is not open on the creator\'s computer');return new Uint8Array();},
    });
    let stage='';let notes:string[]=[];
    await runVideoPlanJob({edit,storage,progress:async()=>{},planner,
      ready:async(_r,n,_g,s)=>{stage=s;notes=n;},
      agent:{runner:{name:'never',run:async()=>{throw new Error('should not run');}},frames:()=>host(true)}});
    expect(stage).toBe('story');
    expect(notes[0]).toContain('VoxTale was not open');
    // One frame of each clip, by hash.
    expect(asked[0]).toEqual([{a:{clip:'a'.repeat(64),t:0},b:{clip:'a'.repeat(64),t:0}}]);

    const out=await runVideoPlanJob({edit,storage,progress:async()=>{},ready:async(_r,_n,_g,s)=>{stage=s;},
      agent:{runner:fakeRunner,frames:()=>host(false)}});
    expect(stage).toBe('agent');
    expect(out.notes[0]).toBe('Cut the false start and kept the rest.');
  });
});

describe('frame tools',()=>{
  test('ask the frame host by clip hash, with the exact join times, and never need a local file',async()=>{
    const asked:unknown[]=[];
    const frames:FrameHost={
      filmstrip:async(clip,start,end)=>{asked.push({strip:{clip,start,end}});return new Uint8Array([1]);},
      joins:async pairs=>{asked.push({joins:pairs});return new Uint8Array([2]);},
      frames:async(_clip,times)=>times.map(()=>null),
      graphic:async()=>({ok:false,report:'no'}),
    };
    const ref=clipRefSchema.parse({id:'c1',hash:A,name:'a.mov',kind:'video',role:'a-roll',roleSource:'creator',duration:20,width:1920,height:1080,hasAudio:true});
    const runner:AgentRunner={name:'looks',run:async task=>{
      await rpc(task,'tools/call',{name:'timeline_view',arguments:{clip:'c1',start:2,end:30}});
      await rpc(task,'tools/call',{name:'set_cut',arguments:{segments:[{clip:'c1',from:0,to:2},{clip:'c1',from:6,to:19}]}},2);
      const joins=await rpc(task,'tools/call',{name:'view_joins',arguments:{}},3);
      expect(joins.result.content.some((c:any)=>c.type==='image')).toBe(true);
      await rpc(task,'tools/call',{name:'finish',arguments:{summary:'ok'}},4);
      await rpc(task,'tools/call',{name:'finish',arguments:{summary:'ok'}},5);
      return {stop:'success',turns:4,costUsd:null,toolCalls:[],finalText:'done'};
    }};
    const workspace=`${process.env.TMPDIR??'/tmp'}/frames-test-${Date.now()}`;
    await planWithAgent({id:'e1',name:'Demo',revision:1,clips:[{ref,transcript:transcript as any}],frames,graphics:false,runner,workspace,eyes:false});
    expect(asked[0]).toEqual({strip:{clip:A,start:2,end:20}});
    const pair=(asked[1] as {joins:{a:{clip:string;t:number};b:{clip:string;t:number}}[]}).joins;
    expect(pair).toHaveLength(1);
    expect(pair[0]!.a.clip).toBe(A);
    expect(pair[0]!.b.clip).toBe(A);
    expect(pair[0]!.b.t).toBeGreaterThan(pair[0]!.a.t);
  });

  test('music on another computer: its beat is found from sound the frame host sends',async()=>{
    const M='b'.repeat(64),rate=8000,bpm=120,first=0.25,asked:unknown[]=[];
    const pulse=new Float32Array(rate*40);
    for(let i=0;i<pulse.length;i++){const t=i/rate,since=((t-first)%0.5+0.5)%0.5;pulse[i]=0.8*Math.sin(2*Math.PI*90*t)*Math.exp(-30*since)+0.02*Math.sin(2*Math.PI*440*t);}
    const frames:FrameHost={
      filmstrip:async()=>new Uint8Array(),joins:async()=>new Uint8Array(),frames:async(_c,times)=>times.map(()=>null),
      graphic:async()=>({ok:false,report:'no'}),
      audio:async(clip,start,end)=>{asked.push({clip,start,end});return clip===M?new Uint8Array(pulse.buffer):new Uint8Array();},
    };
    const ref=clipRefSchema.parse({id:'c1',hash:A,name:'a.mov',kind:'video',role:'a-roll',roleSource:'creator',duration:20,width:1920,height:1080,hasAudio:true});
    const music=clipRefSchema.parse({id:'c2',hash:M,name:'m.mp3',kind:'audio',role:'music',roleSource:'creator',duration:40,hasAudio:true});
    const runner:AgentRunner={name:'beats',run:async task=>{
      await rpc(task,'tools/call',{name:'set_cut',arguments:{segments:[{clip:'c1',from:0,to:19}]}});
      await rpc(task,'tools/call',{name:'finish',arguments:{summary:'ok'}},2);
      await rpc(task,'tools/call',{name:'finish',arguments:{summary:'ok'}},3);
      return {stop:'success',turns:3,costUsd:null,toolCalls:[],finalText:'done'};
    }};
    const workspace=`${process.env.TMPDIR??'/tmp'}/beats-test-${Date.now()}`;
    const out=await planWithAgent({id:'e1',name:'Demo',revision:1,clips:[{ref,transcript:transcript as any},{ref:music}],frames,graphics:false,runner,workspace,eyes:false});
    expect(asked[0]).toEqual({clip:M,start:0,end:40});
    const beats=out.doc.clips.find(c=>c.id==='c2')!.beats!;
    expect(Math.abs(beats.bpm-bpm)).toBeLessThan(0.5);
  });

  test('a designed graphic covers the frame; place_graphic takes no placement',async()=>{
    const frames:FrameHost={
      filmstrip:async()=>new Uint8Array(),joins:async()=>new Uint8Array(),frames:async(_c,times)=>times.map(()=>null),
      graphic:async()=>({ok:true,report:'ok',webm:'g.webm'}),
    };
    const ref=clipRefSchema.parse({id:'c1',hash:A,name:'a.mov',kind:'video',role:'a-roll',roleSource:'creator',duration:20,width:1920,height:1080,hasAudio:true});
    let listed:any;
    const runner:AgentRunner={name:'graphic',run:async task=>{
      listed=(await rpc(task,'tools/list')).result.tools.find((t:any)=>t.name==='place_graphic');
      await rpc(task,'tools/call',{name:'set_cut',arguments:{segments:[{clip:'c1',from:0,to:19}]}});
      const html='<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="4"></div>';
      const made=await rpc(task,'tools/call',{name:'render_graphic',arguments:{id:'two-points',html,seconds:4,anchor:{clip:'c1',word:8},stills:[1]}},2);
      expect(made.result.isError).toBeFalsy();
      const placed=await rpc(task,'tools/call',{name:'place_graphic',arguments:{id:'two-points',clip:'c1',word:8,seconds:4,reason:'two claims'}},3);
      expect(placed.result.content[0].text).toContain('placed two-points');
      await rpc(task,'tools/call',{name:'finish',arguments:{summary:'ok'}},4);
      await rpc(task,'tools/call',{name:'finish',arguments:{summary:'ok'}},5);
      return {stop:'success',turns:4,costUsd:null,toolCalls:[],finalText:'done'};
    }};
    const workspace=`${process.env.TMPDIR??'/tmp'}/graphic-test-${Date.now()}`;
    const out=await planWithAgent({id:'e1',name:'Demo',revision:1,clips:[{ref,transcript:transcript as any}],frames,graphics:true,runner,workspace,eyes:false});
    expect(Object.keys(listed.inputSchema.properties)).not.toContain('placement');
    expect(out.doc.tracks.graphics.map(g=>g.placement)).toEqual(['full']);
  });
});
