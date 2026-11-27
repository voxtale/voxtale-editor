// SFX recipes: the lavfi allowlist, the starter
// recipes, and making one locally with ffmpeg when this machine has it. No
// network, no paid service.
import {describe,expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {clipRefSchema} from '@voxtale/editdoc';
import type {FrameHost} from '@voxtale/frames';
import {ffmpegPath} from '../src/video/ffmpeg-path';
import {styleOf,type Job} from '../src/video/editor/agent/cut';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';
import {ff} from '../src/video/editor/agent/look';
import {SFX_RECIPE_IDS,SFX_VARIANTS,badSfxGraph,graphFilters,makeSfx,recipeGraph} from '../src/video/sfx-recipes';

describe('graph allowlist',()=>{
  test('names come out of labels, chains and quotes',()=>{
    expect(graphFilters("sine=f=60:d=0.6,afade=t=out[a];anoisesrc=d=0.1[b];[a][b]amix=inputs=2")).toEqual(['sine','afade','anoisesrc','amix']);
    expect(graphFilters("aevalsrc='0.4*sin(2*PI*(150*t)),x':d=1")).toEqual(['aevalsrc']);
  });
  test('every starter recipe and variant passes',()=>{
    for(const r of SFX_RECIPE_IDS)for(let v=0;v<SFX_VARIANTS.length;v++)expect(badSfxGraph(recipeGraph(r,v))).toBeNull();
  });
  test('variants differ',()=>{
    for(const r of SFX_RECIPE_IDS)expect(recipeGraph(r,1)).not.toBe(recipeGraph(r,0));
  });
  test('file readers, writers and file options are refused',()=>{
    expect(badSfxGraph('amovie=/etc/passwd')).toContain('not allowed');
    expect(badSfxGraph('sine=f=440,ashowinfo')).toContain('ashowinfo');
    expect(badSfxGraph('sine=f=440,afir')).toBeNull();
    expect(badSfxGraph('sine=/f=/tmp/x')).toContain('file');
    expect(badSfxGraph('volume=2')).toContain('source');
    expect(badSfxGraph('')).toContain('none');
  });
});

describe.skipIf(!existsSync(ffmpegPath()))('making a sound with local ffmpeg',()=>{
  test('a recipe becomes a limited WAV with a measured peak; the same recipe again is the same file',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'sfx-'));
    try {
      const a=await makeSfx(ff,dir,'boom',recipeGraph('impact'));
      expect(existsSync(a.path)).toBe(true);
      expect(a.duration).toBeGreaterThan(0.5);
      expect(a.duration).toBeLessThan(0.8);
      expect(a.peak).toBeLessThan(0.2);
      expect(a.levelDb).toBeLessThan(0);
      expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
      const b=await makeSfx(ff,dir,'boom',recipeGraph('impact'));
      expect(b.path).toBe(a.path);
      await expect(makeSfx(ff,dir,'x','amovie=a.wav')).rejects.toThrow('refused');
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  test('every starter recipe renders',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'sfx-'));
    try {
      for(const r of SFX_RECIPE_IDS) {
        const m=await makeSfx(ff,dir,r,recipeGraph(r,2));
        expect(m.duration).toBeGreaterThan(0);
        expect(m.duration).toBeLessThan(2);
      }
    } finally {await rm(dir,{recursive:true,force:true});}
  },30_000);
});

describe.skipIf(!existsSync(ffmpegPath()))('make_sfx tool',()=>{
  const words='one two three four five six'.split(' ').map((text,i)=>({id:i,text,start:1+i,end:1.4+i}));
  const job=():Job=>({id:'j',name:'J',clips:[{ref:clipRefSchema.parse({id:'c1',hash:'a'.repeat(64),name:'c1.mov',kind:'video',role:'a-roll',roleSource:'index',duration:20,width:1920,height:1080,hasAudio:true}),words}],style:styleOf(undefined)});
  const host:FrameHost={filmstrip:async()=>new Uint8Array(),joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''}),frames:async(_c,t)=>t.map(()=>null),sample:async()=>new Uint8Array()};
  test('only with a project folder; makes a clip set_sfx places and the render can find',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'mksfx-'));
    try {
      expect(jobTools(newWorkspace({dir,job:job(),frames:host,graphics:false})).some(t=>t.name==='make_sfx')).toBe(false);
      const ws=newWorkspace({dir,job:job(),frames:host,graphics:false});
      ws.media={};
      const tool=(n:string)=>jobTools(ws).find(t=>t.name===n)!;
      const out=(await tool('make_sfx').run({name:'boom',recipe:'impact',variant:1} as never)).text;
      expect(out).toContain('sfx-boom');
      const c=ws.job.clips.find(x=>x.ref.id==='sfx-boom')!;
      expect(c.ref.role).toBe('sfx');
      expect(existsSync(ws.media[c.ref.hash]!)).toBe(true);
      // Same recipe again: same clip, no second one.
      await tool('make_sfx').run({name:'boom2',recipe:'impact',variant:1} as never);
      expect(ws.job.clips.filter(x=>x.ref.role==='sfx').length).toBe(1);
      await tool('set_cut').run({segments:[{clip:'c1',from:0,to:5}]} as never);
      await tool('set_sfx').run({hits:[{on:{clip:'c1',word:2},sound:'sfx-boom',reason:'the point'}]} as never);
      expect(ws.doc!.tracks.sfx.some(i=>i.clipId==='sfx-boom')).toBe(true);
      expect(ws.doc!.clips.some(x=>x.id==='sfx-boom')).toBe(true);
      expect((await tool('make_sfx').run({name:'x',recipe:'pop',graph:'sine'} as never).catch(e=>({text:String(e)}))).text).toContain('not both');
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
