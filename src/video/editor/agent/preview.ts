// The cut as a viewer sees it: frames of the OUTPUT timeline, layers stacked
// as the render stacks them (speaker with its zoom, shown footage with crop,
// the speaker's corner picture, graphics). The agent watches its own edit
// down before it finishes. ffmpeg only, no model. Source frames come through
// the frame host, so a cloud run can watch a cut whose files it never holds.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pipBox,zoomAt,type EditDoc} from '@voxtale/editdoc';
import type {FrameHost} from './frames';

type Box={x:number;y:number;width:number;height:number};

export interface PreviewLayer {
  /** Clip hash. */
  clip:string;
  /** Source second. */
  t:number;
  fit:'cover'|'contain';
  /** Part of the source frame shown, fractions of it. */
  crop?:{x:number;y:number;w:number;h:number};
  /** Where it sits, canvas pixels; the whole canvas when absent. */
  box?:Box;
  /** Scale about the centre and shift (fractions of the canvas). */
  zoom?:{scale:number;dx:number;dy:number};
}

export interface PreviewShot {
  /** Output second. */
  t:number;
  layers:PreviewLayer[];
  /** Rendered overlays up at `t`, with the second into each. */
  graphics:{webm:string;t:number}[];
  /** What is on screen and in the mix, in words. */
  notes:string[];
}

/** Most frames one sheet holds. */
export const PREVIEW_MAX=12;
/** Width source frames are fetched at. */
const FETCH_WIDTH=640;

const on=<T extends {start:number;end:number;status:string}>(items:T[],t:number):T[]=>items.filter(i=>i.status!=='suggested'&&i.start<=t+1e-6&&t<i.end-1e-6);

/** `count` output seconds spread over [start,end], each mid-way through its slice. */
export function previewTimes(start:number,end:number,count:number):number[] {
  const n=Math.max(1,Math.min(PREVIEW_MAX,count)),d=Math.max(0,end-start);
  return Array.from({length:n},(_,k)=>Math.round((start+(k+0.5)*d/n)*100)/100);
}

/**
 * What the render shows at each output second. `hashOf` gives a clip's hash
 * when it has a picture; `webmOf` a graphic's rendered file on this machine.
 */
export function previewShots(doc:EditDoc,times:number[],hashOf:(clipId:string)=>string|undefined,webmOf:(assetId:string)=>string|undefined):PreviewShot[] {
  const kind=new Map(doc.clips.map(c=>[c.id,c.kind]));
  return times.map(t=>{
    const layers:PreviewLayer[]=[],notes:string[]=[],graphics:PreviewShot['graphics']=[];
    const a=on(doc.tracks['a-roll'],t)[0];
    const speaker=a&&kind.get(a.clipId)==='video'?hashOf(a.clipId):undefined;
    const at=a?a.in+(t-a.start):0;
    if(a&&speaker) {
      const z=zoomAt(doc.tracks.zoom,t);
      layers.push({clip:speaker,t:at,fit:'cover',...(Math.abs(z.scale-1)>1e-3?{zoom:z}:{})});
      notes.push(Math.abs(z.scale-1)>1e-3?`speaker, zoom ${z.scale.toFixed(2)}x`:'speaker');
    } else if(!a)notes.push('NO SPEAKER: gap in the cut');
    for(const b of on(doc.tracks['b-roll'],t)) {
      const hash=hashOf(b.clipId);
      if(!hash)continue;
      const speed=b.speed??1;
      layers.push({clip:hash,t:kind.get(b.clipId)==='image'?0:b.in+(t-b.start)*speed,fit:b.fit,...(b.crop?{crop:b.crop}:{})});
      notes.push(`footage ${b.id}${b.crop?' (cropped)':''}${speed!==1?` at ${speed}x`:''}`);
      if(b.pip&&speaker) {
        layers.push({clip:speaker,t:at,fit:'cover',box:pipBox(doc.canvas,b.pip)});
        notes.push(`speaker ${b.pip}`);
      }
    }
    for(const g of on(doc.tracks.graphics,t)) {
      const webm=webmOf(g.assetId);
      if(webm)graphics.push({webm,t:t-g.start});
      notes.push(`graphic ${g.assetId} (${g.placement}${webm?'':', not drawn'})`);
    }
    for(const x of on(doc.tracks.text,t))notes.push(`text ${x.template} "${x.text}" (not drawn)`);
    const cap=on(doc.tracks.captions,t)[0];
    if(cap)notes.push(`caption "${cap.text}" (not drawn)`);
    if(on(doc.tracks.music,t).length)notes.push('music');
    return {t,layers,graphics,notes};
  });
}

const even=(x:number)=>Math.max(2,Math.round(x/2)*2);

/** The shots as one sheet (JPEG), left to right, top to bottom. */
export async function drawPreview(o:{shots:PreviewShot[];canvas:{width:number;height:number};frames:FrameHost;dir:string;ff:(args:string[])=>Promise<void>;width?:number}):Promise<Uint8Array> {
  const {shots,canvas,ff}=o;
  if(!shots.length)throw new Error('nothing to preview');
  await mkdir(o.dir,{recursive:true});
  const tall=canvas.height>canvas.width;
  const cw=even(o.width??(tall?216:384)),ch=even(cw*canvas.height/canvas.width),k=cw/canvas.width;
  // One frame call per clip, for every second any shot needs of it.
  const want=new Map<string,number[]>();
  for(const s of shots)for(const l of s.layers)want.set(l.clip,[...new Set([...(want.get(l.clip)??[]),l.t])]);
  const still=new Map<string,string>();
  let n=0;
  await Promise.all([...want].map(async([clip,times])=>{
    const got=await o.frames.frames(clip,times,FETCH_WIDTH);
    await Promise.all(times.map(async(t,i)=>{
      const bytes=got[i];
      if(!bytes)return;
      const file=join(o.dir,`src-${n++}.jpg`);
      await writeFile(file,bytes);
      still.set(`${clip}@${t}`,file);
    }));
  }));
  for(const [i,s] of shots.entries()) {
    const inputs=['-f','lavfi','-i',`color=black:s=${cw}x${ch}`];
    const graph:string[]=[];
    let last='0:v',idx=1;
    for(const l of s.layers) {
      const file=still.get(`${l.clip}@${l.t}`);
      if(!file)continue;
      inputs.push('-i',file);
      const bw=even((l.box?.width??canvas.width)*k),bh=even((l.box?.height??canvas.height)*k);
      const crop=l.crop?`crop=iw*${l.crop.w}:ih*${l.crop.h}:iw*${l.crop.x}:ih*${l.crop.y},`:'';
      const fit=l.fit==='cover'
        ?`scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh}`
        :`scale=${bw}:${bh}:force_original_aspect_ratio=decrease,pad=${bw}:${bh}:(ow-iw)/2:(oh-ih)/2:black`;
      const z=l.zoom;
      const zoom=z?`,scale=${even(bw*z.scale)}:${even(bh*z.scale)}`:'';
      const x=z?Math.round(((1-z.scale)/2+z.dx)*cw):Math.round((l.box?.x??0)*k);
      const y=z?Math.round(((1-z.scale)/2+z.dy)*ch):Math.round((l.box?.y??0)*k);
      graph.push(`[${idx}:v]${crop}${fit}${zoom}[l${idx}]`,`[${last}][l${idx}]overlay=${x}:${y}[o${idx}]`);
      last=`o${idx}`;
      idx++;
    }
    for(const g of s.graphics) {
      // Alpha-aware VP9 decode, as the render does.
      inputs.push('-c:v','libvpx-vp9','-ss',String(Math.max(0,g.t)),'-i',g.webm);
      graph.push(`[${idx}:v]scale=${cw}:${ch}[l${idx}]`,`[${last}][l${idx}]overlay=0:0[o${idx}]`);
      last=`o${idx}`;
      idx++;
    }
    const out=join(o.dir,`shot-${i}.jpg`);
    if(graph.length)await ff([...inputs,'-filter_complex',graph.join(';'),'-map',`[${last}]`,'-frames:v','1',out]);
    else await ff([...inputs,'-frames:v','1',out]);
  }
  const cols=Math.min(shots.length,tall?6:4),rows=Math.ceil(shots.length/cols);
  const sheet=join(o.dir,'sheet.jpg');
  await ff(['-start_number','0','-i',join(o.dir,'shot-%d.jpg'),'-vf',`tile=${cols}x${rows}:padding=4:color=white`,'-frames:v','1',sheet]);
  return new Uint8Array(await readFile(sheet));
}
