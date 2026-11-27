// pick_object with a stub picker: no model, no network (bd voxtale-editor-8a6).
import {afterAll,describe,expect,test} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipRefSchema,type ClipRef} from '@voxtale/editdoc';

import {styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import type {FrameHost} from '../src/video/editor/agent/frames';
import {pickedText,type ObjectPicker} from '../src/video/editor/agent/object-tools';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';

const ref=(id:string,role:ClipRef['role'],hash:string)=>clipRefSchema.parse({id,hash:hash.repeat(64),name:`${id}.mp4`,
  kind:'video',role,roleSource:'creator',duration:40,fps:{num:30,den:1},width:1920,height:1080,hasAudio:true,timecodeStart:0});
const dirs:string[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});

async function start(picker?:ObjectPicker) {
  const dir=await mkdtemp(join(tmpdir(),'picks-'));dirs.push(dir);
  const asked:{width?:number;times:number[]}[]=[];
  const host:FrameHost={filmstrip:async()=>new Uint8Array(),joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''}),
    frames:async(_c,times,width)=>{asked.push({width,times});return times.map(()=>new Uint8Array([0xff,0xd8]));}};
  const job:Job={id:'j',name:'Picks',clips:[{ref:ref('c1','a-roll','a'),words:[]}] as JobClip[],style:styleOf(undefined)};
  const ws=newWorkspace({dir,job,frames:host,graphics:false});
  ws.picker=picker;
  return {tools:jobTools(ws),asked};
}

describe('pick_object',()=>{
  test('the report flags an empty pick and one that takes over half the frame',()=>{
    const t=pickedText([{mode:'add',area:0.04,box:[0.4,0.1,0.2,0.3],score:0.93},{mode:'add',area:0,box:null,score:0.1},{mode:'remove',area:0.7,box:[0,0,1,1],score:0.8}]);
    const [ok,empty,big]=t.split('\n');
    expect(ok).toContain('4.0% of the frame');
    expect(ok).not.toContain('—');
    expect(empty).toContain('nothing there');
    expect(big).toContain('over half');
  });
  test('no picker, no tool',async()=>{
    expect((await start()).tools.some(t=>t.name==='pick_object')).toBe(false);
  });
  test('fetches the still at 1024 wide, hands the prompts on, returns the overlay',async()=>{
    const seen:unknown[]=[];
    const picker:ObjectPicker=async(image,_out,overlay,objects)=>{
      seen.push({image,objects});
      await writeFile(overlay,new Uint8Array([1,2,3]));
      return [{mode:'add',area:0.05,box:[0.4,0.1,0.2,0.3],score:0.9}];
    };
    const {tools,asked}=await start(picker);
    const pick=tools.find(t=>t.name==='pick_object')!;
    const objects=[{mode:'add',box:[0.4,0.1,0.2,0.3]}];
    const r=await pick.run({clip:'c1',t:2.5,objects} as never);
    expect(r.isError).toBeFalsy();
    expect(asked).toEqual([{width:1024,times:[2.5]}]);
    expect(seen).toMatchObject([{objects}]);
    expect(r.text).toContain('clip "c1" and t 2.50');
    expect([...r.images![0]!.data]).toEqual([1,2,3]);
    // Bad prompts stop before any frame is fetched.
    await expect(pick.run({clip:'c1',t:2.5,objects:[{mode:'add',exclude:[[0.5,0.5]]}]} as never)).rejects.toThrow('points or a box');
    await expect(pick.run({clip:'c1',t:2.5,objects:[{mode:'add',box:[0.8,0.1,0.3,0.3]}]} as never)).rejects.toThrow('outside the frame');
    await expect(pick.run({clip:'c1',t:41,objects} as never)).rejects.toThrow('40.00s long');
    expect(asked.length).toBe(1);
  });
});
