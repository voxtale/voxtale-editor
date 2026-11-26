// Video editor jobs against fake storage and models: what the index job
// writes, how the plan job picks its a-roll, and what reaches the rows.
import {describe,expect,test} from 'bun:test';
import {STYLE_PRESETS,applyCreatorPatch,clipIngestSchema,editDocSchema,newEditDoc,parseEditDoc,segmentsFromCuts} from '@voxtale/editdoc';
import {runVideoGraphicJob,runVideoIndexJob,runVideoPlanJob,runVideoRenderJob,type VideoStorage} from '../src/video/editor/jobs';
import type {VisionModel} from '../src/video';

const A='a'.repeat(64),B='b'.repeat(64);
const texts='so today I want to I want to show you the new app it is fast and it is free'.split(' ');
const transcript=(hash:string)=>({version:1,provider:'assemblyai',providerId:'t',source:'take.mov',sourceHash:hash,duration:20,model:'u',
  words:texts.map((text,i)=>({id:i,text,start:1+i*0.5,end:1.4+i*0.5,confidence:0.99}))});
const ingest=(hash:string,duration:number,hasAudio=true,role?:'a-roll'|'b-roll')=>clipIngestSchema.parse({hash,name:`${hash[0]}.mov`,kind:'video',duration,
  fps:{num:30,den:1},width:1920,height:1080,hasAudio,...(role?{role}:{}),segments:segmentsFromCuts(duration,[]).map(({id,start,end,stills})=>({id,start,end,stills}))});

function memory() {
  const objects=new Map<string,string|Uint8Array>();
  const storage:VideoStorage={
    download:async(key,path)=>{if(!objects.has(key))throw new Error(`no ${key}`);await Bun.write(path,objects.get(key)!);},
    bytes:async key=>{const v=objects.get(key);if(v===undefined)throw new Error(`no ${key}`);return typeof v==='string'?new TextEncoder().encode(v):v;},
    put:async(key,body)=>{objects.set(key,body);},
  };
  return {objects,storage};
}
const vision:VisionModel=async(_s,parts)=>({model:'m',costUsd:0.002,json:{summary:'Talk',roleGuess:'a-roll',
  segments:parts.filter(p=>p.type==='text').map(p=>({id:(p as {text:string}).text.split(' ')[0],description:'person talks',shotType:'talking-head',usable:true}))}});

describe('video-index job',()=>{
  test('transcribes, labels, stores both and reports the role',async()=>{
    const {objects,storage}=memory();
    const prefix=`users/u1/video/clips/${A}/`;
    objects.set(`${prefix}audio.flac`,'FLAC');
    for(const s of ingest(A,20).segments)s.stills.forEach((_,i)=>objects.set(`${prefix}stills/${s.id}-${i}.jpg`,new Uint8Array([0xff,0xd8])));
    const seen:{role?:string;version?:string;stages:string[]}={stages:[]};
    const result=await runVideoIndexJob({
      clip:async()=>({hash:A,name:'a.mov',prefix,ingest:ingest(A,20),overrides:{role:'b-roll',segments:{}}}),
      indexed:async(role,version,transcribed)=>{seen.role=role;seen.version=version;expect(transcribed).toBe(true);},
      storage,progress:async stage=>{seen.stages.push(stage);},
      vision,transcribe:(async(audio:string,_out:string,src:{hash:string})=>{expect(await Bun.file(audio).text()).toBe('FLAC');return transcript(src.hash);}) as never,
      faces:async jpegs=>jpegs.map((_,i)=>i===0?{x:0.4,y:0.3,w:0.2,h:0.35}:null),
    });
    expect(result.segments).toBeGreaterThan(0);
    expect(JSON.parse(objects.get(`${prefix}transcript.json`) as string).sourceHash).toBe(A);
    const index=JSON.parse(objects.get(`${prefix}index.json`) as string);
    expect(index).toMatchObject({clipHash:A,roleGuess:'a-roll',transcriptRef:'transcript.json'});
    expect(index.segments[0].words).toContain('today');
    expect(index.segments[0].face).toEqual({x:0.4,y:0.3,w:0.2,h:0.35});
    expect(seen.role).toBe('b-roll'); // creator override wins over the model
    expect(seen.version).toStartWith('video.index@');
    expect(seen.stages).toEqual(expect.arrayContaining(['transcribing','indexing']));
  });

  test('silent clips skip transcription',async()=>{
    const {objects,storage}=memory();
    const prefix=`users/u1/video/clips/${B}/`;
    for(const s of ingest(B,5,false).segments)s.stills.forEach((_,i)=>objects.set(`${prefix}stills/${s.id}-${i}.jpg`,new Uint8Array([1])));
    await runVideoIndexJob({clip:async()=>({hash:B,name:'b.mov',prefix,ingest:ingest(B,5,false)}),indexed:async()=>{},storage,progress:async()=>{},vision,
      transcribe:(async()=>{throw new Error('should not transcribe');}) as never,faces:async()=>{throw new Error('no detector');}});
    expect(objects.has(`${prefix}transcript.json`)).toBe(false); // and a failed face search still stores the index
    expect(objects.has(`${prefix}index.json`)).toBe(true);
  });

  test('music and effects skip transcription',async()=>{
    const {objects,storage}=memory();
    const prefix=`users/u1/video/clips/${B}/`;
    objects.set(`${prefix}audio.flac`,'FLAC');
    const music={...ingest(B,5),role:'music' as const};
    for(const s of music.segments)s.stills.forEach((_,i)=>objects.set(`${prefix}stills/${s.id}-${i}.jpg`,new Uint8Array([1])));
    let transcribed:boolean|undefined;
    await runVideoIndexJob({clip:async()=>({hash:B,name:'b.mov',prefix,ingest:music}),indexed:async(_r,_v,t)=>{transcribed=t;},storage,progress:async()=>{},vision,
      transcribe:(async()=>{throw new Error('should not transcribe');}) as never,faces:async()=>[]});
    expect(objects.has(`${prefix}transcript.json`)).toBe(false);
    expect(transcribed).toBe(false); // so Convex points no transcriptKey at a missing file
  });
});

describe('video-plan job',()=>{
  test('cuts the creator-picked a-roll and writes a valid EditDoc revision',async()=>{
    const {objects,storage}=memory();
    const planner=async(_s:string,input:any,schema:any)=>{
      const p=schema.properties??{};
      if(p.removals)return {plan:{removals:input.words.length>12?[{startWord:3,endWord:5,kind:'retake',keptStartWord:6,keptEndWord:8,confidence:0.95,reason:'restart'}]:[],summary:'s'},model:'m',usage:null};
      if(p.beats)return {plan:{beats:[{id:'all',role:'progress',title:'All',content:'All of it',passages:input.passages.map((x:any)=>x.id)}],dropped:[],summary:'s'},model:'m',usage:null};
      return {plan:{items:[]},model:'m',usage:null};
    };
    const clip=(hash:string,duration:number,role?:'a-roll'|'b-roll')=>{
      const prefix=`users/u1/video/clips/${hash}/`;
      objects.set(`${prefix}index.json`,JSON.stringify({clipHash:hash,promptVersion:'v',model:'m',summary:'',roleGuess:'a-roll',segments:[],missing:[]}));
      objects.set(`${prefix}transcript.json`,JSON.stringify(transcript(hash)));
      return {hash,prefix,ingest:ingest(hash,duration,true,role),indexKey:`${prefix}index.json`,transcriptKey:`${prefix}transcript.json`};
    };
    let ready=0;let notes:string[]=[];
    const docKey='users/u1/video/edits/e1/rev-1.json';
    // The longer clip is b-roll by the creator's pick; the shorter one is the a-roll.
    const out=await runVideoPlanJob({
      edit:async()=>({edit:{id:'e1',name:'Demo',revision:0},clips:[clip(A,40,'b-roll'),clip(B,20,'a-roll')],revision:1,docKey}),
      ready:async(r,n,g)=>{ready=r;notes=n;expect(g).toEqual([]);},storage,progress:async()=>{},planner,
    });
    expect(out).toEqual({revision:1,docKey,notes,graphics:0}); // graphics stay off unless the worker turns them on
    expect(ready).toBe(1);
    const doc=editDocSchema.parse(JSON.parse(objects.get(docKey) as string));
    expect(doc.revision).toBe(1);
    expect(doc.clips).toEqual([expect.objectContaining({id:'c1',hash:A,role:'b-roll'}),expect.objectContaining({id:'c2',hash:B,role:'a-roll',roleSource:'creator'})]);
    expect(doc.tracks['a-roll'].length).toBeGreaterThan(0);
    expect(new Set(doc.tracks['a-roll'].map(i=>i.clipId))).toEqual(new Set(['c2'])); // unused b-roll stays listed, not placed
    expect(doc.brief?.beats.map(b=>b.id)).toEqual(['all']);
    expect(()=>parseEditDoc(doc)).not.toThrow();
    expect(doc.styleRef.id).toBe('calm-explainer');

    // Replan: starts from the latest revision and keeps clip ids by hash, even
    // when the clip list comes back in another order.
    const docKey2='users/u1/video/edits/e1/rev-2.json';
    await runVideoPlanJob({
      edit:async()=>({edit:{id:'e1',name:'Demo',revision:1,docKey,style:'tutorial',brand:{colors:{accent:'#112233'},fonts:{heading:'Anton'}}},clips:[clip(B,20,'a-roll'),clip(A,40,'b-roll')],revision:2,docKey:docKey2}),
      ready:async r=>{ready=r;},storage,progress:async()=>{},planner,
    });
    const doc2=editDocSchema.parse(JSON.parse(objects.get(docKey2) as string));
    expect(ready).toBe(2);
    expect(doc2.revision).toBe(2);
    expect(doc2.clips.map(c=>[c.id,c.hash])).toEqual([['c1',A],['c2',B]]);
    expect(doc2.styleRef.id).toBe('tutorial'); // a style picked for the new cut
    expect(doc2.styleRef.snapshot.brand.colors.accent).toBe('#112233'); // with the creator's brand kit over it
    expect(doc2.styleRef.snapshot.brand.fonts).toEqual({heading:'Anton',body:'Inter'});

    // The creator tunes the look; a replan on the same preset keeps it.
    const tuned=applyCreatorPatch(doc2,{style:{brand:{captionStyle:{size:90}}},mix:{duckingDb:-20}});
    const docKey3='users/u1/video/edits/e1/rev-3.json',docKey4='users/u1/video/edits/e1/rev-4.json';
    objects.set(docKey3,JSON.stringify(tuned));
    await runVideoPlanJob({
      edit:async()=>({edit:{id:'e1',name:'Demo',revision:tuned.revision,docKey:docKey3,style:'tutorial'},clips:[clip(B,20,'a-roll'),clip(A,40,'b-roll')],revision:4,docKey:docKey4}),
      ready:async()=>{},storage,progress:async()=>{},planner,
    });
    const doc4=editDocSchema.parse(JSON.parse(objects.get(docKey4) as string));
    expect(doc4.styleRef.snapshot.brand.captionStyle.size).toBe(90);
    expect(doc4.mix.duckingDb).toBe(-20);
  });

  test('refuses when no clip has speech',async()=>{
    const {objects,storage}=memory();
    const prefix=`users/u1/video/clips/${A}/`;
    objects.set(`${prefix}index.json`,JSON.stringify({clipHash:A,promptVersion:'v',model:'m',summary:'',roleGuess:'b-roll',segments:[],missing:[]}));
    await expect(runVideoPlanJob({edit:async()=>({edit:{id:'e1',name:'D',revision:0},clips:[{hash:A,prefix,ingest:ingest(A,10,false),indexKey:`${prefix}index.json`}],revision:1,docKey:'k'}),
      ready:async()=>{},storage,progress:async()=>{}})).rejects.toThrow('No video clip with speech');
  });
});

describe('video-graphic job',()=>{
  const request={purpose:'show the price',kind:'stat',title:'Cost',facts:[{label:'price',value:'$300'}],anchorWords:'it costs three hundred dollars',
    placement:'right',width:1920,height:1080,fps:30,durationInFrames:90};
  const tokens={colors:{background:'#000000',text:'#FFFFFF',muted:'#CCCCCC',primary:'#FFFFFF',accent:'#FFFFFF'},fonts:{heading:'Inter',body:'Inter'},safe:0.05};
  const SOURCE="import {z} from './kit';\nexport const schema=z.object({value:z.number()});\nexport const defaultProps={value:3};\nexport default function G(){return null;}\n";
  const prefix='users/u1/video/edits/e1/graphics/ga-000000000000000000000000/';
  const render=async(_s:string,input:any)=>({ok:true,stage:'done',props:input.props??{value:3},jsonSchema:{type:'object'},
    stills:new Map((input.stills??[]).map((f:number)=>[f,new Uint8Array([f])])),webm:input.stillsOnly?undefined:new Uint8Array([7])}) as never;

  test('first render: writes the source, the WebM and a still, then reports props and schema',async()=>{
    const {objects,storage}=memory();
    let done:any;
    const out=await runVideoGraphicJob({graphic:async()=>({assetId:'ga-0',revision:0,request,tokens,props:null,hasSource:false,prefix}),
      done:async r=>{done=r;},storage,progress:async()=>{},render,
      write:async()=>({text:'```tsx\n'+SOURCE+'```',model:'w',costUsd:0.01}),vision:async()=>({json:{defects:[]},model:'v'}) as never});
    expect(out.ok).toBe(true);
    expect(objects.get(`${prefix}source.tsx`)).toBe(SOURCE);
    expect(objects.get(`${prefix}r0.webm`)).toEqual(new Uint8Array([7]));
    expect(objects.has(`${prefix}r0.jpg`)).toBe(true);
    expect(done).toMatchObject({revision:0,ok:true,hasSource:true,props:{value:3},jsonSchema:JSON.stringify({type:'object'})});
  });

  test('new props render the stored source with no model call',async()=>{
    const {objects,storage}=memory();
    objects.set(`${prefix}source.tsx`,SOURCE);
    let done:any;
    await runVideoGraphicJob({graphic:async()=>({assetId:'ga-0',revision:2,request,tokens,props:{value:9},hasSource:true,prefix}),
      done:async r=>{done=r;},storage,progress:async()=>{},render,write:async()=>{throw new Error('no model call');}});
    expect(objects.get(`${prefix}r2.webm`)).toEqual(new Uint8Array([7]));
    expect(done).toMatchObject({revision:2,ok:true,props:{value:9}});
  });

  test('props the graphic rejects fail the job in plain words and keep the source',async()=>{
    const {objects,storage}=memory();
    objects.set(`${prefix}source.tsx`,SOURCE);
    let done:any;
    const out=await runVideoGraphicJob({graphic:async()=>({assetId:'ga-0',revision:1,request,tokens,props:{value:'x'},hasSource:true,prefix}),
      done:async r=>{done=r;},storage,progress:async()=>{},render:(async()=>({ok:false,stage:'props',error:'Expected number',stills:new Map()})) as never});
    expect(out.ok).toBe(false);
    expect(done).toMatchObject({revision:1,ok:false,hasSource:true});
    expect(done.problem).toContain('do not fit');
    expect(objects.has(`${prefix}r1.webm`)).toBe(false);
  });
});

describe('video-render job',()=>{
  const bytesA=new TextEncoder().encode('clip A bytes'),bytesM=new TextEncoder().encode('music bytes');
  const sha=(b:Uint8Array)=>new Bun.CryptoHasher('sha256').update(b).digest('hex');
  const [HA,HM]=[sha(bytesA),sha(bytesM)];
  function renderDoc() {
    const clip=(id:string,hash:string,role:'a-roll'|'b-roll'|'music',over={})=>({id,hash,name:`${id}.mov`,kind:role==='music'?'audio' as const:'video' as const,role,
      roleSource:'creator' as const,duration:10,fps:{num:30,den:1},hasAudio:true,timecodeStart:0,width:640,height:360,...over});
    const d=newEditDoc({id:'ed1',name:'R',clips:[clip('c1',HA,'a-roll'),clip('c2',HM,'music'),clip('c3',B,'b-roll',{hasAudio:false})],fps:{num:30,den:1},style:STYLE_PRESETS.tutorial});
    return parseEditDoc({...d,tracks:{...d.tracks,'a-roll':[{id:'a1',clipId:'c1',in:0,out:2,start:0,end:2,owner:'agent'}],
      graphics:[{id:'g1',assetId:'ga-1',start:0,end:1,owner:'agent'}],music:[{id:'m1',clipId:'c2',in:0,out:2,start:0,end:2,owner:'agent'}]}}).doc;
  }
  function setup(a=bytesA) {
    const {objects,storage}=memory();
    objects.set('d/rev-2.json',JSON.stringify(renderDoc()));
    objects.set('s/a.mov',a);objects.set('s/m.mp3',bytesM);objects.set('g/r1.webm','WEBM');
    const uploads:string[]=[];
    return {objects,uploads,storage:{...storage,upload:async(path:string,key:string)=>{uploads.push(key);return (await Bun.file(path).bytes()).length;}},
      render:async()=>({docKey:'d/rev-2.json',outputKey:'out.mp4',
        sources:[{hash:HA,key:'s/a.mov',size:bytesA.length},{hash:HM,key:'s/m.mp3',size:bytesM.length}],graphics:[{assetId:'ga-1',key:'g/r1.webm'},{assetId:'ga-2',key:'g/other.webm'}]})};
  }

  test('downloads only what the doc shows, checks hashes, renders and uploads',async()=>{
    const s=setup();
    let done:unknown;
    const r=await runVideoRenderJob({render:s.render,storage:s.storage,done:async d=>{done=d;},dropSources:async()=>{throw new Error('no drop');},progress:async()=>{},
      renderDoc:(async (o:Parameters<NonNullable<Parameters<typeof runVideoRenderJob>[0]['renderDoc']>>[0])=>{
        expect(Object.keys(o.media).sort()).toEqual([HA,HM].sort());
        expect(Object.keys(o.graphics!)).toEqual(['ga-1']);
        await Bun.write(o.out,'MP4');
        return {out:o.out,frames:60,duration:2,skipped:[]};
      }) as never});
    expect(r).toEqual({frames:60,duration:2,bytes:3,skipped:0});
    expect(done).toEqual({frames:60,duration:2,bytes:3,skipped:[]});
    expect(s.uploads).toEqual(['out.mp4']);
  });

  test('a file that does not hash to its clip is dropped and fails the job',async()=>{
    const bad=new TextEncoder().encode('clip A bytez');
    const s=setup(bad);
    const dropped:string[][]=[];
    await expect(runVideoRenderJob({render:s.render,storage:s.storage,done:async()=>{},dropSources:async h=>{dropped.push(h);},progress:async()=>{},
      renderDoc:(async()=>{throw new Error('should not render');}) as never})).rejects.toThrow('do not match');
    expect(dropped).toEqual([[HA]]);
  });
});

describe('graphics sandbox check',()=>{
  test('a missing image (or no Docker) means no graphics',async()=>{
    const {sandboxReady}=await import('../src/video/graphics/render');
    expect(await sandboxReady('voxtale-no-such-image:0')).toBe(false);
  });
});
