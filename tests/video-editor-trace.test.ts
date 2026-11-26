// Debug traces: the recorder names model calls by prompt id, jobs save one
// trace per run (also when they fail), the cut map explains every removed
// second, and the API lists an edit's traces.
import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {clipIngestSchema,newEditDoc,segmentsFromCuts} from '@voxtale/editdoc';
import {promptText} from '../src/services/prompts';
import {STRUCTURE_PROMPT_ID,STRUCTURE_REPAIR_PROMPT_ID,TAKE_PROMPT_ID,INDEX_PROMPT_ID} from '../src/video/prompts';
import {traceRecorder,type JobTrace} from '../src/video/editor/trace';
import {cutMap} from '../src/video/cut-map';
import {runEditorJob,runVideoPlanJob,type EditorJobContext} from '../src/video/editor/jobs';
import {createLocalEngine,type LocalEngine} from '../src/video/editor/local';

const A='a'.repeat(64);
const texts='so today I want to I want to show you the new app it is fast and it is free'.split(' ');
const words=texts.map((text,i)=>({id:i,text,start:1+i*0.5,end:1.4+i*0.5}));
const transcript={version:1,provider:'assemblyai',providerId:'t',source:'take.mov',sourceHash:A,duration:20,model:'u',words:words.map(w=>({...w,confidence:0.99}))};
const ingest=clipIngestSchema.parse({hash:A,name:'a.mov',kind:'video',duration:20,fps:{num:30,den:1},width:1920,height:1080,hasAudio:true,role:'a-roll',
  segments:segmentsFromCuts(20,[]).map(({id,start,end,stills})=>({id,start,end,stills}))});

describe('trace recorder',()=>{
  test('names model calls by prompt, relabels them by artifact, and drops image bytes',async()=>{
    let t=0;
    const rec=traceRecorder({id:'j1',type:'video-plan'},()=>t+=10);
    const planner=rec.planner(async()=>({plan:{beats:[]},model:'m1',usage:{cost:0.01}}));
    const input={passages:[],repair:promptText(STRUCTURE_REPAIR_PROMPT_ID)};
    const r=await planner(promptText(STRUCTURE_PROMPT_ID),input,{});
    rec.artifact('structure-repair-response',r);
    rec.artifact('passages',[{id:'p1'}]);
    const vision=rec.vision(async()=>({json:{ok:true},model:'v1',costUsd:0.002}));
    await vision(promptText(INDEX_PROMPT_ID),[{type:'text',text:'S001'},{type:'image',jpeg:new Uint8Array(2048)}]);
    await expect(rec.planner(async()=>{throw new Error('402 no credit');})('own system',{}, {})).rejects.toThrow('402');
    const trace=rec.finish(new Error('402 no credit'));
    const [model,artifact,look,failed]=trace.steps;
    expect(model).toMatchObject({kind:'model',name:'structure-repair-response',model:'m1',costUsd:0.01,prompt:{id:STRUCTURE_PROMPT_ID},
      alsoPrompts:[{id:STRUCTURE_REPAIR_PROMPT_ID}],output:{beats:[]}});
    expect(model!.ms).toBeGreaterThan(0);
    expect(artifact).toMatchObject({kind:'artifact',name:'passages'});
    expect(look).toMatchObject({name:INDEX_PROMPT_ID,input:['S001',{image:'2 KB jpeg'}],costUsd:0.002});
    expect(failed).toMatchObject({name:'planner',error:'402 no credit'});
    expect(trace).toMatchObject({status:'failed',error:'402 no credit'});
  });
});

describe('cut map',()=>{
  // Words 4-7 ("I want to I") are a retake the take stage cut; 12-13 left out by the structure stage.
  const base=newEditDoc({id:'e1',name:'x',clips:[]});
  const doc={...base,
    tracks:{...base.tracks,'a-roll':[
      {id:'a1',clipId:'c1',in:0.9,out:3.0,start:0,end:2.1,owner:'agent' as const,status:'applied' as const,gainDb:0},
      {id:'a2',clipId:'c1',in:4.9,out:7.0,start:2.1,end:4.2,owner:'agent' as const,status:'applied' as const,gainDb:0},
      {id:'a3',clipId:'c1',in:8.9,out:10.6,start:4.2,end:5.9,owner:'agent' as const,status:'remove-suggested' as const,reason:'weak',gainDb:0},
    ]},
    brief:{beats:[],coverage:[],dropped:[{clipId:'c1',in:7.0,out:7.9,text:'it is',reason:'aside',kind:'off-topic' as const}]}};
  const takes=new Map([['c1',[
    {startWord:4,endWord:7,kind:'retake',confidence:0.95,reason:'restart',applied:true},
    {startWord:9,endWord:9,kind:'false-start',confidence:0.5,reason:'maybe',applied:false},
  ]]]);
  const map=cutMap(doc as never,[{clipId:'c1',name:'a.mov',duration:12,words,shots:[{start:0},{start:6}]}],takes);
  const clip=map.clips[0]!;

  test('splits source time into kept, unsure and removed parts with reasons',()=>{
    const kinds=clip.segments.map(s=>s.kind);
    expect(kinds[0]).toBe('pause');
    expect(kinds).toContain('kept');
    expect(kinds).toContain('unsure');
    const retake=clip.segments.find(s=>s.kind==='retake')!;
    expect(retake).toMatchObject({reason:'restart',confidence:0.95,text:'to I want to'});
    expect(clip.segments.find(s=>s.kind==='off-topic')?.reason).toBe('aside');
    expect(clip.segments.slice(-2)).toMatchObject([{kind:'cut',text:'free'},{kind:'pause',end:12}]);
    // Segments tile the clip with no overlap.
    for(let i=1;i<clip.segments.length;i++)expect(clip.segments[i]!.start).toBeCloseTo(clip.segments[i-1]!.end,3);
    expect(clip.shots).toEqual([6]);
  });

  test('flags low-confidence words the cut kept, and labels each join',()=>{
    expect(clip.words.find(w=>w.id===9)).toMatchObject({kind:'unsure',reason:'false-start: maybe'});
    expect(clip.words.find(w=>w.id===5)?.kind).toBe('retake');
    expect(map.joins.map(j=>j.at)).toEqual([2.1,4.2]);
    expect(map.joins[0]!.kinds).toContain('retake');
    expect(map.joins[1]!.kinds).toContain('off-topic');
    expect(map.totals.kept).toBeCloseTo(4.2,3);
  });
});

describe('traced jobs',()=>{
  function setup(planner:(s:string,i:any,schema:any)=>Promise<any>) {
    const objects=new Map<string,string|Uint8Array>();
    const prefix=`users/u1/video/clips/${A}/`;
    objects.set(`${prefix}index.json`,JSON.stringify({clipHash:A,promptVersion:'v',model:'m',summary:'',roleGuess:'a-roll',segments:[],missing:[]}));
    objects.set(`${prefix}transcript.json`,JSON.stringify(transcript));
    const docKey='users/u1/video/edits/e1/rev-1.json';
    const c:EditorJobContext={
      port:{planInput:async()=>({edit:{id:'e1',name:'Demo',revision:0},clips:[{hash:A,prefix,ingest,indexKey:`${prefix}index.json`,transcriptKey:`${prefix}transcript.json`}],revision:1,docKey}),
        planReady:async()=>{}} as never,
      storage:{download:async()=>{},upload:async()=>0,put:async(k,b)=>{objects.set(k,b);},
        bytes:async k=>{const v=objects.get(k);if(v===undefined)throw new Error(`no ${k}`);return typeof v==='string'?new TextEncoder().encode(v):v;}},
      progress:async()=>{},trace:true,
    };
    return {objects,c,planner};
  }
  const job={id:'job7',type:'video-plan',owner:'u1',payload:{}};
  const trace=(objects:Map<string,unknown>)=>JSON.parse(objects.get('users/u1/video/edits/e1/trace/job7.json') as string) as JobTrace;

  test('a plan job saves its model calls, artifacts and cut map', async()=>{
    let takeCalls=0;
    const planner=async(_s:string,input:any,schema:any)=>{
      const p=schema.properties??{};
      if(p.removals)return {plan:{removals:takeCalls++===0?[{startWord:4,endWord:7,kind:'retake',keptStartWord:8,keptEndWord:10,confidence:0.95,reason:'restart'}]:[],summary:'s'},model:'m',usage:null};
      if(p.beats)return {plan:{beats:[{id:'all',role:'progress',title:'All',content:'All of it',passages:input.passages.map((x:any)=>x.id)}],dropped:[],summary:'s'},model:'m',usage:null};
      return {plan:{items:[]},model:'m',usage:null};
    };
    const {objects,c}=setup(planner);
    const rec=traceRecorder(job);
    await runVideoPlanJob({edit:()=>c.port.planInput(job as never),ready:async()=>{},storage:c.storage,progress:async()=>{},planner,trace:rec});
    const t=rec.finish();
    expect(rec.key).toBe('users/u1/video/edits/e1/trace/');
    expect(t.subject).toEqual({editId:'e1',revision:1});
    const names=t.steps.filter(s=>s.kind==='model').map(s=>s.name);
    expect(names).toContain('c1-takes-first-response');
    expect(t.steps.find(s=>s.name==='c1-takes-first-response')?.prompt?.id).toBe(TAKE_PROMPT_ID);
    expect(t.steps.some(s=>s.kind==='artifact'&&s.name==='c1-take-removals')).toBe(true);
    expect(t.steps.some(s=>s.kind==='artifact'&&s.name==='input')).toBe(true);
    expect(t.cutMap?.clips[0]?.segments.some(s=>s.kind==='retake')).toBe(true);
    expect(objects.has('users/u1/video/edits/e1/rev-1.json')).toBe(true);
  });

  test('runEditorJob saves the trace of a failed job and still throws',async()=>{
    const {objects,c}=setup(async()=>{throw new Error('boom');});
    // A missing index fails the job after it knows its edit, before any model call.
    objects.delete(`users/u1/video/clips/${A}/index.json`);
    await expect(runEditorJob(job,c)).rejects.toThrow('index.json');
    const t=trace(objects);
    expect(t.status).toBe('failed');
    expect(t.error).toContain('index.json');
    expect(t.job).toEqual({id:'job7',type:'video-plan'});
  });
});

describe('traces API',()=>{
  const dirs:string[]=[];const engines:LocalEngine[]=[];
  afterEach(async()=>{await Promise.all(engines.splice(0).map(e=>e.close()));await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});

  test('lists the traces of an edit and its clips, oldest first',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'vt-trace-'));dirs.push(dir);
    const engine=await createLocalEngine({dir,runJob:(async(job:any,c:EditorJobContext)=>{
      if(job.type==='video-index'){const clip=await c.port.indexInput(job);await c.storage.put(`${clip.prefix}index.json`,'{}','application/json');await c.port.clipIndexed(job,{roleGuess:'a-roll',promptVersion:'t',transcribed:false});}
    }) as never});
    engines.push(engine);
    const clipDir=await mkdtemp(join(tmpdir(),'vt-trace-clip-'));dirs.push(clipDir);
    const files=['audio.flac',...ingest.segments.flatMap(s=>s.stills.map((_,i)=>`stills/${s.id}-${i}.jpg`))];
    await mkdir(join(clipDir,'stills'),{recursive:true});
    for(const f of files)await writeFile(join(clipDir,f),f);
    await engine.sendClip(ingest,clipDir,files);
    for(let i=0;i<200&&(await engine.api.clip(A)).status!=='indexed';i++)await new Promise(r=>setTimeout(r,10));
    const {editId}=await engine.api.createEdit({name:'cut',clipHashes:[A]});
    const put=async(key:string,startedAt:number)=>{await mkdir(dirname(engine.path(key)),{recursive:true});
      await writeFile(engine.path(key),JSON.stringify({version:1,job:{id:key,type:'x'},subject:{},startedAt,status:'done',steps:[]}));};
    await put(`users/local/video/edits/${editId}/trace/p.json`,30);
    await put(`users/local/video/edits/${editId}/graphics/ga-1/trace/g.json`,40);
    await put(`users/local/video/clips/${A}/trace/i.json`,10);
    await writeFile(engine.path(`users/local/video/edits/${editId}/trace/bad.json`),'not json');
    const traces=await engine.api.traces(editId);
    expect(traces.map(t=>t.startedAt)).toEqual([10,30,40]);
    await expect(engine.api.traces('edit_999999')).rejects.toMatchObject({code:'NOT_FOUND'});
  });
});
