// Sequence transcription: which passages the cut plays, the joined audio's
// times back to source, the word merge, and one round trip through a fake
// AssemblyAI (injected fetch; no network, no spend).
import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergePassages,mergeWords,placePassages,sequencePassages,toSource,transcribePassages,PASSAGE_GAP} from '../src/video/sequence-transcript';

const item=(o:Record<string,unknown>)=>({owner:'agent',status:'applied',...o});
const doc=(tracks:Record<string,unknown[]>)=>({tracks:{'a-roll':[],'b-roll':[],voiceover:[],music:[],...tracks}}) as never;

describe('passages',()=>{
  test('items clipped to the range, through speed; muted b-roll and suggestions skipped',()=>{
    const d=doc({
      'a-roll':[item({id:'a',clipId:'c1',in:10,out:14,start:0,end:4}),item({id:'s',clipId:'c1',in:40,out:42,start:4,end:6,status:'suggested'})],
      'b-roll':[item({id:'b',clipId:'b1',in:0,out:4,start:1,end:3,muted:false,speed:2}),item({id:'m',clipId:'b2',in:0,out:2,start:1,end:3,muted:true})],
    });
    expect(sequencePassages(d,['a-roll','b-roll'],{from:2,to:3})).toEqual([{clipId:'b1',from:2,to:4},{clipId:'c1',from:12,to:13}]);
    expect(sequencePassages(d,['a-roll'])).toEqual([{clipId:'c1',from:10,to:14}]);
  });
  test('touching passages of a clip merge',()=>{
    expect(mergePassages([{clipId:'c',from:3,to:5},{clipId:'c',from:0,to:3},{clipId:'c',from:8,to:9}])).toEqual([{clipId:'c',from:0,to:5},{clipId:'c',from:8,to:9}]);
  });
  test('joined-audio words go back to source; a word in a gap is dropped',()=>{
    const placed=placePassages([{from:10,to:12},{from:20,to:21}]);
    expect(placed[1]!.at).toBe(2+PASSAGE_GAP);
    expect(toSource([{text:'a',start:0.5,end:0.9},{text:'gap',start:2.2,end:2.4},{text:'b',start:2.6,end:2.9}],placed))
      .toEqual([{text:'a',start:10.5,end:10.9},{text:'b',start:20.1,end:20.4}]);
  });
  test('old words keep ids, overlaps dropped, new ids from the top, sorted by time',()=>{
    const m=mergeWords([{id:0,text:'x',start:5,end:5.5},{id:1,text:'y',start:6,end:6.5}],[{text:'dup',start:5.1,end:5.4},{text:'early',start:1,end:1.3}]);
    expect(m.added).toBe(1);
    expect(m.words.map(w=>[w.id,w.text])).toEqual([[2,'early'],[0,'x'],[1,'y']]);
  });
});

describe('round trip through a fake AssemblyAI',()=>{
  let dir='';const key=process.env.ASSEMBLYAI_API_KEY;
  beforeAll(async()=>{dir=await mkdtemp(join(tmpdir(),'seqtx-'));process.env.ASSEMBLYAI_API_KEY='test-not-a-key';});
  afterAll(async()=>{await rm(dir,{recursive:true,force:true});if(key===undefined)delete process.env.ASSEMBLYAI_API_KEY;else process.env.ASSEMBLYAI_API_KEY=key;});
  test('one call per clip, words land in source time, a second run is cached',async()=>{
    const calls:string[]=[],ffArgs:string[][]=[];
    const ff=async(args:string[])=>{ffArgs.push(args);await writeFile(args.at(-1)!,'fake flac');};
    const fetch=(async(url:string)=>{
      calls.push(String(url).replace(/^.*\/v2/,''));
      const body=String(url).endsWith('/upload')?{upload_url:'u'}:String(url).endsWith('/transcript')?{id:'t1'}
        :{id:'t1',status:'completed',words:[{text:'hello',start:200,end:600,confidence:0.9},{text:'there',start:2600,end:2900,confidence:0.9}]};
      return new Response(JSON.stringify(body),{status:200});
    }) as unknown as typeof globalThis.fetch;
    const clips=[{id:'b1',hash:'b'.repeat(64),path:'/x/b1.mov',words:[]}];
    const ps=[{clipId:'b1',from:10,to:12},{clipId:'b1',from:20,to:21}];
    const [r]=await transcribePassages(ff,dir,clips,ps,{fetch,pollMs:1});
    expect(r!.error).toBeUndefined();
    expect(r!.words).toEqual([{id:0,text:'hello',start:10.2,end:10.6},{id:1,text:'there',start:20.1,end:20.4}]);
    expect(calls).toEqual(['/upload','/transcript','/transcript/t1']);
    expect(ffArgs[0]!.join(' ')).toContain('atrim=start=10.000:end=12.000');
    await transcribePassages(ff,dir,clips,ps,{fetch,pollMs:1});
    expect(calls.length).toBe(3);
  });
});
