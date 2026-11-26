import {describe,expect,test} from 'bun:test';
import {applyIndexOverrides,clipIngestSchema,segmentsFromCuts,type ClipIngest} from '@voxtale/editdoc';
import {indexClip,indexPromptVersion,type VisionModel,type VisionPart} from '../src/video';
import {INDEX_PROMPT_ID as ID} from '../src/video/prompts';

const HASH='c'.repeat(64);
function ingest(duration:number,cuts:number[]=[],kind:ClipIngest['kind']='video'):ClipIngest {
  return clipIngestSchema.parse({hash:HASH,name:'take1.mov',kind,duration,fps:{num:30,den:1},width:1920,height:1080,hasAudio:true,
    segments:segmentsFromCuts(duration,cuts).map(({id,start,end,stills})=>({id,start,end,stills}))});
}
const words=[{text:'hello',start:1,end:1.4},{text:'world',start:1.5,end:2},{text:'later',start:30,end:30.5}];
const still=async()=>new Uint8Array([0xff,0xd8,0xff]);
const ids=(parts:VisionPart[])=>parts.filter(p=>p.type==='text').map(p=>(p as {text:string}).text.split(' ')[0]!);

describe('footage index',()=>{
  test('labels by ID, drops unknown IDs, keeps our times and words',async()=>{
    const calls:VisionPart[][]=[];
    const model:VisionModel=async(system,parts)=>{
      calls.push(parts);
      expect(system.length).toBeGreaterThan(0);
      return {model:'m',costUsd:0.01,json:{summary:'A talk.',roleGuess:'a-roll',segments:[
        ...ids(parts).map(id=>({id,description:`desc ${id}`,subjects:['Martin'],action:'talks',setting:'desk',shotType:'talking-head',
          onScreenText:[],quality:{blur:false,exposure:'dark',shaky:false},usable:true,mustShow:'',start:999})),
        {id:'S999',description:'invented'}]}};
    };
    const idx=await indexClip({ingest:ingest(45,[10]),words,still},model);
    expect(idx.segments.map(s=>[s.id,s.start,s.end])).toEqual([['S001',0,10],['S002',10,27.5],['S003',27.5,45]]);
    expect(idx.segments[0]).toMatchObject({description:'desc S001',shotType:'talking-head',usable:true,words:'hello world',quality:{exposure:'dark'}});
    expect(idx.segments[0]!.mustShow).toBeUndefined();
    expect(idx.segments[2]!.words).toBe('later');
    expect(idx.missing).toEqual([]);
    expect(idx.roleGuess).toBe('a-roll');
    expect(idx.promptVersion).toBe(indexPromptVersion());
    expect(idx.promptVersion.startsWith(`${ID}@`)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filter(p=>p.type==='image')).toHaveLength(6); // two stills each
  });

  test('batches, retries missing IDs once, then marks them unlabelled',async()=>{
    const seen:string[][]=[];
    const model:VisionModel=async(_s,parts)=>{
      const got=ids(parts);seen.push(got);
      // S002 is never labelled; S003 only on retry.
      const answer=got.filter(id=>id!=='S002'&&!(id==='S003'&&seen.length<=3));
      return {model:'m',json:{summary:'x',roleGuess:'screen',segments:answer.map(id=>({id,description:id,usable:false,shotType:'nonsense'}))}};
    };
    const idx=await indexClip({ingest:ingest(80,[10,20,30]),words,still},model,{batchSize:2,concurrency:1});
    expect(seen.slice(0,3)).toEqual([['S001','S002'],['S003','S004'],['S005','S006']]);
    expect(seen.slice(3)).toEqual([['S002','S003']]);
    expect(idx.missing).toEqual(['S002']);
    expect(idx.segments.find(s=>s.id==='S002')).toMatchObject({description:'',usable:null});
    expect(idx.segments.find(s=>s.id==='S003')).toMatchObject({description:'S003',usable:false,shotType:'other'});
  });

  test('a failed batch is retried; all failing is an error',async()=>{
    let n=0;
    const flaky:VisionModel=async(_s,parts)=>{if(n++===0)throw new Error('503');return {model:'m',json:{segments:ids(parts).map(id=>({id,description:'ok'}))}};};
    const idx=await indexClip({ingest:ingest(15),words,still},flaky);
    expect(idx.missing).toEqual([]);
    const dead:VisionModel=async()=>{throw new Error('down');};
    await expect(indexClip({ingest:ingest(15),words,still},dead)).rejects.toThrow(/labelled no segments/);
  });

  test('audio clips skip the model; creator role wins over guess',async()=>{
    const never:VisionModel=async()=>{throw new Error('should not call');};
    const idx=await indexClip({ingest:ingest(40,[],'audio'),words:[],still},never);
    expect(idx.roleGuess).toBe('music');
    expect(idx.segments.every(s=>s.usable===true)).toBe(true);
    const own=await indexClip({ingest:{...ingest(15),role:'b-roll'},words,still},async(_s,p)=>({model:'m',json:{roleGuess:'a-roll',segments:ids(p).map(id=>({id}))}}));
    expect(own.roleGuess).toBe('b-roll');
  });

  test('creator overrides apply over a re-index',async()=>{
    const idx=await indexClip({ingest:ingest(15),words,still},async(_s,p)=>({model:'m',json:{roleGuess:'screen',segments:ids(p).map(id=>({id,description:'model',usable:true}))}}));
    const fixed=applyIndexOverrides(idx,{role:'a-roll',segments:{S001:{description:'my words',usable:false}}});
    expect(fixed.roleGuess).toBe('a-roll');
    expect(fixed.segments[0]).toMatchObject({description:'my words',usable:false});
  });
});

describe('first edit',()=>{
  test('a-roll clip + transcript -> EditDoc with cuts and captions',async()=>{
    const {planFirstEdit,editForClip}=await import('../src/video');
    const {docDuration:timelineDuration}=await import('@voxtale/editdoc');
    const clip={id:'c1',hash:HASH,name:'take1.mov',kind:'video' as const,role:'a-roll' as const,roleSource:'creator' as const,duration:20,fps:{num:30000,den:1001},width:1921,height:1080,hasAudio:true,timecodeStart:0};
    const texts='so today I want to I want to show you the new app it is fast and it is free'.split(' ');
    const tw=texts.map((text,i)=>({id:i,text,start:1+i*0.5,end:1.4+i*0.5,confidence:0.99}));
    const transcript={version:1 as const,provider:'assemblyai' as const,providerId:'t',source:'take1.mov',sourceHash:HASH,duration:20,model:'u',words:tw};
    expect(editForClip(clip,'x')).toMatchObject({fps:30,width:1922,scenes:[{in:0,out:20}]});
    const planner=async(_s:string,input:any,schema:any)=>{
      if(schema.properties?.removals) return {plan:input.invalidPlan?{removals:[],summary:''}:{removals:input.words.length>12?[{startWord:3,endWord:5,kind:'retake',keptStartWord:6,keptEndWord:8,confidence:0.95,reason:'restart'}]:[],summary:'s'},model:'m',usage:null};
      return {plan:{graphics:[]},model:'m',usage:null};
    };
    const writes:string[]=[];
    const doc=await planFirstEdit({id:'edit-1',name:'Demo',clip,transcript,planner,output:{write:async n=>{writes.push(n);}}});
    expect(doc.clips).toEqual([expect.objectContaining({id:'c1',hash:HASH})]);
    const aroll=doc.tracks['a-roll'];
    expect(aroll.length).toBeGreaterThan(1);
    expect(aroll.every(a=>a.clipId==='c1')).toBe(true);
    // "I want to" (words 3-5, 2.5s-3.9s) is gone from the kept source ranges.
    expect(aroll.some(a=>a.in<=2.6&&a.out>=3.8)).toBe(false);
    expect(doc.tracks.captions.length).toBeGreaterThan(0);
    expect(timelineDuration(doc)).toBeLessThan(20);
    expect(writes).toContain('edit');
  });
});
