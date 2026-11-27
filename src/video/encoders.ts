// The machine's video encoder: the Apple chip on a Mac (VideoToolbox); elsewhere
// the first GPU encoder that really works (NVIDIA, Intel, AMD, then Windows'
// own), else the CPU (libx264 / libx265). Listed in ffmpeg does not mean usable
// (no NVIDIA card, say), so each one encodes a few black frames first. Found
// once per ffmpeg and codec, then cached for the process.
import {spawnText} from '../spawn';
import {ffmpegPath} from './ffmpeg-path';

export type VideoCodec='h264'|'hevc';
export interface VideoEncoder {codec:VideoCodec;name:string;hardware:boolean}

/** Tried in order off a Mac. */
export const HARDWARE:Record<VideoCodec,{darwin:string[];other:string[]}>={
  h264:{darwin:['h264_videotoolbox'],other:['h264_nvenc','h264_qsv','h264_amf','h264_mf']},
  hevc:{darwin:['hevc_videotoolbox'],other:['hevc_nvenc','hevc_qsv','hevc_amf','hevc_mf']},
};
export const SOFTWARE:Record<VideoCodec,string>={h264:'libx264',hevc:'libx265'};

export type EncoderTest=(ffmpeg:string,args:string[])=>Promise<boolean>;
const ffTest:EncoderTest=(ffmpeg,args)=>spawnText(ffmpeg,args,{timeoutMs:20_000}).then(r=>r.code===0,()=>false);

/** A few black frames through `name` and thrown away: does it really encode here? */
export const testArgs=(name:string)=>['-hide_banner','-nostdin','-v','error','-f','lavfi','-i','color=black:s=256x144:r=30:d=0.2',
  ...hardwareFlags(name),'-pix_fmt',pixFmt(name),'-frames:v','3','-c:v',name,'-f','null','-'];

export interface DetectOptions {
  codec?:VideoCodec;
  ffmpeg?:string;
  platform?:string;
  env?:Record<string,string|undefined>;
  test?:EncoderTest;
}

/**
 * VOXTALE_EDITOR_ENCODER: unset or "auto" picks as above; "software" (or "cpu")
 * keeps libx264 / libx265; any other value is an ffmpeg encoder name, used as is.
 */
export async function findEncoder(o:DetectOptions={}):Promise<VideoEncoder> {
  const codec=o.codec??'h264',env=o.env??process.env,platform=o.platform??process.platform;
  const want=(env.VOXTALE_EDITOR_ENCODER??'auto').trim().toLowerCase();
  const soft={codec,name:SOFTWARE[codec],hardware:false};
  if(want==='software'||want==='cpu')return soft;
  if(want&&want!=='auto')return {codec,name:want,hardware:!/^lib/.test(want)};
  const ffmpeg=o.ffmpeg??ffmpegPath(),test=o.test??ffTest;
  const list=platform==='darwin'?HARDWARE[codec].darwin:HARDWARE[codec].other;
  for(const name of list)if(await test(ffmpeg,testArgs(name)))return {codec,name,hardware:true};
  return soft;
}

const cache=new Map<string,Promise<VideoEncoder>>();
/** findEncoder, once per ffmpeg, codec and override for this process. */
export function machineEncoder(o:Omit<DetectOptions,'test'|'platform'|'env'>={}):Promise<VideoEncoder> {
  const ffmpeg=o.ffmpeg??ffmpegPath(),codec=o.codec??'h264';
  const key=[ffmpeg,codec,process.env.VOXTALE_EDITOR_ENCODER??''].join('\0');
  let found=cache.get(key);
  if(!found){found=findEncoder({ffmpeg,codec});cache.set(key,found);}
  return found;
}
/** Forget what machineEncoder found (tests). */
export const clearEncoderCache=()=>cache.clear();

/** VideoToolbox: the Apple chip when there is one, else Apple's CPU encoder, rather than a failed export (Intel Mac, VM). */
const hardwareFlags=(name:string)=>/_videotoolbox$/.test(name)?['-allow_sw','1']:[];
/** GPU encoders off a Mac take NV12; VideoToolbox and the CPU take yuv420p. */
const pixFmt=(name:string)=>/_(nvenc|qsv|amf|mf)$/.test(name)?'nv12':'yuv420p';

export interface EncodeQuality {
  /** x264/x265 constant quality (18 ≈ visually clean). */
  crf:number;
  /** x264/x265 speed preset. */
  preset:string;
  width:number;height:number;fps:number;
}

/**
 * Bits per second a GPU encoder gets for `crf`: GPU encoders have no CRF that
 * means the same, so a bitrate from pixels per second. 0.2 bits per pixel at
 * crf 18 (≈12 Mbit/s at 1080p30), halved every 6 crf, as x264's scale; HEVC
 * needs about 60% of that. Our pick, not measured.
 */
export function targetBitrate(codec:VideoCodec,q:Pick<EncodeQuality,'crf'|'width'|'height'|'fps'>):number {
  const bpp=0.2*2**((18-q.crf)/6)*(codec==='hevc'?0.6:1);
  return Math.max(500_000,Math.round(q.width*q.height*q.fps*bpp/1000)*1000);
}

/** The ffmpeg output args that encode with `enc`: codec, rate control, pixel format. Same for every chunk, so chunks join by copy. The MP4 tag is muxTag's. */
export function encodeArgs(enc:VideoEncoder,q:EncodeQuality):string[] {
  if(!enc.hardware)return ['-c:v',enc.name,'-preset',q.preset,'-crf',String(q.crf),'-pix_fmt','yuv420p'];
  const b=targetBitrate(enc.codec,q);
  const own=/_videotoolbox$/.test(enc.name)?[...hardwareFlags(enc.name),'-profile:v',enc.codec==='hevc'?'main':'high']
    :/_nvenc$/.test(enc.name)?['-preset','p5','-rc','vbr']
    :/_amf$/.test(enc.name)?['-quality','quality']
    // h264_mf takes no -profile:v; qsv and mf as they come.
    :[];
  return ['-c:v',enc.name,...own,'-b:v',String(b),'-maxrate',String(Math.round(b*1.5)),'-bufsize',String(b*2),
    '-pix_fmt',pixFmt(enc.name)];
}

/** MP4 sample tag: hvc1 so Apple players open HEVC; H.264 keeps ffmpeg's avc1. */
export const muxTag=(codec:VideoCodec)=>codec==='hevc'?['-tag:v','hvc1']:[];
