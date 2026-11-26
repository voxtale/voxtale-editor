import {afterAll,beforeAll,describe,expect,it} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pipBox,newEditDoc,parseEditDoc,renderClipHashes,STYLE_PRESETS,type ClipRef,type EditDoc} from '@voxtale/editdoc';
import {assScript,keyedExpr,MissingMediaError,planRender,renderEditDoc,subjectSpans,type SubjectMasker} from '../src/video/render-edit';

const hasFfmpeg=Bun.spawnSync(['ffmpeg','-version']).exitCode===0;
const fps={num:30,den:1};
const W=426,H=240;
const hash=(c:string)=>c.repeat(64);
const clip=(id:string,role:ClipRef['role'],c:string,over:Partial<ClipRef>={}):ClipRef=>({
  id,hash:hash(c),name:`${id}.mp4`,kind:role==='music'?'audio':'video',role,roleSource:'creator',
  duration:10,fps,hasAudio:true,timecodeStart:0,width:W,height:H,...over,
});

function doc(over:Record<string,unknown[]>={}):EditDoc {
  const d=newEditDoc({id:'ed1',name:'Render test',clips:[clip('red','a-roll','a'),clip('blue','a-roll','b'),clip('box','b-roll','c',{hasAudio:false}),clip('bed','music','d')],fps,style:STYLE_PRESETS.tutorial});
  return parseEditDoc({
    ...d,
    canvas:{width:W,height:H},
    tracks:{
      ...d.tracks,
      'a-roll':[
        {id:'a1',clipId:'red',in:0,out:2,start:0,end:2,owner:'agent'},
        {id:'a2',clipId:'blue',in:1,out:3,start:2,end:4,owner:'agent'},
      ],
      zoom:[{id:'z1',start:2,end:4,owner:'agent',scale:2,easeIn:0,easeOut:0}],
      'b-roll':[{id:'b1',clipId:'box',in:0,out:0.5,start:1,end:1.5,owner:'agent'}],
      music:[{id:'m1',clipId:'bed',in:0,out:4,start:0,end:4,owner:'agent',gainDb:-20,duck:true}],
      ...over,
    },
  }).doc;
}

describe('planRender',()=>{
  it('names clips with no file',()=>{
    expect(()=>planRender(doc(),{[hash('a')]:'/x/red.mp4'})).toThrow(MissingMediaError);
  });
  it('draws bottom first on the frame grid, and ends with the last item',()=>{
    const media={[hash('a')]:'/r',[hash('b')]:'/b',[hash('c')]:'/c',[hash('d')]:'/d'};
    const p=planRender(doc(),media);
    expect(p.frames).toBe(120);
    expect(p.pictures.map(x=>[x.itemId,x.fs,x.fe])).toEqual([['a1',0,60],['a2',60,120],['b1',30,45]]);
    expect(p.sounds.map(s=>s.path)).toEqual(['/r','/b','/d']);
    expect(p.sounds[2]!.duck.length).toBeGreaterThan(0);
  });
  it('needs exactly the clips renderClipHashes names (the cloud upload list)',()=>{
    const d=doc({'b-roll':[{id:'b1',clipId:'box',in:0,out:0.5,start:1,end:1.5,owner:'agent',status:'suggested'}]});
    const need=renderClipHashes(d);
    expect(need.sort()).toEqual([hash('a'),hash('b'),hash('d')]);
    expect(()=>planRender(d,Object.fromEntries(need.map(h=>[h,'/x'])))).not.toThrow();
  });
  it('leaves out graphics still rendering',()=>{
    const media={[hash('a')]:'/r',[hash('b')]:'/b',[hash('c')]:'/c',[hash('d')]:'/d'};
    const p=planRender(doc({graphics:[{id:'g1',assetId:'ga-1',start:0,end:1,owner:'agent'}]}),media);
    expect(p.skipped).toEqual([{itemId:'g1',reason:'graphic-not-ready'}]);
  });
  it('behind the speaker: spans skip full-frame b-roll; the masked a-roll goes over the graphic, or it is reported',()=>{
    const media={[hash('a')]:'/r',[hash('b')]:'/b',[hash('c')]:'/c',[hash('d')]:'/d'};
    const d=doc({graphics:[{id:'g1',assetId:'ga-1',start:0.5,end:2.5,owner:'agent',behindSubject:true}]});
    const spans=subjectSpans(d);
    expect(spans.map(x=>[x.arollId,x.start,x.end,x.srcStart])).toEqual([['a1',0.5,1,0.5],['a1',1.5,2,1.5],['a2',2,2.5,1]]);
    const bare=planRender(d,media,{'ga-1':'/g.webm'});
    expect(bare.skipped).toEqual([{itemId:'g1',reason:'subject-mask-missing'}]);
    expect(bare.pictures.some(p=>p.mask)).toBe(false);
    const masks=Object.fromEntries(spans.map((x,k)=>[x.key,{path:`/m${k}.avi`,in:x.srcStart}]));
    const p=planRender(d,media,{'ga-1':'/g.webm'},{},masks);
    expect(p.skipped).toEqual([]);
    const ids=p.pictures.map(x=>x.itemId);
    expect(ids.slice(ids.indexOf('g1'))).toEqual(['g1','g1.subject.a2','g1.subject.a1','g1.subject.a1']);
    const a2=p.pictures.find(x=>x.itemId==='g1.subject.a2')!;
    expect([a2.fs,a2.fe,a2.path,a2.zoom.length>0,a2.mask?.path]).toEqual([60,75,'/b',true,'/m2.avi']);
    // Not marked: nothing changes.
    expect(planRender(doc({graphics:[{id:'g1',assetId:'ga-1',start:0.5,end:2.5,owner:'agent'}]}),media,{'ga-1':'/g.webm'},{},masks).pictures.some(x=>x.mask)).toBe(false);
  });
  it('writes text and captions as ASS events on frame edges',()=>{
    const d=doc({
      text:[{id:'t1',start:1,end:2,text:'Hello {x}',template:'callout',owner:'agent'}],
      captions:[{id:'c1',start:0,end:1,text:'Here is why',words:['red:0'],owner:'agent'}],
    });
    const ass=assScript(d,30);
    expect(ass).toContain(`PlayResX: ${W}`);
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.98,0:00:01\.98,Box,.*Hello \(x\)/);
    expect(ass).toMatch(/Dialogue: 1,0:00:00\.00,0:00:00\.98,Box,.*Here is why/);
  });
});

describe('keyedExpr',()=>{
  const evalAt=(expr:string,u:number)=>Function('u',`const lt=(a,b)=>a<b?1:0,gte=(a,b)=>a>=b?1:0,min=Math.min,max=Math.max,if_=(c,a,b)=>c?a:b;return ${expr.replace(/\bif\(/g,'if_(').replaceAll('(u)','u')}`)(u) as number;
  it('matches linear, eased and held keys',()=>{
    const keys=[{time:0,value:1,easing:'ease-in-out' as const},{time:1,value:2,easing:'linear' as const},{time:2,value:3,easing:'hold' as const},{time:3,value:1,easing:'hold' as const}];
    const e=keyedExpr(keys,'(u)');
    expect(evalAt(e,-1)).toBe(1);
    expect(evalAt(e,0.25)).toBeCloseTo(1.125);
    expect(evalAt(e,0.75)).toBeCloseTo(1.875);
    expect(evalAt(e,1.5)).toBeCloseTo(2.5);
    expect(evalAt(e,2.5)).toBe(3);
    expect(evalAt(e,9)).toBe(1);
  });
  it('drops segments outside the window',()=>{
    const keys=[0,1,2,3,4].map(t=>({time:t,value:t+1,easing:'linear' as const}));
    expect(keyedExpr(keys,"u",2.2,2.8).match(/gte\(/g)).toHaveLength(1);
  });
});

async function ff(args:string[]) {
  const p=Bun.spawn(['ffmpeg','-hide_banner','-loglevel','error','-y',...args],{stderr:'pipe',stdout:'pipe'});
  const out=new Uint8Array(await new Response(p.stdout).arrayBuffer());
  const err=await new Response(p.stderr).text();
  if(await p.exited!==0)throw new Error(err);
  return out;
}
/** One frame as gray bytes. */
const frame=(file:string,n:number)=>ff(['-i',file,'-vf',`select=eq(n\\,${n}),format=gray`,'-frames:v','1','-f','rawvideo','-']);
const mean=(b:Uint8Array)=>b.reduce((s,x)=>s+x,0)/b.length;
const bright=(b:Uint8Array)=>b.filter(x=>x>128).length;

describe.skipIf(!hasFfmpeg)('renderEditDoc',()=>{
  let dir='';
  const media:Record<string,string>={};
  beforeAll(async()=>{
    dir=await mkdtemp(join(tmpdir(),'vt-render-'));
    // red: bright, with a tone. blue: black with a small white square in the middle, silent. box: white.
    media[hash('a')]=join(dir,'red.mp4');
    media[hash('b')]=join(dir,'blue.mp4');
    media[hash('c')]=join(dir,'box.mp4');
    media[hash('d')]=join(dir,'bed.wav');
    await ff(['-f','lavfi','-i',`color=c=0xC0C0C0:s=${W}x${H}:r=30:d=10`,'-f','lavfi','-i','sine=f=440:r=48000:d=10','-ac','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',media[hash('a')]!]);
    await ff(['-f','lavfi','-i',`color=c=black:s=${W}x${H}:r=30:d=10`,'-f','lavfi','-i','anullsrc=r=48000:cl=mono','-vf',`drawbox=x=${W/2-20}:y=${H/2-20}:w=40:h=40:c=white:t=fill`,'-t','10','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',media[hash('b')]!]);
    await ff(['-f','lavfi','-i',`color=c=white:s=${W}x${H}:r=30:d=10`,'-c:v','libx264','-pix_fmt','yuv420p',media[hash('c')]!]);
    await ff(['-f','lavfi','-i','sine=f=220:r=48000:d=10','-ac','2',media[hash('d')]!]);
  },60_000);
  afterAll(async()=>{await rm(dir,{recursive:true,force:true});});

  it('renders every frame, cuts on the frame, zooms and overlays',async()=>{
    const out=join(dir,'out.mp4');
    const steps:number[]=[];
    const r=await renderEditDoc({doc:doc(),media,out,work:join(dir,'work'),chunkSeconds:1.5,progress:f=>steps.push(f)});
    expect(r.frames).toBe(120);
    expect(steps.at(-1)).toBe(1);
    const probe=JSON.parse(new TextDecoder().decode(Bun.spawnSync(['ffprobe','-v','error','-count_frames','-show_entries','stream=codec_type,nb_read_frames,duration','-of','json',out]).stdout));
    const v=probe.streams.find((s:{codec_type:string})=>s.codec_type==='video');
    const a=probe.streams.find((s:{codec_type:string})=>s.codec_type==='audio');
    expect(Number(v.nb_read_frames)).toBe(120);
    expect(Math.abs(Number(a.duration)-4)).toBeLessThan(0.05);
    // Cut at frame 60: grey before, black-with-square after.
    expect(mean(await frame(out,59))).toBeGreaterThan(150);
    expect(mean(await frame(out,60))).toBeLessThan(60);
    // B-roll (white) on frames 30..44 only.
    expect(mean(await frame(out,29))).toBeLessThan(230);
    expect(mean(await frame(out,30))).toBeGreaterThan(240);
    expect(mean(await frame(out,44))).toBeGreaterThan(240);
    expect(mean(await frame(out,45))).toBeLessThan(230);
    // Held 2× zoom about the centre: the 40 px square covers ~4× the pixels, across a chunk edge (frame 90).
    for(const n of [61,89,90,119]) {
      const px=bright(await frame(out,n));
      expect(px).toBeGreaterThan(40*40*3.3);
      expect(px).toBeLessThan(40*40*4.7);
    }
    // Sound: the mono tone on both sides until the cut, then only the ducked bed; the mix lands near its target.
    const pcm=new Float32Array((await ff(['-i',out,'-map','0:a','-f','f32le','-ac','2','-ar','48000','-'])).buffer);
    const rms=(from:number,to:number,ch:number)=>{
      let sum=0,n=0;
      for(let i=Math.round(from*48000);i<Math.round(to*48000);i++) {sum+=pcm[i*2+ch]!**2;n++;}
      return Math.sqrt(sum/n);
    };
    expect(rms(1,1.9,0)).toBeCloseTo(rms(1,1.9,1),3);
    expect(rms(1,1.9,0)/rms(2.1,2.9,0)).toBeGreaterThan(10);
    expect(rms(2.1,2.9,0)).toBeGreaterThan(0);
    expect(r.loudness?.gainDb).toBeGreaterThan(0);
  },120_000);

  it('lays alpha graphics over the picture, keeping what shows through',async()=>{
    const webm=join(dir,'g.webm');
    // Left half opaque white, right half clear.
    await ff(['-f','lavfi','-i',`color=c=white@0:s=${W}x${H}:r=30:d=1,format=yuva420p,geq=lum=255:cb=128:cr=128:a='if(lt(X,W/2),255,0)'`,'-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-t','1',webm]);
    const out=join(dir,'gfx.mp4');
    const d=doc({graphics:[{id:'g1',assetId:'ga-1',start:2.5,end:3.5,owner:'agent'}]});
    const r=await renderEditDoc({doc:d,media,graphics:{'ga-1':webm},out,work:join(dir,'work3')});
    expect(r.skipped).toEqual([]);
    const f=await frame(out,90);
    const half=(left:boolean)=>{let s=0,n=0;for(let y=0;y<H;y++)for(let x=left?0:W/2+10;x<(left?W/2-10:W);x++){s+=f[y*W+x]!;n++;}return s/n;};
    expect(half(true)).toBeGreaterThan(240);
    expect(half(false)).toBeLessThan(80);
    expect(mean(await frame(out,74))).toBeLessThan(80);
  },120_000);

  it('puts the masked speaker over a behindSubject graphic, zoom and all; falls back to over',async()=>{
    const webm=join(dir,'white.webm');
    await ff(['-f','lavfi','-i',`color=c=white:s=${W}x${H}:r=30:d=2,format=yuva420p`,'-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-t','2',webm]);
    // A stand-in for the model: the right half of the source frame is the subject.
    const masker:SubjectMasker=async m=>{
      await ff(['-f','lavfi','-i',`color=c=black:s=${W}x${H}:r=${m.fps}:d=${m.end-m.start},geq=lum='if(gt(X,W/2),255,0)':cb=128:cr=128`,'-c:v','mjpeg','-pix_fmt','yuvj420p',m.out]);
      return true;
    };
    const d=doc({graphics:[{id:'g1',assetId:'ga-1',start:2.5,end:3.5,owner:'agent',behindSubject:true}]});
    const half=(f:Uint8Array,left:boolean)=>{let s=0,n=0;for(let y=0;y<H;y++)for(let x=left?0:W/2+10;x<(left?W/2-10:W);x++){s+=f[y*W+x]!;n++;}return s/n;};
    const out=join(dir,'behind.mp4');
    const r=await renderEditDoc({doc:d,media,graphics:{'ga-1':webm},subjectMask:masker,out,work:join(dir,'work6'),chunkSeconds:1});
    expect(r.skipped).toEqual([]);
    const f=await frame(out,90);
    // Left: the white graphic. Right: the dark speaker clip back on top (a sliver of its zoomed square falls here).
    expect(half(f,true)).toBeGreaterThan(240);
    expect(half(f,false)).toBeLessThan(80);
    const plain=join(dir,'over.mp4');
    const r2=await renderEditDoc({doc:d,media,graphics:{'ga-1':webm},subjectMask:async()=>false,out:plain,work:join(dir,'work7')});
    expect(r2.skipped).toEqual([{itemId:'g1',reason:'subject-mask-missing'}]);
    expect(half(await frame(plain,90),false)).toBeGreaterThan(240);
  },120_000);

  it('screen craft: a cropped region fills the frame, sped-up footage runs fast, the speaker sits in a corner',async()=>{
    // Black for 2 s of source, then white.
    const flip=join(dir,'flip.mp4');
    await ff(['-f','lavfi','-i',`color=c=black:s=${W}x${H}:r=30:d=10,geq=lum='if(gt(T,2),255,0)':cb=128:cr=128`,'-c:v','libx264','-pix_fmt','yuv420p',flip]);
    const d=doc({'b-roll':[
      // The small white square of blue, cropped to the middle fifth of the frame.
      {id:'crop',clipId:'blue',in:0,out:0.5,start:0.5,end:1,owner:'agent',crop:{x:0.4,y:0.4,w:0.2,h:0.2}},
      {id:'fast',clipId:'box',in:0,out:4,start:1,end:2,owner:'agent',speed:4},
      {id:'pip',clipId:'box',in:5,out:6,start:3,end:4,owner:'agent',pip:'top-left'},
    ]});
    d.clips.find(c=>c.id==='box')!.hash=hash('e');
    const out=join(dir,'craft.mp4');
    await renderEditDoc({doc:d,media:{...media,[hash('e')]:flip},out,work:join(dir,'work5')});
    // Uncropped the square is under 2% of the frame; cropped it is most of it.
    expect(mean(await frame(out,20))).toBeGreaterThan(80);
    // 4x: a quarter second in is source second 1 (black), three quarters in is second 3 (white).
    expect(mean(await frame(out,36))).toBeLessThan(40);
    expect(mean(await frame(out,54))).toBeGreaterThan(200);
    // Corner picture: the white footage everywhere but the box, where the dark speaker clip shows.
    const f=await frame(out,105),b=pipBox({width:W,height:H},'top-left');
    const region=(x0:number,y0:number,w:number,h:number)=>{let t=0;for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++)t+=f[y*W+x]!;return t/(w*h);};
    expect(region(b.x+6,b.y+6,b.width-12,b.height-12)).toBeLessThan(80);
    expect(region(W-60,H-60,50,50)).toBeGreaterThan(230);
  },120_000);

  it('captions as a track: clean picture, soft subtitle stream with the words',async()=>{
    const out=join(dir,'soft.mp4');
    const d=doc({captions:[{id:'c1',start:2,end:3,text:'Here is why',words:['red:0'],owner:'agent'}]});
    await renderEditDoc({doc:d,media,out,work:join(dir,'work4'),captions:'track'});
    expect(bright(await frame(out,65))).toBe(bright(await frame(out,100)));
    const subs=new TextDecoder().decode(Bun.spawnSync(['ffmpeg','-v','error','-i',out,'-map','0:s:0','-f','srt','-']).stdout);
    expect(subs).toContain('Here is why');
    expect(subs).toContain('00:00:02,000 --> 00:00:03,000');
  },120_000);

  // Text needs libass; the stock Homebrew ffmpeg has none, so this runs where an ffmpeg with it is at hand.
  const assFfmpeg=[process.env.SUPERTALE_TEST_FFMPEG_ASS,`${process.env.HOME}/code/voxtale-desktop/apps/desktop/resources/bin/darwin-x64/ffmpeg`,'ffmpeg']
    .find(b=>!!b&&Bun.spawnSync([b,'-hide_banner','-filters']).stdout.toString().includes(' ass '));
  it.skipIf(!assFfmpeg)('draws text and captions on their frames',async()=>{
    const out=join(dir,'text.mp4');
    const d=doc({
      text:[{id:'t1',start:1,end:2,text:'64 GB',template:'title',owner:'agent'}],
      captions:[{id:'c1',start:2,end:3,text:'Here is why',words:['red:0'],owner:'agent'}],
    });
    await renderEditDoc({doc:d,media,out,work:join(dir,'work2'),ffmpeg:assFfmpeg!});
    // Frame 60 onward is black with a small square: any text adds bright pixels.
    const square=bright(await frame(out,100));
    expect(bright(await frame(out,65))-square).toBeGreaterThan(200);
    expect(bright(await frame(out,95))).toBe(square);
    // The title sits over grey footage; compare against a frame before it starts.
    const lit=(b:Uint8Array)=>b.filter(x=>x>215).length;
    expect(lit(await frame(out,45))-lit(await frame(out,25))).toBeGreaterThan(100);
  },120_000);
});
