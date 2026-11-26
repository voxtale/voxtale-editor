// Edit versions (new, restore, trash), the text timeline and find_words. No
// network, no footage: the Trash is a fake.
import {afterAll,describe,expect,it} from 'bun:test';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipRefSchema,type EditDoc} from '@voxtale/editdoc';
import {buildCut,styleOf,type Job} from '../src/video/editor/agent/cut';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';
import type {FrameHost} from '../src/video/editor/agent/frames';
import {findWordsText,heardWords,timelineText} from '../src/video/editor/agent/timeline-text';
import {mcpHandler,type Rpc} from '../src/video/editor/agent/mcp-protocol';
import {localEditorServer} from '../src/video/editor/local-mcp/server';
import {newVersion,readVersions,restoreVersion,trashScratch,trashVersions,versionsText} from '../src/video/editor/local-mcp/versions';

const ref=(id:string,role:'a-roll'|'b-roll')=>clipRefSchema.parse({id,hash:createHash('sha256').update(id).digest('hex'),name:`${id}.mov`,kind:'video',role,roleSource:'creator',
  duration:30,fps:{num:30,den:1},width:1920,height:1080,hasAudio:true});
const said='we ship the budget today and then later the budget is live'.split(' ');
const words=said.map((text,id)=>({id,text,start:1+id*0.5,end:1.4+id*0.5}));
const job:Job={id:'j',name:'J',clips:[{ref:ref('c1','a-roll'),words},{ref:ref('c2','b-roll'),words:[{id:0,text:'Budget,',start:2,end:2.4}]}],style:styleOf(undefined)};
const dirs:string[]=[];
const scratch=async()=>{const d=await mkdtemp(join(tmpdir(),'versions-'));dirs.push(d);return d;};
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});

describe('find_words: output time',()=>{
  // Second half first, then the opening: words 7-11 play before words 0-3.
  const doc=buildCut(job,[{clip:'c1',from:7,to:11},{clip:'c1',from:0,to:3}]);
  const [late,early]=doc.tracks['a-roll'];
  it('maps each word through the cut',()=>{
    const heard=heardWords(doc,job);
    const live=heard.find(w=>w.text==='live')!;
    expect(live.start).toBeCloseTo(late!.start+(words[11]!.start-late!.in),2);
    const ship=heard.find(w=>w.text==='ship')!;
    expect(ship.start).toBeCloseTo(early!.start+(words[1]!.start-early!.in),2);
    expect(ship.start).toBeGreaterThan(live.start);
    expect(heard.some(w=>w.text==='today')).toBe(false);
  });
  it('finds a phrase every place it is heard, ignoring case and punctuation',()=>{
    const t=findWordsText(doc,job,['The BUDGET','today','nowhere']);
    expect(t.match(/"The BUDGET": /g)).toHaveLength(2);
    expect(t).toContain('c1 words 8-9');
    expect(t).toContain('c1 words 2-3');
    expect(t).toContain('"today": not heard in this cut (said in the source, but cut)');
    expect(t).toContain('"nowhere": not heard in this cut (not in any transcript as written)');
  });
  it('follows footage speed when its sound plays',()=>{
    const b={id:'b1',clipId:'c2',in:1,out:5,start:10,end:12,speed:2,muted:false,owner:'agent',status:'applied'};
    const sped={...doc,tracks:{...doc.tracks,'b-roll':[b]}} as unknown as EditDoc;
    const w=heardWords(sped,job).find(x=>x.clipId==='c2')!;
    expect(w.start).toBeCloseTo(10.5,5);   // source 2s, 1s into the item at 2x = 0.5s of output
    expect(w.end).toBeCloseTo(10.7,5);
    const muted={...doc,tracks:{...doc.tracks,'b-roll':[{...b,muted:true}]}} as unknown as EditDoc;
    expect(heardWords(muted,job).some(x=>x.clipId==='c2')).toBe(false);
  });
});

describe('timeline: one line per item',()=>{
  const doc=buildCut(job,[{clip:'c1',from:0,to:5},{clip:'c1',from:9,to:11}],{captions:[{clip:'c1',from:0,to:5}]});
  it('lists every track and item with words and source in',()=>{
    const t=timelineText(doc,job);
    expect(t.split('\n')[0]).toMatch(/^1920x1080, 30 fps/);
    expect(t).toContain('a-roll (2)');
    expect(t).toMatch(/c1 "c1\.mov" "we ship the budget today and" \(words 0-5\)/);
    expect(t).toContain('captions (');
    expect(t).toMatch(/^empty: .*b-roll/m);
  });
  it('at: only what sits under that second, with its source time',()=>{
    const second=doc.tracks['a-roll'][1]!;
    const at=second.start+0.5;
    const t=timelineText(doc,job,{at});
    expect(t).toContain(`· at ${at.toFixed(2)}: ${(second.in+0.5).toFixed(2)} in c1`);
    expect(t).not.toContain('b-roll');
    expect(t.match(/^  \S+  c1 /gm)).toHaveLength(1);
  });
  it('tools: timeline and find_words read the current cut',async()=>{
    const host:FrameHost={filmstrip:async()=>new Uint8Array(),frames:async()=>[],joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''})};
    const ws=newWorkspace({dir:await scratch(),job,frames:host,graphics:false});
    const tool=(n:string)=>jobTools(ws).find(t=>t.name===n)!;
    await expect(tool('timeline').run({})).rejects.toThrow('set_cut first');
    await tool('set_cut').run({segments:[{clip:'c1',from:7,to:11}]});
    expect((await tool('timeline').run({tracks:['a-roll']})).text).toContain('a-roll (1)');
    expect((await tool('find_words').run({phrases:['is live']})).text).toMatch(/"is live": \d+\.\d\d → \d+\.\d\d s output · c1 words 10-11/);
  });
});

describe('edit versions',()=>{
  const at=async(dir:string,edit:string)=>{
    await mkdir(dir,{recursive:true});
    for(const f of ['project.json','state.json','session.json'])await writeFile(join(dir,f),JSON.stringify({f,edit}));
    await writeFile(join(dir,'edit.json'),edit);
  };
  it('new_version keeps the edit as it was and goes on from an exact copy',async()=>{
    const d=await scratch();
    await at(d,'cut A');
    const i=await newVersion(d,'tighter hook',new Date('2026-11-26T10:00:00Z'));
    expect(i.current).toBe(2);
    expect(await readFile(join(d,'versions','v1','edit.json'),'utf8')).toBe('cut A');
    expect(await readFile(join(d,'edit.json'),'utf8')).toBe('cut A');
    await writeFile(join(d,'edit.json'),'cut B');
    expect(await readFile(join(d,'versions','v1','edit.json'),'utf8')).toBe('cut A');
    expect(versionsText(await readVersions(d))).toBe('v1  2026-11-26 10:00\nv2  working  tighter hook');
  });
  it('restore_version freezes the working edit, then brings the old one back as the next number',async()=>{
    const d=await scratch();
    await at(d,'cut A');
    await newVersion(d);
    await writeFile(join(d,'edit.json'),'cut B');
    await expect(restoreVersion(d,2)).rejects.toThrow('working version already');
    await expect(restoreVersion(d,7)).rejects.toThrow('no version 7');
    const i=await restoreVersion(d,1,'before the music');
    expect(i.current).toBe(3);
    expect(await readFile(join(d,'edit.json'),'utf8')).toBe('cut A');
    expect(await readFile(join(d,'versions','v2','edit.json'),'utf8')).toBe('cut B');
    expect(versionsText(i)).toContain('v3  working  restored from v1  before the music');
    // Going forward again is one more restore.
    await restoreVersion(d,2);
    expect(await readFile(join(d,'edit.json'),'utf8')).toBe('cut B');
  });
  it('a version with no cut yet restores with no cut',async()=>{
    const d=await scratch();
    await at(d,'x');
    await rm(join(d,'edit.json'));
    await newVersion(d);
    await writeFile(join(d,'edit.json'),'cut');
    await restoreVersion(d,1);
    expect(existsSync(join(d,'edit.json'))).toBe(false);
  });
  it('trash: frozen versions and scratch stills only, never the working one',async()=>{
    const d=await scratch(),sent:string[]=[];
    const trash=async(f:string)=>{sent.push(f);await rm(f,{recursive:true,force:true});};
    await at(d,'a');await newVersion(d);await newVersion(d);
    await expect(trashVersions(d,[3],trash)).rejects.toThrow('working version');
    await expect(trashVersions(d,[9],trash)).rejects.toThrow('no frozen version 9');
    const r=await trashVersions(d,[1],trash);
    expect(r.trashed).toEqual([1]);
    expect(sent).toEqual([join(d,'versions','v1')]);
    expect(versionsText(r.index)).toContain('in the Trash: v1');
    await expect(restoreVersion(d,1)).rejects.toThrow('in the Trash');
    await mkdir(join(d,'preview','3'),{recursive:true});await writeFile(join(d,'preview','3','a.jpg'),'');
    await expect(trashScratch(d,['transcripts/x.json'],trash)).rejects.toThrow('refused');
    await expect(trashScratch(d,['../../etc'],trash)).rejects.toThrow('refused');
    expect(await trashScratch(d,'all',trash)).toEqual(['preview']);
    expect(existsSync(join(d,'state.json'))).toBe(true);
  });
  it('the local MCP lists the version tools',async()=>{
    const answer=mcpHandler(localEditorServer({folder:await scratch(),graphics:false},()=>()=>{}));
    const req=(method:string):Rpc=>({jsonrpc:'2.0',id:1,method,params:{}});
    const names=((await answer(req('tools/list')) as any).result.tools as {name:string}[]).map(t=>t.name);
    for(const n of ['new_version','versions','restore_version','trash','timeline','find_words'])expect(names).toContain(n);
  });
});
