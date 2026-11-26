// What a source file is, beyond its length: codec, pixel format, colour
// tags. From that: does it need a light proxy for editing, and is it log or
// HDR footage that must be converted to Rec.709 before the look.
// Local ffmpeg/ffprobe only.
import {existsSync} from 'node:fs';
import {open,rename,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {ClipColor} from '@voxtale/editdoc';
import {ffmpegPath,ffprobePath} from './ffmpeg-path';

export interface MediaInfo {
  width:number;height:number;
  codec:string;pixFmt:string;
  colorTransfer?:string;colorRange?:string;
  duration:number;
  tags:Record<string,string>;
}

async function sh(cmd:string,args:string[],signal?:AbortSignal):Promise<string> {
  const p=Bun.spawn([cmd,...args],{stdout:'pipe',stderr:'pipe',signal});
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  if(code)throw new Error(`${cmd.split('/').pop()} failed: ${err.slice(-300)}`);
  return out;
}

export async function mediaInfo(path:string,signal?:AbortSignal):Promise<MediaInfo|null> {
  const j=JSON.parse(await sh(ffprobePath(),['-v','error','-select_streams','v:0','-show_entries','stream=width,height,codec_name,pix_fmt,color_transfer,color_range:format=duration:format_tags','-of','json',path],signal));
  const s=j.streams?.[0];
  if(!s)return null;
  return {width:Number(s.width)||0,height:Number(s.height)||0,codec:String(s.codec_name??''),pixFmt:String(s.pix_fmt??''),
    ...(s.color_transfer?{colorTransfer:String(s.color_transfer)}:{}),...(s.color_range?{colorRange:String(s.color_range)}:{}),
    duration:Number(j.format?.duration)||0,tags:j.format?.tags??{}};
}

/** Big, odd-codec or 10-bit sources get a 720p H.264 copy for editing; the render reads the original. */
export const needsProxy=(i:Pick<MediaInfo,'width'|'height'|'codec'|'pixFmt'>)=>
  Math.min(i.width,i.height)>720||i.codec!=='h264'||i.pixFmt!=='yuv420p';

/**
 * A light copy for previews, filmstrips and look samples: at most 720 high,
 * H.264 8-bit, keyframe every 15 frames (fast seeks), sound kept. Written to
 * a temp file then renamed, so a stopped copy never passes for a finished one.
 * Reused while newer than its source.
 */
export async function makeProxy(src:string,out:string,o:{height?:number;signal?:AbortSignal}={}):Promise<string> {
  const [s,d]=await Promise.all([stat(src),stat(out).catch(()=>null)]);
  if(d&&d.mtimeMs>=s.mtimeMs)return out;
  const tmp=`${out}.tmp.mp4`,h=o.height??720;
  try {
    await sh(ffmpegPath(),['-v','error','-y','-nostdin','-threads','2','-i',src,'-map','0:v:0','-map','0:a?',
      // Never enlarged: trunc(min(720, ih)/2)*2.
      '-vf',`scale=-2:'trunc(min(${h},ih)/2)*2',format=yuv420p`,
      '-c:v','libx264','-preset','veryfast','-crf','23','-g','15','-c:a','aac','-b:a','160k','-movflags','+faststart',tmp],o.signal);
    await rename(tmp,out);
  } finally {await rm(tmp,{force:true});}
  return out;
}

export interface Size {width:number;height:number}

/**
 * Previews, filmstrips and the face finder read the proxy; crops, eye points
 * and zoom boxes travel as fractions of its frame and land on the original.
 * That holds only when the proxy has the source's shape: same orientation,
 * same aspect within the even-pixel rounding of the scale. bd voxtale-editor-60q.
 */
export function proxyFits(source:Size,proxy:Size):boolean {
  if(!source.width||!source.height||!proxy.width||!proxy.height)return false;
  if((source.width>=source.height)!==(proxy.width>=proxy.height))return false;
  // Width the proxy should have at its height, from the source's aspect; scale=-2 rounds to even.
  const want=proxy.height*source.width/source.height;
  return Math.abs(proxy.width-want)<=2.01;
}

/** A point or box in proxy pixels, in the original's pixels (each axis by its own scale). */
export function proxyToSource<T extends {x:number;y:number;w?:number;h?:number}>(p:T,proxy:Size,source:Size):T {
  const kx=source.width/proxy.width,ky=source.height/proxy.height;
  return {...p,x:p.x*kx,y:p.y*ky,...(p.w!==undefined?{w:p.w*kx}:{}),...(p.h!==undefined?{h:p.h*ky}:{})};
}

/** Maker LUTs fetched by tools/fetch-dji-luts.sh; VOXTALE_EDITOR_LUTS points elsewhere. */
export const LUT_DIR=process.env.VOXTALE_EDITOR_LUTS??join(import.meta.dir,'..','..','models','luts');
const MAKER_LUTS:Record<string,string>={'DJI D-Log M':'DJI D-Log M to Rec.709.cube'};

/** The maker's .cube for a log profile with no formula, when it has been fetched. bd voxtale-editor-bq4. */
export function makerLut(profile:string|undefined,dir=LUT_DIR):string|undefined {
  const f=profile&&MAKER_LUTS[profile];
  return f&&existsSync(join(dir,f))?join(dir,f):undefined;
}

// Darkest point of 3 frames (10-bit, video black = 0, white = 1), measured
// by REDACTED on 160 DJI files: log >= 0.03 (except at night), normal <= 0.021.
const BLACK=0.03;

/** The log profile a brand's consumer cameras shoot; "Log" when there is no known conversion. */
export function profileOf(camera:string):string {
  if(/DJI/i.test(camera))return /inspire|ronin|zenmuse/i.test(camera)?'DJI D-Log/D-Gamut':/pocket ?4/i.test(camera)?'DJI D-Log (Osmo Pocket 4)':'DJI D-Log M';
  // Canon and Fuji have two logs each that the picture cannot tell apart: the commoner one; the other by hand.
  const brands:[RegExp,string][]=[[/apple|iphone/i,'Apple Log/Rec. 2020'],[/sony|ILCE|XAVC/i,'Sony S-Log3/S-Gamut3.Cine'],
    [/panasonic|lumix/i,'Panasonic V-Log/V-Gamut'],[/canon/i,'Canon Log 3/Cinema Gamut'],[/fujifilm/i,'Fuji F-Log/F-Gamut'],[/nikon/i,'Nikon N-Log/Rec. 2020']];
  return brands.find(([r])=>r.test(camera))?.[1]??'Log';
}

/** Pure part of detection: what the tags and the camera's own notes say, before looking at the picture. */
export function colorFromTags(i:Pick<MediaInfo,'pixFmt'|'colorTransfer'|'colorRange'|'tags'>,sonyXml=''):{color:ClipColor;camera:string}|{look:true;camera:string;bits:number;full:boolean} {
  const full=i.colorRange==='pc',t=i.tags;
  const sony=sonyXml.match(/CaptureGammaEquation" value="([^"]+)"/)?.[1],model=sonyXml.match(/modelName="([^"]+)"/)?.[1];
  const gamut=sonyXml.match(/CaptureColorPrimaries" value="([^"]+)"/)?.[1]??'';
  const camera=[t.encoder,t['com.apple.quicktime.make'],t['com.apple.quicktime.model'],t.make,t.model,sony&&`Sony ${model??''}`.trim()].filter(Boolean).join(' ')||(t.major_brand==='XAVC'?'Sony':'');
  const f=full?{fullRange:true}:{};
  if(sony) {
    const log=/s-log3/i.test(sony)?(/cine/i.test(gamut)||!gamut?'Sony S-Log3/S-Gamut3.Cine':'Sony S-Log3/S-Gamut3'):/s-log2/i.test(sony)?'Sony S-Log2/S-Gamut':undefined;
    return {camera,color:{...(log?{log}:{}),from:'camera',why:`camera wrote "${sony}${gamut?` / ${gamut}`:''}"`,...f}};
  }
  if(i.colorTransfer==='arib-std-b67')return {camera,color:{hdr:'hlg',from:'camera',why:'tagged HLG',...f}};
  if(i.colorTransfer==='smpte2084')return {camera,color:{hdr:'pq',from:'camera',why:'tagged PQ (HDR10)',...f}};
  const bits=Number(i.pixFmt.match(/p(\d+)/)?.[1]??8);
  if(bits<10)return {camera,color:{why:`${bits}-bit video: log is shot in 10-bit`,...f}};
  return {look:true,camera,bits,full};
}

async function darkest(path:string,t:number,bits:number,full:boolean,signal?:AbortSignal):Promise<number> {
  const out=await sh(ffmpegPath(),['-v','error','-ss',String(t),'-i',path,'-frames:v','1','-vf','scale=320:-2,signalstats,metadata=print:file=-','-f','null','-'],signal);
  const k=2**(bits-8),[lo,span]=full?[0,255*k]:[16*k,219*k];
  return (Number(out.match(/signalstats\.YMIN=([\d.]+)/)?.[1])-lo)/span;
}

/**
 * Is this video log or HDR? Sony's notes at the file's tail, then HDR tags,
 * then bit depth, then 3 frames: log never reaches video black. Cameras do
 * not always say (DJI tags D-Log M as bt709); the picture does.
 */
export async function detectColor(path:string,info?:MediaInfo|null,signal?:AbortSignal):Promise<ClipColor|undefined> {
  const i=info??await mediaInfo(path,signal);
  if(!i)return undefined;
  const fd=await open(path,'r');
  let xml='';
  try {
    const size=(await fd.stat()).size,tail=Buffer.alloc(Math.min(size,4<<20));
    await fd.read(tail,0,tail.length,size-tail.length);
    xml=tail.toString('latin1');
  } finally {await fd.close();}
  const r=colorFromTags(i,xml);
  if('color' in r)return r.color;
  const black=Math.min(...await Promise.all([0.15,0.5,0.85].map(f=>darkest(path,i.duration*f,r.bits,r.full,signal))));
  const f=r.full?{fullRange:true}:{};
  if(!Number.isFinite(black))return undefined;
  const pct=`${Math.round(black*100)}%`;
  return black>=BLACK
    ? {log:profileOf(r.camera),from:'picture',why:`flat picture: darkest point ${pct}, never true black`,...f}
    : {from:'picture',why:`darkest point ${pct}`,...f};
}
