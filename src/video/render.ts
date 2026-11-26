import {ffmpegPath} from './ffmpeg-path';
import {bundle} from '@remotion/bundler';
import {renderMedia, renderStill, selectComposition, makeCancelSignal} from '@remotion/renderer';
import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, extname, join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {timeline, durationFrames, type Edit} from './model';
import {run, validateMedia, probe} from './media';

export async function render(edit:Edit, output:string, preview=false,progress:(message:string)=>void=()=>{}) {
  const source=await validateMedia(edit);
  output=resolve(output);
  await mkdir(dirname(output),{recursive:true});
  // Exclusive directory creation preserves every previous render.
  await mkdir(output);
  const scratch=await mkdtemp(join(tmpdir(),'voxtale-video-'));
  const publicDir=join(scratch,'public');
  await mkdir(publicDir);
  const controller=new AbortController();
  const {cancelSignal,cancel}=makeCancelSignal();
  const interrupt=()=>{controller.abort();cancel();};
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const started=Date.now();
  try {
    await writeFile(join(output,'edit.json'),JSON.stringify(edit,null,2)+'\n');
    const prepared=structuredClone(edit);
    if(preview) {prepared.width=640;prepared.height=Math.max(240,Math.round(640*edit.height/edit.width/2)*2);}
    for(const scene of timeline(edit)) {
      if(controller.signal.aborted) throw new Error('Cancelled');
      progress(`Preparing ${scene.id}`);
      const start=scene.sourceStart/edit.fps, seconds=scene.duration/edit.fps;
      const filters=`fps=${edit.fps},scale=${prepared.width}:${prepared.height}:force_original_aspect_ratio=decrease,pad=${prepared.width}:${prepared.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
      await run(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y','-ss',String(start),'-i',edit.source,'-t',String(seconds),'-vf',filters,'-frames:v',String(scene.duration),'-an','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p',join(publicDir,`shot-${scene.id}.mp4`)],controller.signal);
      const audioInput=source.audio?['-ss',String(start),'-i',edit.source]:['-f','lavfi','-i','anullsrc=r=48000:cl=stereo'];
      await run(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y',...audioInput,'-t',String(seconds),'-vn','-af','apad','-ar','48000','-ac','2',join(publicDir,`audio-${scene.id}.wav`)],controller.signal);
      const dest=prepared.scenes.find(s=>s.id===scene.id)!;
      if(scene.broll && dest.broll) {
        const name=`broll-${scene.id}${scene.broll.kind==='video'?'.mp4':extname(scene.broll.path)}`;
        if(scene.broll.kind==='video') await run(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y','-ss',String(scene.broll.in),'-i',scene.broll.path,'-t',String(seconds),'-vf',`fps=${edit.fps}`,'-an','-c:v','libx264','-pix_fmt','yuv420p',join(publicDir,name)],controller.signal);
        else await copyFile(scene.broll.path,join(publicDir,name));
        dest.broll.path=name;dest.broll.in=0;
      }
    }
    if(prepared.music) {
      const name=`music${extname(prepared.music.path)}`;
      await copyFile(prepared.music.path,join(publicDir,name));prepared.music.path=name;
    }
    progress('Bundling composition');
    const serveUrl=await bundle({entryPoint:join(import.meta.dir,'composition.tsx'),publicDir,outDir:join(scratch,'bundle')});
    if(controller.signal.aborted) throw new Error('Cancelled');
    const inputProps={edit:prepared};
    const browserExecutable=process.env.VIDEO_BROWSER_EXECUTABLE;
    const composition=await selectComposition({serveUrl,id:'Footage',inputProps,browserExecutable});
    let last=-1;
    await renderMedia({serveUrl,composition,inputProps,outputLocation:join(output,'video.mp4'),codec:'h264',audioCodec:'aac',pixelFormat:'yuv420p',crf:preview?26:18,concurrency:2,cancelSignal,browserExecutable,
      onProgress:({progress:fraction})=>{const n=Math.floor(fraction*10);if(n!==last){last=n;progress(`Rendering ${n*10}%`);}}});
    await renderStill({serveUrl,composition,inputProps,output:join(output,'poster.png'),frame:Math.min(15,composition.durationInFrames-1),browserExecutable});
    const actual=await probe(join(output,'video.mp4'));
    const expected=durationFrames(edit)/edit.fps;
    if(!actual.video || !actual.audio || Math.abs(actual.duration-expected)>0.15) throw new Error(`Output check failed: expected ${expected}s, got ${actual.duration}s`);
    const report={status:'complete',preview,duration:actual.duration,frames:durationFrames(edit),width:prepared.width,height:prepared.height,elapsedSeconds:(Date.now()-started)/1000,editHash:createHash('sha256').update(JSON.stringify(edit)).digest('hex'),sourceMap:timeline(edit).map(s=>({id:s.id,sourceStart:s.sourceStart,outputStart:s.from,frames:s.duration})),output:'video.mp4'};
    await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    return report;
  } catch(error) {
    await writeFile(join(output,'report.json'),JSON.stringify({status:controller.signal.aborted?'cancelled':'failed',error:String(error)},null,2)+'\n');
    throw error;
  } finally {
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
    await rm(scratch,{recursive:true,force:true});
  }
}
