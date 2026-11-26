// set_frame (auto reframe) and track_title (title motion tracking). Text in
// track-skill-text.ts; the work in ../../reframe.ts and ../../track-motion.ts.
import {z} from 'zod/v4';
import {REFRAME_SPEEDS,canvasToSource,cropWidth,parseAspect,pieceAt,type Reframe} from '@voxtale/editdoc';
import {joinReframes,reframePath,shownSpans,type SubjectFinder} from '../../reframe';
import {trackItem,trackableItem,type PointTracker} from '../../track-motion';
import {defineTool,type ToolDef} from './port';
import {SET_FRAME_DESCRIPTION,TRACK_TITLE_DESCRIPTION} from './track-skill-text';
import type {Workspace} from './tools';

type Change=(ws:Workspace,f:()=>void)=>Promise<void>;
/** Finders tests pass in place of the native ones. */
export interface TrackPorts {subject?:SubjectFinder;tracker?:PointTracker}

const ASPECT=/^(source|\d+(\.\d+)?:\d+(\.\d+)?)$/;

export function trackTools(ws:Workspace,change:Change,ports:TrackPorts={}):ToolDef<any>[] {
  return [
    defineTool({name:'set_frame',description:SET_FRAME_DESCRIPTION,
      input:{aspect:z.string().regex(ASPECT,'aspect like "9:16", "1:1" or "source"'),speed:z.enum(REFRAME_SPEEDS).optional(),follow:z.boolean().optional()},
      run:async({aspect,speed,follow})=>{
        if(!ws.segments.length)throw new Error('lay the cut first (set_cut): the frame follows the clips in it');
        if(aspect!=='source')parseAspect(aspect);
        const dropped=Object.keys(ws.motionTracks??{}).length;
        await change(ws,()=>{
          ws.frame=aspect==='source'?undefined:{aspect,speed:speed??'default'};
          ws.reframes=undefined;ws.motionTracks=undefined;
        });
        const doc=ws.doc!;
        const notes:string[]=[`frame ${doc.canvas.width}x${doc.canvas.height}`];
        if(dropped)notes.push(`${dropped} motion track(s) dropped: track_title again`);
        if(!ws.frame||follow===false)return {text:[...notes,ws.frame?'crop: middle':''].filter(Boolean).join('; ')};
        const reframes:Record<string,Reframe>={};
        for(const c of ws.job.clips) {
          const r=c.ref;
          if(r.kind!=='video'||!r.width||!r.height)continue;
          const spans=shownSpans(doc,r.id);
          if(!spans.length)continue;
          if(cropWidth({width:r.width,height:r.height},doc.canvas)>=0.999)continue;
          const path=ws.media?.[r.hash];
          if(!path){notes.push(`${r.id}: original file not on this machine, crop stays in the middle`);continue;}
          const paths=[];
          for(const s of spans)paths.push(await reframePath({path,width:r.width,height:r.height},s,doc.canvas.width/doc.canvas.height,
            {speed:ws.frame.speed,...(ports.subject?{subject:ports.subject}:{})}));
          const joined=joinReframes(paths.map(p=>p.reframe));
          const seen=paths.reduce((n,p)=>n+p.faces+p.people,0),all=paths.reduce((n,p)=>n+p.frames,0);
          if(!joined){notes.push(`${r.id}: nobody seen, crop stays in the middle`);continue;}
          reframes[r.id]=joined;
          notes.push(`${r.id}: follows the speaker (${seen}/${all} samples saw someone, crop travels ${Math.max(...paths.map(p=>p.moved))}px)`);
        }
        if(Object.keys(reframes).length)await change(ws,()=>{ws.reframes=reframes;});
        return {text:notes.join('; ')};
      }}),
    defineTool({name:'track_title',description:TRACK_TITLE_DESCRIPTION,
      input:{id:z.string().min(1),x:z.number().min(0).max(1).optional(),y:z.number().min(0).max(1).optional(),at:z.number().min(0).optional(),
        zone:z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),w:z.number().min(0.02).max(1),h:z.number().min(0.02).max(1)}).strict().optional(),
        clear:z.boolean().optional()},
      run:async({id,x,y,at,zone,clear})=>{
        if(!ws.doc)throw new Error('lay the cut first (set_cut)');
        if(clear) {
          if(!ws.motionTracks?.[id])return {text:`${id} has no motion track`};
          const {[id]:_,...rest}=ws.motionTracks;
          await change(ws,()=>{ws.motionTracks=Object.keys(rest).length?rest:undefined;});
          return {text:`${id}: track removed, it holds still`};
        }
        if(x===undefined||y===undefined)throw new Error('give x and y: the spot to follow');
        const doc=ws.doc,{item}=trackableItem(doc,id);
        const piece=pieceAt(doc,at??(item.start+item.end)/2);
        const ref=piece&&ws.job.clips.find(c=>c.ref.id===piece.clipId)?.ref;
        const path=ref&&ws.media?.[ref.hash];
        if(piece&&ref&&!path)throw new Error(`the original file of ${ref.id} is not on this machine`);
        // The zone is given on the frame; the tracker reads the source frame.
        let srcZone:[number,number,number,number]|undefined;
        if(zone&&piece) {
          const t=at??(item.start+item.end)/2,a=canvasToSource(doc,piece,t,{x:zone.x,y:zone.y}),b=canvasToSource(doc,piece,t,{x:zone.x+zone.w,y:zone.y+zone.h});
          srcZone=[a.x,a.y,b.x-a.x,b.y-a.y];
        }
        const r=await trackItem(doc,id,path??'',{point:{x,y},...(at!==undefined?{at}:{}),...(srcZone?{zone:srcZone}:{}),...(ports.tracker?{tracker:ports.tracker}:{})});
        await change(ws,()=>{ws.motionTracks={...ws.motionTracks,[id]:r.track};});
        const on=[...ws.doc!.tracks.text,...ws.doc!.tracks.graphics].find(i=>i.id===id);
        if(!on?.track)return {text:`${id}: tracked, but the cut left it off (the footage under it changed): track again`};
        const scale=r.scale[0]===r.scale[1]?'':`, scale ${r.scale[0].toFixed(2)}-${r.scale[1].toFixed(2)}`;
        return {text:`${id}: pinned, ${r.keys} keys, moves up to ${r.moved}px${scale}${r.partial?'; runs past the shot under it: holds still outside it, trim it to the shot':''}${r.moved<4?'; barely moves: the camera is still, the track may not be needed':''}`};
      }}),
  ];
}
