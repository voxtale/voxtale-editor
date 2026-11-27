// Local transcription with a stub engine: no model, no network, no Python.
import {describe,expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chooseEngine,localModel,mergePass,MissingModelError,spans,stitch,transcribeLocal,type LocalEngine,type LocalModel,type RawWord} from '../src/video/local-transcribe';
import {transcribeAudio} from '../src/video/transcript';
import {normalizeLocalTranscript,transcriptSchema} from '../src/video/transcript-model';

const w=(text:string,start:number,end:number,confidence=0.9):RawWord=>({text,start,end,confidence});
const READY:LocalModel={backend:'onnx',dir:'/m',missing:[],ready:true};
const GONE:LocalModel={backend:'mlx',dir:'/repo/models/parakeet/parakeet-tdt-0.6b-v3-mlx',missing:['config.json','model.safetensors'],ready:false};

describe('pieces',()=>{
  test('short input is one read',()=>{
    expect(spans(600)).toEqual([{index:0,from:0,to:600,readFrom:0,readTo:600}]);
  });
  test('long input: pieces with a pad each side; a last sliver joins the piece before',()=>{
    const s=spans(3000,{long:1500,piece:1200,pad:5});
    expect(s.map(p=>[p.from,p.to,p.readFrom,p.readTo])).toEqual([[0,1200,0,1205],[1200,2400,1195,2405],[2400,3000,2395,3000]]);
    expect(spans(2500,{long:1500,piece:1200,pad:5}).map(p=>p.to)).toEqual([1200,2500]); // 100 s sliver joins
  });
});

describe('stitch',()=>{
  test('a word read twice at the seam, 60 ms apart, comes out once; pad words are dropped',()=>{
    const span0={index:0,from:0,to:10,readFrom:0,readTo:12},span1={index:1,from:10,to:20,readFrom:8,readTo:20};
    // Piece 0 reads "seam" ending just before 10 (mid 9.98); piece 1 reads it 60 ms later (mid 10.04).
    const a=[w('one',1,1.4),w('seam',9.7,10.26),w('pad',11,11.5)];
    const b=[w('early',0.5,0.9),w('seam',1.76,2.32),w('pad',3,3.5),w('two',5,5.5)]; // +8 s: early 8.5, seam 9.76, pad 11, two 13
    const out=stitch([{span:span1,words:b},{span:span0,words:a}]);
    expect(out.map(x=>x.text)).toEqual(['one','seam','pad','two']);
    expect(out.map(x=>x.start)).toEqual([1,9.76,11,13]);
  });
  test('mergePass replaces the words of its span and keeps the rest',()=>{
    const old=[w('a',0,0.5),w('b',1,1.5),w('c',2,2.5)];
    expect(mergePass(old,[w('B',1.02,1.5)],0.8,1.8).map(x=>x.text)).toEqual(['a','B','c']);
  });
});

describe('engine choice',()=>{
  test('auto: local when the model is there',()=>{
    expect(chooseEngine({model:READY,env:{}})).toMatchObject({engine:'local',label:expect.stringContaining('free')});
  });
  test('auto with no model: an error naming the fetch script and the paid switch, never a silent paid run',()=>{
    let e:unknown;try{chooseEngine({model:GONE,env:{ASSEMBLYAI_API_KEY:'k'}});}catch(x){e=x;}
    expect(e).toBeInstanceOf(MissingModelError);
    expect((e as Error).message).toContain('tools/fetch-parakeet.sh');
    expect((e as Error).message).toContain('VOXTALE_EDITOR_TRANSCRIBE=assemblyai');
    expect(()=>chooseEngine({model:GONE,env:{VOXTALE_EDITOR_TRANSCRIBE:'local'}})).toThrow(MissingModelError);
  });
  test('assemblyai only when asked for, or when a client is passed in',()=>{
    expect(chooseEngine({model:READY,env:{VOXTALE_EDITOR_TRANSCRIBE:'assemblyai'}}).engine).toBe('assemblyai');
    expect(chooseEngine({model:GONE,requested:'assemblyai',env:{}}).label).toContain('paid');
    expect(chooseEngine({model:GONE,injectedFetch:true,env:{}}).engine).toBe('assemblyai');
    expect(chooseEngine({model:READY,injectedFetch:true,env:{VOXTALE_EDITOR_TRANSCRIBE:'local'}}).engine).toBe('local');
    expect(()=>chooseEngine({model:READY,env:{VOXTALE_EDITOR_TRANSCRIBE:'whisper'}})).toThrow('local, assemblyai or auto');
  });
  test('model per machine: MLX on Apple Silicon, ONNX elsewhere or with VOXTALE_EDITOR_ASR=cpu',()=>{
    const root='/nowhere';
    expect(localModel({root,platform:'darwin',arch:'arm64',env:{}})).toMatchObject({backend:'mlx',ready:false,missing:['config.json','model.safetensors']});
    expect(localModel({root,platform:'darwin',arch:'arm64',env:{VOXTALE_EDITOR_ASR:'cpu'}}).backend).toBe('onnx');
    expect(localModel({root,platform:'win32',arch:'x64',env:{}}).missing).toEqual(['encoder.int8.onnx','decoder.int8.onnx','joiner.int8.onnx','tokens.txt']);
  });
});

/** Says each piece's read range back as one word per second of its WAV, plus a duplicate-prone seam word. */
function stub() {
  const reads:[number,number][]=[];const cut=async(_i:string,from:number,to:number,out:string)=>{reads.push([from,to]);await Bun.write(out,JSON.stringify([from,to]));};
  const engine:LocalEngine={words:async wav=>{
    const [from,to]=JSON.parse(await Bun.file(wav).text()) as [number,number];
    const words:RawWord[]=[];
    for(let t=Math.ceil(from);t+0.4<to;t++)words.push(w(`w${t}`,t-from,t-from+0.4));
    return {engine:'parakeet-stub',model:'parakeet-tdt-0.6b-v3',words};
  }};
  return {reads,cut,engine};
}

describe('transcribe through the port',()=>{
  test('long input: pieces read with pads, every second once, in order',async()=>{
    const s=stub();
    const r=await transcribeLocal('in.flac',50,{...s,long:20,piece:20,pad:2});
    expect(s.reads).toEqual([[0,22],[18,42],[38,50]]);
    expect(r.words.map(x=>x.text)).toEqual(Array.from({length:50},(_,i)=>`w${i}`));
  });

  test('transcribeAudio, local: the Transcript shape the editor reads, cached on its path',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'vx-local-tx-'));
    try {
      const s=stub(),log:string[]=[],out=join(dir,'t.json'),src={name:'clip.mp4',hash:'a'.repeat(64),duration:3};
      const t=await transcribeAudio(join(dir,'audio.flac'),out,src,{engine:'local',model:READY,local:s,progress:m=>log.push(m)});
      expect(transcriptSchema.parse(t)).toEqual(t);
      expect(t).toMatchObject({version:1,provider:'parakeet',source:'clip.mp4',sourceHash:src.hash,duration:3});
      expect(t.words[0]).toEqual({id:0,text:'w0',start:0,end:0.4,confidence:0.9});
      expect(t.words.map(x=>x.id)).toEqual([0,1,2]);
      expect(log.join('\n')).toContain('Engine: local Parakeet v3, free');
      const again=await transcribeAudio(join(dir,'audio.flac'),out,src,{engine:'local',model:READY,local:{...s,engine:{words:async()=>{throw new Error('cached: no engine call');}}}});
      expect(again).toEqual(t);
    } finally {await rm(dir,{recursive:true,force:true});}
  });

  test('missing model: transcribeAudio fails with the fix before touching the audio',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'vx-local-tx-'));
    const saved=process.env.VOXTALE_EDITOR_TRANSCRIBE;delete process.env.VOXTALE_EDITOR_TRANSCRIBE;
    try {
      const s=stub();
      await expect(transcribeAudio('x.flac',join(dir,'t.json'),{name:'x',hash:'b',duration:3},{model:GONE,local:s})).rejects.toThrow('tools/fetch-parakeet.sh');
      expect(s.reads).toEqual([]);
    } finally {if(saved!==undefined)process.env.VOXTALE_EDITOR_TRANSCRIBE=saved;await rm(dir,{recursive:true,force:true});}
  });

  test('normalize: words past the end are dropped or trimmed, empty text dropped',()=>{
    const t=normalizeLocalTranscript({engine:'parakeet-onnx',model:'parakeet-tdt-0.6b-v3',words:[w('a',0,0.5),w(' ',0.6,0.7),w('b',1.8,2.4),w('c',2.1,2.2)]},'s','h'.repeat(12),2);
    expect(t.words).toEqual([{id:0,text:'a',start:0,end:0.5,confidence:0.9},{id:1,text:'b',start:1.8,end:2,confidence:0.9}]);
    expect(t.model).toBe('parakeet-tdt-0.6b-v3 (parakeet-onnx)');
  });
});
