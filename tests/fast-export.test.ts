import {afterAll,beforeAll,describe,expect,it} from 'bun:test';
import {chmod,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newEditDoc,parseEditDoc,STYLE_PRESETS,type ClipRef,type EditDoc} from '@voxtale/editdoc';
import {encodeArgs,findEncoder,targetBitrate,testArgs} from '../src/video/encoders';
import {assBusy,copyCandidates,copyRange,copyableSource,mixedChunks,parsePackets,parseSourceProbe,subtract,type Packet,type SourceVideo} from '../src/video/fast-copy';
import {chunkBounds,renderEditDoc,type Picture} from '../src/video/render-edit';
import {download,mediaExt,seconds,uniquePath,videoPage,ytdlpArgs} from '../src/video/download';

describe('findEncoder',()=>{
  const tried:string[]=[];
  const test=(ok:string[])=>async(_ff:string,args:string[])=>{const n=args[args.indexOf('-c:v')+1]!;tried.push(n);return ok.includes(n);};
  it('takes VideoToolbox on a Mac when it encodes',async()=>{
    expect(await findEncoder({platform:'darwin',env:{},test:test(['h264_videotoolbox'])})).toEqual({codec:'h264',name:'h264_videotoolbox',hardware:true});
    expect((await findEncoder({platform:'darwin',env:{},codec:'hevc',test:test(['hevc_videotoolbox'])})).name).toBe('hevc_videotoolbox');
  });
  it('tries GPUs in order elsewhere, then the CPU',async()=>{
    tried.length=0;
    expect((await findEncoder({platform:'win32',env:{},test:test(['h264_amf'])})).name).toBe('h264_amf');
    expect(tried).toEqual(['h264_nvenc','h264_qsv','h264_amf']);
    expect(await findEncoder({platform:'linux',env:{},test:test([])})).toEqual({codec:'h264',name:'libx264',hardware:false});
    expect((await findEncoder({platform:'linux',env:{},codec:'hevc',test:test([])})).name).toBe('libx265');
  });
  it('obeys VOXTALE_EDITOR_ENCODER',async()=>{
    expect((await findEncoder({platform:'darwin',env:{VOXTALE_EDITOR_ENCODER:'software'},test:test(['h264_videotoolbox'])})).name).toBe('libx264');
    expect(await findEncoder({env:{VOXTALE_EDITOR_ENCODER:'h264_nvenc'},test:test([])})).toEqual({codec:'h264',name:'h264_nvenc',hardware:true});
  });
  it('test encode uses the encoder its own way',()=>{
    expect(testArgs('h264_videotoolbox')).toContain('-allow_sw');
    expect(testArgs('h264_nvenc').join(' ')).toContain('-pix_fmt nv12');
  });
});

describe('encodeArgs',()=>{
  const q={crf:18,preset:'veryfast',width:1920,height:1080,fps:30};
  it('keeps CRF on the CPU',()=>{
    expect(encodeArgs({codec:'h264',name:'libx264',hardware:false},q)).toEqual(['-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p']);
  });
  it('gives GPUs a bitrate from pixels per second',()=>{
    const b=targetBitrate('h264',q);
    expect(b).toBeGreaterThan(10e6);expect(b).toBeLessThan(15e6);
    expect(targetBitrate('h264',{...q,crf:24})).toBeCloseTo(b/2,-4);
    expect(targetBitrate('hevc',q)).toBeLessThan(b);
    const vt=encodeArgs({codec:'h264',name:'h264_videotoolbox',hardware:true},q);
    expect(vt.slice(0,4)).toEqual(['-c:v','h264_videotoolbox','-allow_sw','1']);
    expect(vt[vt.indexOf('-b:v')+1]).toBe(String(b));
    expect(encodeArgs({codec:'h264',name:'h264_mf',hardware:true},q)).not.toContain('-profile:v');
  });
});

const pic=(over:Partial<Picture>):Picture=>({itemId:'a',path:'/a.mp4',kind:'video',fs:0,fe:300,start:0,in:10,fit:'cover',opacity:1,zoom:[],...over});

describe('copy planning',()=>{
  it('reads burned events as frame spans',()=>{
    expect(assBusy('x\nDialogue: 0,0:00:01.00,0:00:02.50,Plain,,0,0,0,,{}hi\n',30)).toEqual([[30,75]]);
  });
  it('subtracts spans',()=>{
    expect(subtract([0,100],[[10,20],[50,60],[90,200]])).toEqual([[0,10],[20,50],[60,90]]);
  });
  it('finds plain passages nothing covers',()=>{
    const plan={fps:30,pictures:[pic({}),pic({itemId:'b',path:'/b.mp4',fs:100,fe:130})]};
    expect(copyCandidates(plan,[[250,260]])).toEqual([{path:'/a.mp4',f0:0,f1:100,src:10},{path:'/a.mp4',f0:130,f1:250,src:10+130/30}]);
    // Zoomed, cropped or faded: never copied.
    for(const over of [{zoom:[{time:0,value:2,property:'scale' as const}]},{crop:{x:0,y:0,w:0.5,h:0.5}},{fx:[{type:'fade' as const,t0:0,t1:1,dir:'in' as const}]},{lut:'/x.cube'},{speed:2}])
      expect(copyCandidates({fps:30,pictures:[pic(over as Partial<Picture>)]},[])).toEqual([]);
  });
  const src:SourceVideo={codec:'h264',pixFmt:'yuv420p',width:1920,height:1080,rate:30,avgRate:30,rotated:false,startTime:0};
  it('copies only sources that match the output',()=>{
    const plan={width:1920,height:1080,fps:30};
    expect(copyableSource(src,plan,'h264')).toBe(true);
    expect(copyableSource(src,plan,'hevc')).toBe(false);
    expect(copyableSource({...src,width:3840},plan,'h264')).toBe(false);
    expect(copyableSource({...src,rate:29.97,avgRate:29.97},plan,'h264')).toBe(false);
    expect(copyableSource({...src,transfer:'arib-std-b67'},plan,'h264')).toBe(false);
    expect(copyableSource({...src,rotated:true},plan,'h264')).toBe(false);
    expect(copyableSource({...src,pixFmt:'yuv420p10le'},plan,'h264')).toBe(false);
  });
  it('parses ffprobe',()=>{
    const j=JSON.stringify({streams:[{codec_name:'h264',pix_fmt:'yuv420p',width:640,height:360,r_frame_rate:'30000/1001',avg_frame_rate:'30000/1001',side_data_list:[{rotation:-90}]}],format:{start_time:'0.5'}});
    expect(parseSourceProbe(j)).toMatchObject({codec:'h264',rate:30000/1001,rotated:true,startTime:0.5});
    expect(parsePackets('1.5,K__\n1.5333,___\nN/A,___\n',0.5)).toEqual([{pts:1,key:true},{pts:1.0333,key:false}]);
  });

  // Display order I P P …, keyframe every 30 frames, no reordering.
  const ip=(n:number,gop=30,t0=0):Packet[]=>Array.from({length:n},(_,i)=>({pts:t0+i/30,key:i%gop===0}));
  // Decode order with B-frames: I P B B P B B … (each P sent before the two B shown before it).
  const ibb=(n:number,gop=30):Packet[]=>{
    const out:Packet[]=[];
    for(let g=0;g<n;g+=gop) {
      out.push({pts:g/30,key:true});
      for(let i=g+3;i<Math.min(g+gop,n)+2;i+=3) {
        const p=Math.min(i,g+gop-1,n-1);
        out.push({pts:p/30,key:false});
        for(const b of [i-2,i-1])if(b<p)out.push({pts:b/30,key:false});
      }
    }
    return out;
  };
  it('copies from a keyframe to the end when nothing reorders',()=>{
    const c={path:'/a.mp4',f0:0,f1:200,src:0.5};
    // Source frames from 0 s; output frame 0 = source 0.5 s: first keyframe after is 1.0 s = output 15.
    expect(copyRange(ip(300),c,30)).toEqual({c0:15,c1:200,seek:1,frames:185});
  });
  it('cuts B-frame sources only at clean points',()=>{
    const pk=ibb(300);
    const r=copyRange(pk,{path:'/a.mp4',f0:0,f1:200,src:0.5},30)!;
    expect(r.c0).toBe(15);
    expect(r.frames).toBe(r.c1-r.c0);
    // The kept packets show frames c0 .. c1-1 exactly once each.
    const shown=pk.filter(p=>p.pts>=1-1e-9).slice(0,r.frames).map(p=>Math.round(p.pts*30)-15).sort((a,b)=>a-b);
    expect(shown).toEqual(Array.from({length:r.frames},(_,i)=>r.c0+i));
  });
  it('skips open-GOP keyframes and off-grid sources',()=>{
    // Keyframe at 1.0 s followed by a frame shown before it: leading picture.
    const open:Packet[]=[...ip(30).map(p=>({...p,key:false})),{pts:1,key:true},{pts:29/30,key:false},...ip(200,30,31/30).map(p=>({...p,key:false}))];
    expect(copyRange(open,{path:'/a.mp4',f0:0,f1:200,src:0},30,10)).toBeNull();
    expect(copyRange(ip(300),{path:'/a.mp4',f0:0,f1:200,src:0.5+0.4/30},30)).toBeNull();
  });
  it('orders copies between encoded chunks',()=>{
    const copy={path:'/a.mp4',c0:15,c1:200,seek:1,frames:185};
    const ch=mixedChunks(300,60,[[230,250]],[copy],chunkBounds);
    expect(ch.map(c=>[c.c0,c.c1,!!c.copy])).toEqual([[0,15,false],[15,200,true],[200,260,false],[260,300,false]]);
  });
});

const hasFfmpeg=Bun.spawnSync(['ffmpeg','-version']).exitCode===0;
async function ff(args:string[]) {
  const p=Bun.spawn(['ffmpeg','-hide_banner','-loglevel','error','-y',...args],{stderr:'pipe',stdout:'pipe'});
  const out=new Uint8Array(await new Response(p.stdout).arrayBuffer());
  const err=await new Response(p.stderr).text();
  if(await p.exited!==0)throw new Error(err);
  return out;
}
const frame=(file:string,n:number)=>ff(['-i',file,'-vf',`select=eq(n\\,${n}),format=gray`,'-frames:v','1','-f','rawvideo','-']);

describe.skipIf(!hasFfmpeg)('fast export',()=>{
  const W=426,H=240,fps={num:30,den:1};
  let dir='';
  const media:Record<string,string>={};
  const h='e'.repeat(64);
  const sw={codec:'h264' as const,name:'libx264',hardware:false};
  beforeAll(async()=>{
    dir=await mkdtemp(join(tmpdir(),'vt-fast-'));
    media[h]=join(dir,'talk.mp4');
    // Moving picture, keyframe every second, B-frames: the hard case.
    await ff(['-f','lavfi','-i',`testsrc2=s=${W}x${H}:r=30:d=7`,'-f','lavfi','-i','sine=f=440:r=48000:d=7','-c:v','libx264','-g','30','-bf','2','-pix_fmt','yuv420p','-c:a','aac','-shortest',media[h]!]);
  },60_000);
  afterAll(async()=>{await rm(dir,{recursive:true,force:true});});
  const doc=():EditDoc=>{
    const c:ClipRef={id:'talk',hash:h,name:'talk.mp4',kind:'video',role:'a-roll',roleSource:'creator',duration:7,fps,hasAudio:true,timecodeStart:0,width:W,height:H};
    const d=newEditDoc({id:'f1',name:'Fast',clips:[c],fps,style:STYLE_PRESETS.tutorial});
    return parseEditDoc({...d,canvas:{width:W,height:H},tracks:{...d.tracks,'a-roll':[{id:'a1',clipId:'talk',in:0.5,out:5.5,start:0,end:5,owner:'agent'}]}}).doc;
  };
  it('copies the untouched passage, every frame in place',async()=>{
    const fast=join(dir,'fast.mp4'),slow=join(dir,'slow.mp4');
    const r=await renderEditDoc({doc:doc(),media,out:fast,work:join(dir,'w1'),encoder:sw});
    expect(r.frames).toBe(150);
    expect(r.copiedFrames??0).toBeGreaterThanOrEqual(60);
    expect(r.encoder).toBe('libx264');
    const s=await renderEditDoc({doc:doc(),media,out:slow,work:join(dir,'w2'),encoder:sw,fast:false});
    expect(s.copiedFrames).toBeUndefined();
    const count=(f:string)=>Number(new TextDecoder().decode(Bun.spawnSync(['ffprobe','-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','csv=p=0',f]).stdout).trim());
    expect(count(fast)).toBe(150);
    // Output frame n shows source frame n+15, bit for bit inside the copy; the encoded head and tail match it closely.
    for(const n of [10,15,60,120,149]) {
      const [a,b]=await Promise.all([frame(fast,n),frame(media[h]!,n+15)]);
      const diff=a.reduce((m,x,i)=>m+Math.abs(x-b[i]!),0)/a.length;
      expect(diff).toBeLessThan(3);
      if(n===60)expect(diff).toBe(0);
    }
  },120_000);
});

describe('download',()=>{
  it('reads times and video pages',()=>{
    expect(seconds('83')).toBe(83);expect(seconds('1:23')).toBe(83);expect(seconds('1:02:03.5')).toBe(3723.5);
    expect(()=>seconds('a:1')).toThrow();
    expect(videoPage('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(videoPage('https://youtu.be/x')).toBe(true);
    expect(videoPage('https://notyoutube.com/x')).toBe(false);
  });
  it('asks yt-dlp for a section only when timed',()=>{
    expect(ytdlpArgs('https://youtu.be/x','/t',{start:10,end:20}).join(' ')).toContain('--download-sections *10-20');
    expect(ytdlpArgs('https://youtu.be/x','/t',{}).join(' ')).toContain('--match-filter duration<=900');
    expect(ytdlpArgs('https://youtu.be/x','/t',{start:5}).join(' ')).toContain('*5-inf');
  });
  it('names files by URL or content type',()=>{
    expect(mediaExt('https://a.com/x/voice.MP3?sig=1',null)).toBe('.mp3');
    expect(mediaExt('https://a.com/gen/123','video/mp4; charset=x')).toBe('.mp4');
    expect(mediaExt('https://a.com/page','text/html')).toBeNull();
  });
  let dir='';
  beforeAll(async()=>{dir=await mkdtemp(join(tmpdir(),'vt-dl-'));});
  afterAll(async()=>{await rm(dir,{recursive:true,force:true});});
  it('never takes a name already used by another extension',async()=>{
    await writeFile(join(dir,'take.mov'),'');
    expect(await uniquePath(dir,'take','.mp4')).toBe(join(dir,'take-2.mp4'));
  });
  it('refuses http and timed files',async()=>{
    await expect(download({url:'http://a.com/x.mp3',folder:dir})).rejects.toThrow(/https/);
    await expect(download({url:'https://a.com/x.mp3',folder:dir,start:'1'})).rejects.toThrow(/video page/);
    await expect(download({url:'https://youtu.be/x',folder:dir,start:'20',end:'10'})).rejects.toThrow(/after start/);
  });
  it('saves a linked file into downloads/ (no network: a fake fetch)',async()=>{
    const fake=(async()=>Object.assign(new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg'}}),{})) as unknown as typeof fetch;
    const r=await download({url:'https://cdn.example/voice',folder:dir,name:'Intro voice.wav',fetch:fake});
    expect(r.files).toEqual([join(dir,'downloads','Intro voice.mp3')]);
    expect([...await readFile(r.files[0]!)]).toEqual([1,2,3]);
    const html=(async()=>new Response('<html>',{headers:{'content-type':'text/html'}})) as unknown as typeof fetch;
    await expect(download({url:'https://cdn.example/page',folder:dir,fetch:html})).rejects.toThrow(/not a sound/);
    expect((await readdir(join(dir,'downloads'))).filter(f=>f.endsWith('.part'))).toEqual([]);
  });
  it('saves a clip yt-dlp made (fake yt-dlp)',async()=>{
    const bin=join(dir,'yt-dlp');
    // Writes clip.mp4 where -o points and prints a title, as yt-dlp does.
    await writeFile(bin,'#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nout=$(dirname "$2")\nprintf x > "$out/clip.mp4"\necho "My: video?"\n');
    await chmod(bin,0o755);
    const r=await download({url:'https://www.youtube.com/watch?v=x',folder:dir,start:'0:10',end:'0:20',ytdlp:bin});
    expect(r).toMatchObject({kind:'clip',title:'My: video?',files:[join(dir,'downloads','My_ video_.mp4')]});
  });
});
