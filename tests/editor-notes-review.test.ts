// Small REDACTED gaps: timed creator notes, finish replies, samey and brand
// review counts, ripple keeping music whole and shifting caption word times,
// and the notes/outside-text skill edit. All code, no model, no network.
import {afterAll,describe,expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipRefSchema,rippleClose,shiftTime,type ClipRef,type EditDoc} from '@voxtale/editdoc';

import {styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import type {FrameHost} from '../src/video/editor/agent/frames';
import {creatorNotes,noteReplies,notesBrief,placeNote,NOTE_REACH,REPLY_MAX} from '../src/video/editor/agent/notes';
import {brandNames,reviewCounts,reviewText} from '../src/video/editor/agent/review';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';

const ref=(id:string,role:ClipRef['role'],hash:string,over:Partial<ClipRef>={})=>clipRefSchema.parse({id,hash:hash.repeat(64),name:`${id}.mp4`,
  kind:'video',role,roleSource:'creator',duration:40,fps:{num:30,den:1},width:1920,height:1080,hasAudio:true,timecodeStart:0,...over});
const words=Array.from({length:60},(_,i)=>({id:i,text:i%10===9?`w${i}.`:`w${i}`,start:1+i*0.5,end:1.4+i*0.5}));
const host:FrameHost={filmstrip:async()=>new Uint8Array(),frames:async()=>[],joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''})};

const dirs:string[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});

async function start(over:Partial<Job>={}) {
  const dir=await mkdtemp(join(tmpdir(),'gaps-'));dirs.push(dir);
  const job:Job={id:'j',name:'Gaps',clips:[{ref:ref('c1','a-roll','a'),words},{ref:ref('c2','b-roll','b',{hasAudio:false,duration:30}),words:[]}] as JobClip[],style:styleOf(undefined),...over};
  const ws=newWorkspace({dir,job,frames:host,graphics:false});
  const tools=jobTools(ws);
  const run=async(name:string,args:unknown)=>tools.find(t=>t.name===name)!.run(args as never);
  const call=async(name:string,args:unknown)=>{const r=await run(name,args);if(r.isError)throw new Error(r.text);return r.text;};
  await call('set_cut',{segments:Array.from({length:6},(_,k)=>({clip:'c1',from:k*10,to:k*10+9}))});
  return {ws,call,run};
}

/** One a-roll piece playing c1 from 0 s, at output 0 s. */
const plain=()=>({tracks:{'a-roll':[{id:'a',clipId:'c1',status:'applied',in:0,out:40,start:0,end:40}]}}) as unknown as EditDoc;
const wordsOf=(id:string)=>id==='c1'?words:[];

describe('timed creator notes',()=>{
  test('inside a word: moves to its start, never mid-word',()=>{
    const p=placeNote(plain(),wordsOf,{id:'n1',at:1.2,text:'cut this'});
    expect(p).toMatchObject({t:1,clip:'c1',word:0});
    expect(p.said).toContain('| w0');
  });
  test('in a pause: to the nearer edge; after a word end it points at the next word',()=>{
    const p=placeNote(plain(),wordsOf,{id:'n2',at:1.43,text:'zoom'});
    expect(p.t).toBeCloseTo(1.4,2);
    expect(p.word).toBe(1);
    expect(p.said).toMatch(/w0 \| w1/);
  });
  test('no speech within reach: stays put, marked far',()=>{
    const at=30.9+NOTE_REACH+1;
    const p=placeNote(plain(),wordsOf,{id:'n3',at,text:'music up'});
    expect(p).toMatchObject({t:at,far:true,said:''});
    expect(notesBrief([p])).toContain('no speech near');
  });
  test('only shown creator notes count',()=>{
    const doc={markers:[
      {id:'m1',kind:'note',owner:'creator',status:'applied',time:3,title:'tighten'},
      {id:'m2',kind:'note',owner:'agent',status:'applied',time:4,title:'agent'},
      {id:'m3',kind:'chapter',owner:'creator',status:'applied',time:5,title:'Intro'},
      {id:'m4',kind:'note',owner:'creator',status:'suggested',time:6,title:'hidden'}]} as unknown as EditDoc;
    expect(creatorNotes(doc)).toEqual([{id:'m1',at:3,text:'tighten'}]);
  });
  test('replies: one clean line each, unknown ids dropped, missing listed',()=>{
    const notes=[{id:'a',at:1,text:'x'},{id:'b',at:2,text:'y'}];
    const r=noteReplies(notes,[{id:'a',reply:'Cut  the\nrepeat at 12.0s'},{id:'zz',reply:'stray'},{id:'a',reply:'second'}]);
    expect(r.replies).toEqual([{id:'a',reply:'Cut the repeat at 12.0s'}]);
    expect(r.missing).toEqual(['b']);
    expect(noteReplies(notes,[{id:'b',reply:'x'.repeat(500)}]).replies[0]!.reply).toHaveLength(REPLY_MAX);
  });
  test('finish asks once for missing note replies, then lets the edit end',async()=>{
    const note={id:'n1',at:5,text:'cut this',t:5,said:''};
    const {run}=await start({notes:[note]});
    const first=await run('finish',{summary:'Cut the pauses and the repeated line.'});
    expect(first.isError).toBe(true);
    expect(first.text).toContain('n1');
    const second=await run('finish',{summary:'Cut the pauses and the repeated line.'});
    expect(second.text).not.toContain('No reply for note');
  });
});

describe('review counts: samey and brand',()=>{
  test('one text template over a third of 6+ cards is samey',async()=>{
    const {ws,call}=await start();
    for(let k=0;k<6;k++)await call('place_text',{id:`t${k}`,template:'callout',text:`Card ${k}`,clip:'c1',word:k*10+2,seconds:2,reason:'x'});
    const rows=reviewCounts(ws.doc!,wordsOf);
    expect(rows.filter(r=>r.kind==='samey')).toHaveLength(1);
    expect(reviewText(rows)).toContain('samey 1');
  });
  test('brand names come from logo file names',()=>{
    expect(brandNames(['dropbox-logo.png','Acme_Corp icon.svg','a1b2c3d4e5f6a7b8.png'])).toEqual(['dropbox','acme corp']);
  });
  test('a brand said with no logo on screen is counted; its name on screen clears it',async()=>{
    const {ws,call}=await start();
    const doc=structuredClone(ws.doc!);
    doc.clips.push(ref('lg','logo','c',{name:'dropbox-logo.png',kind:'image',hasAudio:false}));
    const said=words.map(w=>w.id===21?{...w,text:'Dropbox,'}:w);
    const of=(id:string)=>id==='c1'?said:[];
    expect(reviewCounts(doc,of).filter(r=>r.kind==='brand')).toHaveLength(1);
    // Said as two words counts too.
    const split=words.map(w=>w.id===21?{...w,text:'drop'}:w.id===22?{...w,text:'box'}:w);
    expect(reviewCounts(doc,id=>id==='c1'?split:[]).filter(r=>r.kind==='brand')).toHaveLength(1);
    ws.doc=doc;
    await call('place_text',{id:'db',template:'callout',text:'Dropbox',clip:'c1',word:21,seconds:2,reason:'brand'});
    expect(reviewCounts(ws.doc!,of).filter(r=>r.kind==='brand')).toHaveLength(0);
  });
});

describe('ripple close',()=>{
  test('shiftTime: after the cut moves back, inside lands on the cut, before stays',()=>{
    expect(shiftTime(1,2,3)).toBe(1);
    expect(shiftTime(2.5,2,3)).toBe(2);
    expect(shiftTime(4,2,3)).toBe(3);
  });
  test('music that starts inside the cut keeps its source start; caption word times shift',async()=>{
    const {ws}=await start();
    const doc=structuredClone(ws.doc!);
    const base={owner:'agent' as const,status:'applied' as const};
    doc.tracks.music=[{...base,id:'m',clipId:'c2',start:5,end:15,in:0,out:10,gainDb:-24,fadeIn:1,fadeOut:2,duck:true}] as never;
    doc.tracks.captions=[{...base,id:'cap',text:'one two three',words:['c1:0','c1:1','c1:2'],start:1,end:5,wordStarts:[0,1.5,3.5]}] as never;
    const out=rippleClose(doc,2,8);
    const m=out.tracks.music[0]!;
    // 3 s of it sat in the cut: it slides to the cut and plays from its own start, not from 3 s in.
    expect([m.start,m.end,m.in,m.out]).toEqual([2,12,0,10]);
    const c=rippleClose(doc,2,3).tracks.captions[0]!;
    expect([c.start,c.end]).toEqual([1,4]);
    expect(c.wordStarts).toEqual([0,1,2.5]);
  });
});

describe('skill v28',()=>{
  test('is the active editor skill and names the tools the four branches added',async()=>{
    const {AGENT_SKILL_PROMPT_ID}=await import('../src/video/editor/agent/skill');
    const {listPrompts,promptText,promptTextVersion}=await import('../src/services/prompts');
    expect(listPrompts().find(p=>p.id===AGENT_SKILL_PROMPT_ID)?.active).toBe(28);
    const skill=promptText(AGENT_SKILL_PROMPT_ID);
    expect(skill).toBe(promptTextVersion(AGENT_SKILL_PROMPT_ID,28));
    expect(skill).not.toBe(promptTextVersion(AGENT_SKILL_PROMPT_ID,27));
    for(const t of ['finish','styles','use_style','learn_style','create_style','add_style_file','propose_rule','decide_rule',
      'set_angles','set_av_offset','set_look','make_graphic','list_scenes','write_scene','render_scene','behindSubject'])expect(skill).toContain(t);
  });
  test('the local guide carries the live skill',async()=>{
    const {AGENT_SKILL_PROMPT_ID}=await import('../src/video/editor/agent/skill');
    const {promptText}=await import('../src/services/prompts');
    const {editingGuide}=await import('../src/video/editor/local-mcp/guide');
    expect(editingGuide(false,true).startsWith(promptText(AGENT_SKILL_PROMPT_ID))).toBe(true);
  });
});
