// Variants on text and graphic items: other versions kept on the item, one
// shown; choosing swaps them. Render draws only the one shown. No network.
import {afterAll,describe,expect,it} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkEditDoc,clipRefSchema,parseEditDoc} from '@voxtale/editdoc';
import {styleOf,type Job} from '../src/video/editor/agent/cut';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';
import type {FrameHost} from '../src/video/editor/agent/frames';
import {planRender} from '../src/video/render-edit';

const ref=clipRefSchema.parse({id:'c1',hash:createHash('sha256').update('c1').digest('hex'),name:'c1.mov',kind:'video',role:'a-roll',roleSource:'creator',
  duration:30,fps:{num:30,den:1},width:1920,height:1080,hasAudio:true});
const words='this is the one tool that saves you an hour every single day'.split(' ').map((text,id)=>({id,text,start:1+id*0.5,end:1.4+id*0.5}));
const job:Job={id:'j',name:'J',clips:[{ref,words}],style:styleOf(undefined)};
const host:FrameHost={filmstrip:async()=>new Uint8Array(),frames:async()=>[],joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''})};
const dirs:string[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});

async function workspace() {
  const dir=await mkdtemp(join(tmpdir(),'variants-'));dirs.push(dir);
  const ws=newWorkspace({dir,job,frames:host,graphics:true});
  const tool=(n:string)=>jobTools(ws).find(t=>t.name===n)!;
  await tool('set_cut').run({segments:[{clip:'c1',from:0,to:12}]});
  return {ws,tool};
}

describe('variants',()=>{
  it('text: add, choose swaps, moving keeps them, render shows the chosen one',async()=>{
    const {ws,tool}=await workspace();
    await tool('place_text').run({id:'save',template:'callout',text:'Saves an hour',clip:'c1',word:3,seconds:3,reason:'claim'});
    await tool('variants').run({kind:'text',id:'save',add:{text:'1 hour back, daily'}});
    const out=await tool('variants').run({kind:'text',id:'save',add:{text:'Your new favourite tool',template:'title'}});
    expect(out.text).toContain('2: [title] Your new favourite tool');
    let t=ws.doc!.tracks.text[0]!;
    expect(t.text).toBe('Saves an hour');
    expect(t.variants?.map(v=>v.text)).toEqual(['1 hour back, daily','Your new favourite tool']);
    await tool('variants').run({kind:'text',id:'save',choose:2});
    t=ws.doc!.tracks.text[0]!;
    expect([t.template,t.text]).toEqual(['title','Your new favourite tool']);
    expect(t.variants?.[1]).toMatchObject({template:'callout',text:'Saves an hour'});
    await tool('place_text').run({id:'save',template:'title',text:'Your new favourite tool',clip:'c1',word:5,seconds:3,reason:'moved'});
    expect(ws.doc!.tracks.text[0]!.variants).toHaveLength(2);
    const ass=planRender(ws.doc!,{[ref.hash]:'/x.mov'}).ass;
    expect(ass).toContain('Your new favourite tool');
    expect(ass).not.toContain('Saves an hour');
  });
  it('graphic: a rendered one only; choose swaps the shown asset, the handle stays',async()=>{
    const {ws,tool}=await workspace();
    ws.graphics={chart:{webm:'/chart.webm',seconds:3,place:'full'},bars:{webm:'/bars.webm',seconds:3,place:'right'}};
    await tool('place_graphic').run({id:'chart',clip:'c1',word:3,seconds:3,reason:'stat'});
    await expect(tool('variants').run({kind:'graphic',id:'chart',add:{graphic:'pie'}})).rejects.toThrow(/not rendered/);
    await tool('variants').run({kind:'graphic',id:'chart',add:{graphic:'bars'}});
    expect(ws.doc!.tracks.graphics[0]).toMatchObject({id:'g-chart',assetId:'chart',variants:[{assetId:'bars',placement:'right'}]});
    await tool('variants').run({kind:'graphic',id:'chart',choose:1});
    expect(ws.doc!.tracks.graphics[0]).toMatchObject({id:'g-chart',assetId:'bars',placement:'right',variants:[{assetId:'chart',placement:'full'}]});
    expect(planRender(ws.doc!,{[ref.hash]:'/x.mov'},{bars:'/bars.webm',chart:'/chart.webm'}).pictures.find(p=>p.itemId==='g-chart')!.path).toBe('/bars.webm');
  });
  it('a variant the same as another version is flagged',async()=>{
    const {ws,tool}=await workspace();
    await tool('place_text').run({id:'save',template:'callout',text:'Saves an hour',clip:'c1',word:3,seconds:3,reason:'claim'});
    const d=parseEditDoc(ws.doc!).doc;
    d.tracks.text[0]!.variants=[{text:'Saves an hour'}];
    expect(checkEditDoc(d).some(i=>i.severity==='warning'&&/Same as another version/.test(i.message))).toBe(true);
  });
});
