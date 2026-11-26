// Frame checks after an edit: where to look (changed moments), can the text be
// read (WCAG contrast, safe margin), and the review counts. All code, no model.
import {afterAll,describe,expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipRefSchema,type ClipRef,type EditDoc} from '@voxtale/editdoc';

import {changedMoments,CHANGED_MAX} from '../src/video/editor/agent/changes';
import {styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import type {FrameHost} from '../src/video/editor/agent/frames';
import {clearLetters,contrast,legibilityAt,legibilityWarnings,luminance,measure,MIN_CONTRAST,type RGB} from '../src/video/editor/agent/legible';
import {ff} from '../src/video/editor/agent/look';
import {BARE_MAX,reviewCounts,reviewText} from '../src/video/editor/agent/review';
import {jobTools,newWorkspace} from '../src/video/editor/agent/session';

const ref=(id:string,role:ClipRef['role'],hash:string,over:Partial<ClipRef>={})=>clipRefSchema.parse({id,hash:hash.repeat(64),name:`${id}.mp4`,
  kind:'video',role,roleSource:'creator',duration:40,fps:{num:30,den:1},width:1920,height:1080,hasAudio:true,timecodeStart:0,...over});
const words=Array.from({length:60},(_,i)=>({id:i,text:i%10===9?`w${i}.`:`w${i}`,start:1+i*0.5,end:1.4+i*0.5}));
const job=():Job=>({id:'j',name:'Checks',clips:[{ref:ref('c1','a-roll','a'),words},{ref:ref('c2','b-roll','b',{hasAudio:false,duration:30}),words:[]}] as JobClip[],style:styleOf(undefined)});
const host:FrameHost={filmstrip:async()=>new Uint8Array(),frames:async()=>[],joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''})};

const dirs:string[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});

async function start() {
  const dir=await mkdtemp(join(tmpdir(),'checks-'));dirs.push(dir);
  const ws=newWorkspace({dir,job:job(),frames:host,graphics:false});
  const tools=jobTools(ws);
  const call=async(name:string,args:unknown)=>{
    const r=await tools.find(t=>t.name===name)!.run(args as never);
    if(r.isError)throw new Error(r.text);
    return r.text;
  };
  await call('set_cut',{segments:Array.from({length:6},(_,k)=>({clip:'c1',from:k*10,to:k*10+9}))});
  return {ws,call};
}

describe('changed moments',()=>{
  test('same doc: nothing; a new text card: one frame just after it enters',async()=>{
    const {ws,call}=await start();
    const before=structuredClone(ws.doc!);
    expect(changedMoments(before,ws.doc!)).toEqual([]);
    await call('place_text',{id:'big',template:'callout',text:'Forty percent',clip:'c1',word:12,seconds:3,reason:'number'});
    const t=ws.doc!.tracks.text.find(x=>x.id==='t-big')!;
    const m=changedMoments(before,ws.doc!);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({rank:1});
    expect(m[0]!.t).toBeCloseTo(t.start+0.8,1);
  });
  test('framing first, capped, no two frames within 0.3 s',async()=>{
    const {ws,call}=await start();
    const before=structuredClone(ws.doc!);
    for(let k=0;k<6;k++)await call('place_text',{id:`t${k}`,template:'callout',text:`Card ${k}`,clip:'c1',word:k*10+2,seconds:2,reason:'x'});
    await call('set_zooms',{spans:[{clip:'c1',from:40,to:46,why:'thesis'}]});
    const m=changedMoments(before,ws.doc!);
    expect(m.length).toBe(CHANGED_MAX);
    expect(m.some(x=>x.rank===0)).toBe(true);
    for(let k=1;k<m.length;k++)expect(m[k]!.t-m[k-1]!.t).toBeGreaterThanOrEqual(0.3);
  });
  test('a caption look change picks one line mid-sentence',async()=>{
    const {ws,call}=await start();
    await call('set_captions',{spans:[{clip:'c1',from:0,to:59}]});
    const before=structuredClone(ws.doc!);
    const after=structuredClone(ws.doc!);
    after.styleRef.snapshot.brand.captionStyle={...after.styleRef.snapshot.brand.captionStyle,color:'#ff0000'};
    const m=changedMoments(before,after);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({rank:2,why:'caption look changed'});
    const line=after.tracks.captions.find(c=>c.start<=m[0]!.t&&m[0]!.t<c.end)!;
    expect(Math.abs(m[0]!.t-(line.start+line.end)/2)).toBeLessThan(0.02);
  });
});

describe('contrast maths',()=>{
  test('WCAG luminance and ratio',()=>{
    expect(contrast(luminance(255,255,255),luminance(0,0,0))).toBeCloseTo(21,5);
    expect(contrast(luminance(255,212,0),luminance(255,255,255))).toBeLessThan(1.5);
    expect(contrast(luminance(255,212,0),luminance(0,0,0))).toBeGreaterThan(MIN_CONTRAST);
  });
  const frame=(w:number,h:number,paint:(x:number,y:number)=>[number,number,number]):RGB=>{
    const data=new Uint8Array(w*h*3);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)data.set(paint(x,y),(y*w+x)*3);
    return {width:w,height:h,data};
  };
  const white=():[number,number,number]=>[255,255,255],yellow:[number,number,number]=[255,212,0];
  const inBlock=(x:number,y:number)=>x>=40&&x<60&&y>=20&&y<30;
  test('yellow letters straight on white fail; the same letters with a black outline pass',()=>{
    const bare=frame(100,50,white);
    const full=frame(100,50,(x,y)=>inBlock(x,y)?yellow:white());
    const m=measure(bare,full,bare,0.05)!;
    expect(m.ratio).toBeLessThan(MIN_CONTRAST);
    expect(m.text).toBe('#ffd400');
    expect(m.behind).toBe('#ffffff');
    const ring=(x:number,y:number)=>x>=36&&x<64&&y>=16&&y<34;
    const outlined=frame(100,50,(x,y)=>inBlock(x,y)?yellow:ring(x,y)?[0,0,0]:white());
    const clear=frame(100,50,(x,y)=>ring(x,y)&&!inBlock(x,y)?[0,0,0]:white());
    expect(measure(bare,outlined,clear,0.05)!.ratio).toBeGreaterThan(MIN_CONTRAST);
  });
  test('text at the frame edge is flagged',()=>{
    const bare=frame(100,50,white);
    const full=frame(100,50,(x,y)=>x<3&&y>10&&y<20?[0,0,0]:white());
    const m=measure(bare,full,bare,0.05)!;
    expect(m.edges).toEqual(['left']);
    expect(legibilityWarnings([{label:'text "x"',m}]).join()).toContain('NEAR THE EDGE');
  });
  test('clearLetters turns every fill clear and keeps outlines',()=>{
    const ass='Dialogue: 0,0:00:00.00,0:00:01.00,Plain,,0,0,0,,{\\an5\\pos(1,1)\\c&H00FFFF&\\1a&H00&\\bord3}Hi';
    const out=clearLetters(ass);
    expect(out).toContain('\\1a&HFF&');
    expect(out).not.toContain('\\1a&H00&');
    expect(out).toContain('\\bord3');
  });
});

// Needs an ffmpeg with libass (Homebrew's ffmpeg-full); skipped where there is none.
const FULL='/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const hasAss=existsSync(FULL)||!!process.env.SUPERTALE_FFMPEG;
describe.skipIf(!hasAss)('legibility drawn by libass',()=>{
  test('a yellow card on a white frame is flagged; on black it is not',async()=>{
    const was=process.env.SUPERTALE_FFMPEG;
    process.env.SUPERTALE_FFMPEG??=FULL;
    try {
      const {ws,call}=await start();
      await call('place_text',{id:'card',template:'callout',text:'Forty percent',clip:'c1',word:12,seconds:3,reason:'number'});
      const doc:EditDoc=structuredClone(ws.doc!);
      const t=doc.tracks.text.find(x=>x.id==='t-card')!;
      t.look={color:'#FFD400',backgroundColor:'none'};
      const dir=ws.dir,size={width:640,height:360};
      const rows=async(colour:string)=>{
        const frame=join(dir,`${colour}.png`);
        await ff(['-f','lavfi','-i',`color=${colour}:s=640x360`,'-frames:v','1',frame]);
        return legibilityAt({ff,doc,t:t.start+0.8,frame,size,dir});
      };
      const onWhite=await rows('white');
      expect(onWhite).toHaveLength(1);
      expect(onWhite[0]!.m.ratio).toBeLessThan(MIN_CONTRAST);
      expect(legibilityWarnings(onWhite).join()).toContain('LOW CONTRAST');
      const onBlack=await rows('black');
      expect(onBlack[0]!.m.ratio).toBeGreaterThan(MIN_CONTRAST);
    } finally {
      if(was===undefined)delete process.env.SUPERTALE_FFMPEG;else process.env.SUPERTALE_FFMPEG=was;
    }
  },30_000);
});

describe('review counts',()=>{
  test('a cut with nothing on screen is one long bare stretch; adding visuals splits it',async()=>{
    const {ws,call}=await start();
    const w=(id:string)=>id==='c1'?words:[];
    const bare=reviewCounts(ws.doc!,w).filter(r=>r.kind==='bare');
    expect(bare).toHaveLength(1);
    expect(bare[0]!.seconds).toBeGreaterThan(BARE_MAX);
    await call('place_text',{id:'a',template:'callout',text:'One',clip:'c1',word:15,seconds:2,reason:'x'});
    await call('place_text',{id:'b',template:'callout',text:'Two',clip:'c1',word:35,seconds:2,reason:'x'});
    await call('place_text',{id:'c',template:'callout',text:'Three',clip:'c1',word:52,seconds:2,reason:'x'});
    expect(reviewCounts(ws.doc!,w).filter(r=>r.kind==='bare')).toHaveLength(0);
  });
  test('kept pause, reuse and brief are each measured',async()=>{
    const {ws}=await start();
    const doc=structuredClone(ws.doc!);
    // A 1.5 s hole between two heard words.
    const gapped=words.map(x=>x.id>=20?{...x,start:x.start+1.5,end:x.end+1.5}:x);
    const a=doc.tracks['a-roll'];
    const last=a.at(-1)!;
    a.splice(0,a.length,{...a[0]!,in:0,out:last.out+1.5,start:0,end:last.out+1.5});
    const base={owner:'agent' as const,status:'applied' as const,clipId:'c2',gainDb:0,fit:'cover' as const};
    doc.tracks['b-roll']=[{...base,id:'b-1',start:2,end:4,in:5,out:7},{...base,id:'b-2',start:10,end:11,in:6,out:7}] as never;
    const rows=reviewCounts(doc,id=>id==='c1'?gapped:[]);
    expect(rows.filter(r=>r.kind==='pause')).toHaveLength(1);
    expect(rows.find(r=>r.kind==='pause')!.seconds).toBeCloseTo(1.6,1);
    expect(rows.filter(r=>r.kind==='reuse')).toHaveLength(1);
    expect(rows.filter(r=>r.kind==='brief').map(r=>r.what).join()).toContain('b-2');
    expect(reviewText(rows)).toContain('information, not problems');
  });
  test('check_cut carries the counts',async()=>{
    const {call}=await start();
    expect(await call('check_cut',{})).toContain('review counts');
  });
});
