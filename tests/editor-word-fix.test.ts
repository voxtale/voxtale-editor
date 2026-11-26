// Caption word fixes: one fix per misheard word, keyed by the word's source
// time, shown by every caption from that clip through recuts. No network.
import {afterAll,describe,expect,it} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkEditDoc,clipRefSchema,fixWords,parseEditDoc} from '@voxtale/editdoc';
import {buildCut,styleOf,type Job} from '../src/video/editor/agent/cut';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';
import type {FrameHost} from '../src/video/editor/agent/frames';

const ref=clipRefSchema.parse({id:'c1',hash:createHash('sha256').update('c1').digest('hex'),name:'c1.mov',kind:'video',role:'a-roll',roleSource:'creator',
  duration:30,fps:{num:30,den:1},width:1920,height:1080,hasAudio:true});
// "we ship voxtail today ... voxtail is live": the product name misheard twice.
const said='we ship voxtail today and then later voxtail is live'.split(' ');
const words=said.map((text,id)=>({id,text,start:1+id*0.5,end:1.4+id*0.5}));
const job:Job={id:'j',name:'J',clips:[{ref,words}],style:styleOf(undefined)};
const capText=(d:ReturnType<typeof buildCut>)=>d.tracks.captions.map(c=>c.text).join(' ');
const dirs:string[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});

describe('word fixes',()=>{
  it('hold the word playing at their time, in their clip only',()=>{
    const ws=[...words.map(w=>({...w,clipId:'c1'})),{id:0,text:'voxtail',clipId:'c2',start:2,end:2.4}];
    const fixed=fixWords(ws,[{clipId:'c1',at:1.98,text:'VoxTale'}]);
    expect(fixed[2]!.text).toBe('VoxTale');
    expect(fixed.at(-1)!.text).toBe('voxtail');
    expect(fixed.filter(w=>w.text==='VoxTale')).toHaveLength(1);
  });
  it('every caption from the clip shows them, through a recut',()=>{
    const fixes=[{clipId:'c1',at:2,text:'VoxTale'},{clipId:'c1',at:4.5,text:'VoxTale'}];
    const all=buildCut(job,[{clip:'c1',from:0,to:9}],{captions:[{clip:'c1',from:0,to:9}],wordFixes:fixes});
    expect(capText(all)).not.toContain('voxtail');
    expect(capText(all).match(/VoxTale/g)).toHaveLength(2);
    expect(all.wordFixes).toEqual(fixes);
    const recut=buildCut(job,[{clip:'c1',from:6,to:9}],{captions:[{clip:'c1',from:6,to:9}],wordFixes:fixes});
    expect(capText(recut)).toContain('VoxTale is live');
  });
  it('checks: a known clip, one fix per word',()=>{
    const d=buildCut(job,[{clip:'c1',from:0,to:9}]);
    const bad=parseEditDoc({...d,wordFixes:[]}).doc;
    bad.wordFixes=[{clipId:'c9',at:1,text:'x'},{clipId:'c1',at:2,text:'a'},{clipId:'c1',at:2.01,text:'b'}];
    const msgs=checkEditDoc(bad).filter(i=>i.severity==='error').map(i=>i.message);
    expect(msgs.some(m=>/Unknown clip c9/.test(m))).toBe(true);
    expect(msgs.some(m=>/Two fixes/.test(m))).toBe(true);
  });
  it('fix_word: set once, shown in captions and get_transcript, undone with the original',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'word-fix-'));dirs.push(dir);
    const host:FrameHost={filmstrip:async()=>new Uint8Array(),frames:async()=>[],joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''})};
    const ws=newWorkspace({dir,job,frames:host,graphics:false});
    const tool=(n:string)=>jobTools(ws).find(t=>t.name===n)!;
    await tool('set_cut').run({segments:[{clip:'c1',from:0,to:9}]});
    await tool('set_captions').run({spans:[{clip:'c1',from:0,to:9}]});
    const out=await tool('fix_word').run({clip:'c1',word:2,text:'VoxTale'});
    expect(out.text).toContain('"voxtail" -> "VoxTale"');
    expect(capText(ws.doc!)).toContain('ship VoxTale today');
    expect(capText(ws.doc!)).toContain('later voxtail');
    // Same word again replaces the fix; the original text removes it.
    await tool('fix_word').run({clip:'c1',word:2,text:'Voxtale'});
    expect(ws.wordFixes).toHaveLength(1);
    expect((await tool('get_transcript').run({clip:'c1'})).text).toContain('2 "voxtail" -> "Voxtale"');
    await tool('fix_word').run({clip:'c1',word:2,text:'voxtail'});
    expect(ws.wordFixes).toEqual([]);
    expect(ws.doc!.wordFixes).toEqual([]);
  });
});
