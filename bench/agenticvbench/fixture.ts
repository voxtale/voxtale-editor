// Test fixture: a hand-made EditDoc for one Sequencing task, rendered by our
// editor's own renderer (renderEditDoc, local ffmpeg, no API calls). It stands
// in for what `set_cut` + `render` would leave behind: one a-roll item per
// clip, trimmed a little at both ends the way word snapping trims them.
//
//   bun bench/agenticvbench/fixture.ts <materials-dir> <out-dir> <order: 3,1,2,...> [--trim 0.15]
//
// Writes <out-dir>/edit.json and <out-dir>/solution.mp4.
import {mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {newEditDoc,parseEditDoc,type ClipRef} from '@voxtale/editdoc';
import {renderEditDoc} from '../../src/video/render-edit';

const [materials,outDir,orderArg]=process.argv.slice(2);
if(!materials||!outDir||!orderArg){console.error('usage: fixture.ts <materials> <out> <order>');process.exit(2);}
const ti=process.argv.indexOf('--trim'),trim=ti>0?Number(process.argv[ti+1]):0.15;
const order=orderArg.split(',');

const probe=(p:string)=>{
  const r=Bun.spawnSync(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_type,width,height,r_frame_rate','-of','json',p]);
  const j=JSON.parse(r.stdout.toString()),v=j.streams.find((s:any)=>s.codec_type==='video');
  const [num,den]=String(v.r_frame_rate).split('/').map(Number);
  return {duration:Number(j.format.duration),width:v.width,height:v.height,fps:{num:num!,den:den??1},hasAudio:j.streams.some((s:any)=>s.codec_type==='audio')};
};

const media:Record<string,string>={};
const clips:ClipRef[]=order.map((n,k)=>{
  const path=resolve(materials,`${n}.mp4`),info=probe(path);
  const hash=createHash('sha256').update(readFileSync(path)).digest('hex');
  media[hash]=path;
  return {id:`c${k+1}`,hash,name:`${n}.mp4`,kind:'video',role:'a-roll',roleSource:'creator',duration:info.duration,
    fps:info.fps,width:info.width,height:info.height,hasAudio:info.hasAudio,timecodeStart:0};
});
const first=probe(media[clips[0]!.hash]!);
const doc=newEditDoc({id:'bench-fixture',name:'bench-fixture',clips,fps:first.fps,canvas:{width:first.width,height:first.height}});
// Item times sit on frame boundaries (EditDoc rule); count in frames.
const rate=first.fps.num/first.fps.den,sec=(f:number)=>f*first.fps.den/first.fps.num;
let f0=0;
const aroll=clips.map(c=>{
  const fIn=Math.round(Math.min(trim,c.duration/4)*rate),fOut=Math.floor(Math.max(c.duration-trim,c.duration*3/4)*rate);
  const len=fOut-fIn;
  const it={id:`a-${c.id}`,start:sec(f0),end:sec(f0+len),owner:'agent' as const,status:'applied' as const,clipId:c.id,in:sec(fIn),out:sec(fOut),gainDb:0};
  f0+=len;return it;
});
const t=sec(f0);
const {doc:full}=parseEditDoc({...doc,tracks:{...doc.tracks,'a-roll':aroll}});

mkdirSync(outDir,{recursive:true});
writeFileSync(join(outDir,'edit.json'),JSON.stringify(full,null,1));
const t0=Date.now();
const r=await renderEditDoc({doc:full,media,out:resolve(outDir,'solution.mp4'),work:resolve(outDir,'render-work')});
console.error(`rendered ${t.toFixed(2)} s in ${((Date.now()-t0)/1000).toFixed(0)} s; skipped: ${r.skipped.length}`);
