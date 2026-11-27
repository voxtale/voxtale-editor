// The cut as a viewer sees it: frames of the OUTPUT timeline, layers stacked
// as the render stacks them (speaker with its zoom, shown footage with crop,
// the speaker's corner picture, graphics, the brand logo). The agent watches its own edit
// down before it finishes. ffmpeg only, no model. Source frames come through
// the frame host, so a cloud run can watch a cut whose files it never holds.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {lerpKeys,pipBox,trackAt,zoomAt,type EditDoc} from '@voxtale/editdoc';
import type {FrameHost} from './frames';

/** A still's mask: the person (subject) plus or minus picked objects (fractions of the still). */
export interface StillMask {subject:boolean;objects:{mode:'add'|'remove';points?:[number,number][];exclude?:[number,number][];box?:[number,number,number,number]}[]}
/** Masks a still to `out` (greyscale PNG, white = drawn back over the graphic); the person alone without `mask`. */
export type Cutout=(still:string,out:string,mask?:StillMask)=>Promise<boolean>;

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
  /** Auto reframe: the crop's centre, a fraction of the source width (cover fit only). */
  center?:number;
}

export interface PreviewShot {
  /** Output second. */
  t:number;
  layers:PreviewLayer[];
  /** Rendered overlays up at `t`, with the second into each; behind: the speaker is drawn back over it. */
  graphics:{webm:string;t:number;behind?:boolean;
    /** A pinned graphic's shift, fractions of the canvas. */
    shift?:{x:number;y:number};
    /** What goes back over it, when picked objects shape the mask: the person (subject) and the objects on this clip. */
    mask?:StillMask}[];
  /** Brand logos up at `t`, drawn last: the image file, top-left and width as fractions of the canvas. */
  logos?:{file:string;x:number;y:number;w:number;opacity:number}[];
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
 * when it has a picture; `webmOf` a graphic's rendered file on this machine;
 * `logoOf` a logo clip's image file on this machine.
 */
export function previewShots(doc:EditDoc,times:number[],hashOf:(clipId:string)=>string|undefined,webmOf:(assetId:string)=>string|undefined,
  logoOf:(clipId:string)=>string|undefined=()=>undefined):PreviewShot[] {
  const kind=new Map(doc.clips.map(c=>[c.id,c.kind]));
  const reframe=new Map(doc.clips.flatMap(c=>c.kind==='video'&&c.reframe?.keys.length?[[c.id,c.reframe] as const]:[]));
  const center=(clipId:string,t:number)=>{const r=reframe.get(clipId);return r?{center:lerpKeys(r.keys,t,k=>k.x)}:{};};
  return times.map(t=>{
    const layers:PreviewLayer[]=[],notes:string[]=[],graphics:PreviewShot['graphics']=[];
    const a=on(doc.tracks['a-roll'],t)[0];
    const speaker=a&&kind.get(a.clipId)==='video'?hashOf(a.clipId):undefined;
    const at=a?a.in+(t-a.start):0;
    if(a&&speaker) {
      const z=zoomAt(doc.tracks.zoom,t);
      layers.push({clip:speaker,t:at,fit:'cover',...(a.layout!=='split'?center(a.clipId,at):{}),...(Math.abs(z.scale-1)>1e-3?{zoom:z}:{})});
      notes.push(Math.abs(z.scale-1)>1e-3?`speaker, zoom ${z.scale.toFixed(2)}x`:'speaker');
    } else if(!a)notes.push('NO SPEAKER: gap in the cut');
    for(const b of on(doc.tracks['b-roll'],t)) {
      const hash=hashOf(b.clipId);
      if(!hash)continue;
      const speed=b.speed??1;
      const bt=kind.get(b.clipId)==='image'?0:b.in+(t-b.start)*speed;
      layers.push({clip:hash,t:bt,fit:b.fit,...(b.crop?{crop:b.crop}:b.fit==='cover'?center(b.clipId,bt):{})});
      notes.push(`footage ${b.id}${b.crop?' (cropped)':''}${speed!==1?` at ${speed}x`:''}`);
      if(b.pip&&speaker) {
        layers.push({clip:speaker,t:at,fit:'cover',box:pipBox(doc.canvas,b.pip)});
        notes.push(`speaker ${b.pip}`);
      }
    }
    for(const g of on(doc.tracks.graphics,t)) {
      const webm=webmOf(g.assetId);
      const sh=g.track?trackAt(g.track,t-g.start):null;
      const objects=(g.maskObjects??[]).filter(o=>a&&o.clipId===a.clipId).map(({clipId:_,t:__,...o})=>o);
      const behind=!!speaker&&(!!g.behindSubject||objects.some(o=>o.mode==='add'));
      if(webm)graphics.push({webm,t:t-g.start,...(behind?{behind:true}:{}),...(behind&&objects.length?{mask:{subject:!!g.behindSubject,objects}}:{}),...(sh&&(sh.dx||sh.dy)?{shift:{x:sh.dx,y:sh.dy}}:{})});
      const what=g.behindSubject?(objects.length?', behind the speaker and picked objects':', behind the speaker'):objects.some(o=>o.mode==='add')?', behind picked objects':'';
      notes.push(`graphic ${g.assetId} (${g.placement}${what}${webm?'':', not drawn'})`);
    }
    const logos:NonNullable<PreviewShot['logos']>=[];
    for(const l of (doc.logos??[]).filter(l=>kind.get(l.clipId)==='image'&&l.start<=t+1e-6&&t<l.end-1e-6)) {
      const file=logoOf(l.clipId);
      if(file)logos.push({file,x:l.x,y:l.y,w:l.w,opacity:l.opacity});
      notes.push(`logo ${l.id}${file?'':' (not drawn)'}`);
    }
    for(const x of on(doc.tracks.text,t))notes.push(`text ${x.template} "${x.text}" (not drawn)`);
    const cap=on(doc.tracks.captions,t)[0];
    if(cap)notes.push(`caption "${cap.text}" (not drawn)`);
    if(on(doc.tracks.music,t).length)notes.push('music');
    return {t,layers,graphics,...(logos.length?{logos}:{}),notes};
  });
}

const even=(x:number)=>Math.max(2,Math.round(x/2)*2);

/**
 * The shots as one sheet (JPEG), left to right, top to bottom. `cutout` masks
 * the speaker in a still (greyscale PNG, white = subject); with it, a shot
 * with a behind-subject graphic draws the speaker back over it, as the export
 * does. Without it, or when it fails, the graphic stays on top.
 */
export async function drawPreview(o:{shots:PreviewShot[];canvas:{width:number;height:number};frames:FrameHost;dir:string;ff:(args:string[])=>Promise<void>;width?:number;
  cutout?:Cutout}):Promise<Uint8Array> {
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
  const masks=new Map<string,string|null>();
  const maskOf=async(file:string,mask?:StillMask):Promise<string|null>=>{
    const key=mask?`${file}#${JSON.stringify(mask)}`:file;
    if(!masks.has(key)){const m=file.replace(/\.jpg$/,`-mask${mask?`-${masks.size}`:''}.png`);masks.set(key,o.cutout&&await o.cutout(file,m,mask).catch(()=>false)?m:null);}
    return masks.get(key)!;
  };
  for(const [i,s] of shots.entries()) {
    const inputs=['-f','lavfi','-i',`color=black:s=${cw}x${ch}`];
    const graph:string[]=[];
    let last='0:v',idx=1;
    // How each layer lands on the canvas: filters for its still, and where.
    const place=(l:PreviewLayer)=>{
      const bw=even((l.box?.width??canvas.width)*k),bh=even((l.box?.height??canvas.height)*k);
      const crop=l.crop?`crop=iw*${l.crop.w}:ih*${l.crop.h}:iw*${l.crop.x}:ih*${l.crop.y},`:'';
      const fit=l.fit==='cover'
        ?`scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh}${l.center!==undefined?`:x='clip(iw*${l.center.toFixed(4)}-${bw}/2,0,iw-${bw})':y='(ih-${bh})/2'`:''}`
        :`scale=${bw}:${bh}:force_original_aspect_ratio=decrease,pad=${bw}:${bh}:(ow-iw)/2:(oh-ih)/2:black`;
      const z=l.zoom;
      const zoom=z?`,scale=${even(bw*z.scale)}:${even(bh*z.scale)}`:'';
      const x=z?Math.round(((1-z.scale)/2+z.dx)*cw):Math.round((l.box?.x??0)*k);
      const y=z?Math.round(((1-z.scale)/2+z.dy)*ch):Math.round((l.box?.y??0)*k);
      return {vf:`${crop}${fit}${zoom}`,x,y};
    };
    for(const l of s.layers) {
      const file=still.get(`${l.clip}@${l.t}`);
      if(!file)continue;
      inputs.push('-i',file);
      const p=place(l);
      graph.push(`[${idx}:v]${p.vf}[l${idx}]`,`[${last}][l${idx}]overlay=${p.x}:${p.y}[o${idx}]`);
      last=`o${idx}`;
      idx++;
    }
    for(const g of s.graphics) {
      // Alpha-aware VP9 decode, as the render does.
      inputs.push('-c:v','libvpx-vp9','-ss',String(Math.max(0,g.t)),'-i',g.webm);
      graph.push(`[${idx}:v]scale=${cw}:${ch}[l${idx}]`,`[${last}][l${idx}]overlay=${Math.round((g.shift?.x??0)*cw)}:${Math.round((g.shift?.y??0)*ch)}[o${idx}]`);
      last=`o${idx}`;
      idx++;
    }
    // Text behind the speaker: the full-frame speaker layer, cut out, back on top.
    const speaker=s.graphics.some(g=>g.behind)?s.layers.find(l=>!l.box):undefined;
    const sf=speaker&&still.get(`${speaker.clip}@${speaker.t}`);
    const mask=sf?await maskOf(sf,s.graphics.find(g=>g.behind&&g.mask)?.mask):null;
    if(speaker&&sf&&mask) {
      const p=place(speaker);
      inputs.push('-i',sf,'-i',mask);
      graph.push(`[${idx+1}:v]format=gray,scale=${FETCH_WIDTH}:-2[m${idx}]`,`[${idx}:v]scale=${FETCH_WIDTH}:-2[s${idx}]`,
        `[s${idx}][m${idx}]alphamerge,format=rgba,${p.vf}[l${idx}]`,`[${last}][l${idx}]overlay=${p.x}:${p.y}[o${idx}]`);
      last=`o${idx}`;
      idx+=2;
      s.notes.push(s.graphics.some(g=>g.mask)?'mask (speaker and picked objects) cut out over the graphic':'speaker cut out over the graphic');
    }
    // The brand logo over everything so far, its own shape and see-through kept, as the render draws it.
    for(const l of s.logos??[]) {
      inputs.push('-i',l.file);
      graph.push(`[${idx}:v]format=rgba,scale=${even(l.w*cw)}:-2${l.opacity<1?`,colorchannelmixer=aa=${l.opacity}`:''}[l${idx}]`,
        `[${last}][l${idx}]overlay=${Math.round(l.x*cw)}:${Math.round(l.y*ch)}[o${idx}]`);
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
