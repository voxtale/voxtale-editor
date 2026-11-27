// Fast export: passages that show one untouched source (no crop, zoom, grade,
// fade, text or anything over it, the source already at the canvas size, rate
// and codec) are stream-copied from the source instead of encoded. Copies run
// from a clean keyframe to a clean cut point; the frames around them, up to the
// item's ends, are encoded as before. Parts are MPEG-TS (parameter sets in
// band, so copied and encoded parts decode in one stream) joined by the concat
// demuxer with exact durations, then muxed to MP4 by copy.
// Idea from REDACTED editor/fast-video.ts (plain passages done by ffmpeg, the
// rest by the full renderer; frame count checked, else the full renderer).
import type {Picture,RenderPlan} from './render-edit';
import type {VideoCodec} from './encoders';

export type Span=[number,number];

/** A passage to copy: output frames [f0, f1) show `path` from source second `src` on. */
export interface CopyCandidate {path:string;f0:number;f1:number;src:number}
/** Output frames [c0, c1) copied from `path`, `frames` packets from the keyframe at source second `seek`. */
export interface CopyPart {path:string;c0:number;c1:number;seek:number;frames:number}

/** Fewer frames than this (2 s at 30 fps) are not worth a copy. */
export const MIN_COPY_FRAMES=60;
/** How far off the output frame grid a source frame may sit, in frames. */
const GRID=0.15;

/** Burned text and captions: output frames each ASS event draws on. */
export function assBusy(ass:string,fps:number):Span[] {
  const sec=(t:string)=>{const [h,m,s]=t.split(':').map(Number);return (h??0)*3600+(m??0)*60+(s??0);};
  const out:Span[]=[];
  for(const m of ass.matchAll(/^Dialogue:\s*\d+,([\d:.]+),([\d:.]+),/gm))
    out.push([Math.max(0,Math.floor(sec(m[1]!)*fps)),Math.ceil(sec(m[2]!)*fps)]);
  return out;
}

/** A picture drawn as the source is, full frame: nothing a copy would lose. */
export const plainPicture=(p:Picture)=>p.kind==='video'&&p.fit==='cover'&&p.opacity>=1&&!p.zoom.length&&!p.crop&&!p.speed&&!p.box
  &&!p.fx?.length&&!p.lut&&!p.mask&&!p.logo;

/** [a, b) less every span in `cut`. */
export function subtract([a,b]:Span,cut:Span[]):Span[] {
  let out:Span[]=[[a,b]];
  for(const [c0,c1] of cut) {
    if(c1<=c0)continue;
    out=out.flatMap(([x,y]):Span[]=>c1<=x||c0>=y?[[x,y]]:[...(c0>x?[[x,c0] as Span]:[]),...(c1<y?[[c1,y] as Span]:[])]);
  }
  return out;
}

/**
 * Where only one plain picture shows and nothing is drawn over it: passages of
 * at least `minFrames`. `busy`: frames with burned text, captions or timed effects.
 */
export function copyCandidates(plan:Pick<RenderPlan,'pictures'|'fps'>,busy:Span[],minFrames=MIN_COPY_FRAMES):CopyCandidate[] {
  const out:CopyCandidate[]=[];
  for(const p of plan.pictures) {
    if(!plainPicture(p))continue;
    const others=plan.pictures.filter(q=>q!==p).map(q=>[q.fs,q.fe] as Span);
    for(const [f0,f1] of subtract([p.fs,p.fe],[...others,...busy]))
      if(f1-f0>=minFrames)out.push({path:p.path,f0,f1,src:p.in+f0/plan.fps-p.start});
  }
  return out.sort((x,y)=>x.f0-y.f0);
}

/** What ffprobe says of a source's first video stream. */
export interface SourceVideo {
  codec:string;pixFmt:string;width:number;height:number;
  /** r_frame_rate and avg_frame_rate, as numbers. */
  rate:number;avgRate:number;
  sar?:string;transfer?:string;primaries?:string;range?:string;rotated:boolean;
  /** format start_time: ffmpeg's -ss counts from it. */
  startTime:number;
}

const CODEC:Record<VideoCodec,string>={h264:'h264',hevc:'hevc'};

/** Can this source's packets stand in for encoded frames of this plan? 8-bit 4:2:0, the canvas size, the rate, the codec, SDR, upright. */
export function copyableSource(s:SourceVideo,plan:Pick<RenderPlan,'width'|'height'|'fps'>,codec:VideoCodec):boolean {
  const sar=!s.sar||s.sar==='1:1'||s.sar==='0:1'||s.sar==='N/A';
  return s.codec===CODEC[codec]&&s.pixFmt==='yuv420p'&&s.width===plan.width&&s.height===plan.height&&sar&&!s.rotated
    &&Math.abs(s.rate-plan.fps)<1e-3&&Math.abs(s.avgRate-plan.fps)<1e-2
    &&s.range!=='pc'&&s.transfer!=='smpte2084'&&s.transfer!=='arib-std-b67'&&!/bt2020/.test(s.primaries??'');
}

/** One packet in decode order; times in source seconds from start_time. */
export interface Packet {pts:number;key:boolean}

/**
 * The longest copy inside candidate `c`, from its packets in decode order (a
 * window that covers it, plus a little after).
 * - Start: a keyframe no later packet shows before (no leading pictures
 *   from the GOP before: open GOP).
 * - End (exclusive): a decode position every packet before it shows before
 *   every packet after it, so cutting there drops no frame a kept one needs
 *   to be shown in order.
 * - Every copied frame sits on the output grid, one per output frame, inside [f0, f1).
 * Null when nothing of at least `minFrames` fits.
 */
export function copyRange(packets:Packet[],c:CopyCandidate,fps:number,minFrames=MIN_COPY_FRAMES):Omit<CopyPart,'path'>|null {
  const n=packets.length;
  if(!n)return null;
  const at=(pts:number)=>c.f0+(pts-c.src)*fps;
  const suffixMin=new Array<number>(n+1);
  suffixMin[n]=Infinity;
  for(let i=n-1;i>=0;i--)suffixMin[i]=Math.min(packets[i]!.pts,suffixMin[i+1]!);
  for(let i=0;i<n;i++) {
    const k=packets[i]!;
    if(!k.key||suffixMin[i+1]!<k.pts)continue;
    const g0=at(k.pts);
    if(g0<c.f0-GRID)continue;
    if(Math.abs(g0-Math.round(g0))>GRID)continue;
    const c0=Math.round(g0);
    if(c.f1-c0<minFrames)return null;
    // Walk forward: the frames seen must be c0, c0+1, … each once; a clean cut after j keeps them all.
    let best=-1,max=-Infinity,top=-1;
    const seen=new Set<number>();
    for(let j=i;j<n;j++) {
      const g=at(packets[j]!.pts),r=Math.round(g);
      if(Math.abs(g-r)>GRID||r<c0||r>=c.f1||seen.has(r))break;
      seen.add(r);top=Math.max(top,r);
      max=Math.max(max,packets[j]!.pts);
      if(max<suffixMin[j+1]!&&seen.size===top-c0+1)best=j;
    }
    const frames=best-i+1;
    if(best<0||frames<minFrames)continue;
    return {c0,c1:c0+frames,seek:k.pts,frames};
  }
  return null;
}

/** ffmpeg args that copy `frames` packets from the keyframe at `seek` into an MPEG-TS part. Half a frame past the keyframe: ffmpeg seeks back to it. */
export const copyArgs=(p:CopyPart,fps:number,out:string)=>['-ss',(p.seek+0.5/fps).toFixed(6),'-i',p.path,'-map','0:v:0','-c:v','copy','-an','-sn','-dn',
  '-frames:v',String(p.frames),'-f','mpegts','-y',out];

/** ffprobe args for the first video stream of a file. */
export const sourceProbeArgs=(file:string)=>['-v','error','-select_streams','v:0','-show_entries',
  'stream=codec_name,pix_fmt,width,height,sample_aspect_ratio,r_frame_rate,avg_frame_rate,color_range,color_transfer,color_primaries:stream_side_data=rotation:format=start_time',
  '-of','json',file];

const rate=(s?:string)=>{const [a,b]=(s??'0/1').split('/').map(Number);return b?a!/b:Number(a)||0;};
export function parseSourceProbe(json:string):SourceVideo|null {
  const j=JSON.parse(json) as {streams?:Record<string,unknown>[];format?:{start_time?:string}};
  const v=j.streams?.[0] as Record<string,string|number|undefined>&{side_data_list?:{rotation?:number}[]}|undefined;
  if(!v)return null;
  return {codec:String(v.codec_name??''),pixFmt:String(v.pix_fmt??''),width:Number(v.width)||0,height:Number(v.height)||0,
    rate:rate(v.r_frame_rate as string),avgRate:rate(v.avg_frame_rate as string),
    ...(v.sample_aspect_ratio?{sar:String(v.sample_aspect_ratio)}:{}),...(v.color_transfer?{transfer:String(v.color_transfer)}:{}),
    ...(v.color_primaries?{primaries:String(v.color_primaries)}:{}),...(v.color_range?{range:String(v.color_range)}:{}),
    rotated:(v.side_data_list??[]).some(s=>!!s.rotation),startTime:Number(j.format?.start_time)||0};
}

/** ffprobe args listing packets (pts, flags) of source seconds [from, to), absolute times. */
export const packetProbeArgs=(file:string,from:number,to:number)=>['-v','error','-select_streams','v:0','-read_intervals',`${Math.max(0,from).toFixed(3)}%${to.toFixed(3)}`,
  '-show_entries','packet=pts_time,flags','-of','csv=p=0',file];
export function parsePackets(csv:string,startTime:number):Packet[] {
  const out:Packet[]=[];
  for(const line of csv.split('\n')) {
    const [pts,flags]=line.trim().split(',');
    const t=Number(pts);
    if(!pts||pts==='N/A'||!Number.isFinite(t))continue;
    out.push({pts:t-startTime,key:(flags??'').includes('K')});
  }
  return out;
}

/**
 * The output in order: copy parts where given, chunks of about `per` frames
 * between them (chunkBounds keeps held ranges whole).
 */
export function mixedChunks(frames:number,per:number,holds:Span[],copies:CopyPart[],
  bounds:(frames:number,per:number,holds:Span[])=>{c0:number;c1:number}[]):{k:number;c0:number;c1:number;copy?:CopyPart}[] {
  const out:{k:number;c0:number;c1:number;copy?:CopyPart}[]=[];
  let at=0;
  const fill=(a:number,b:number)=>{
    if(b<=a)return;
    const local=holds.map(([h0,h1])=>[h0-a,h1-a] as Span);
    for(const x of bounds(b-a,per,local))out.push({k:out.length,c0:x.c0+a,c1:x.c1+a});
  };
  for(const c of [...copies].sort((x,y)=>x.c0-y.c0)) {
    if(c.c0<at||c.c1>frames)continue;
    fill(at,c.c0);
    out.push({k:out.length,c0:c.c0,c1:c.c1,copy:c});
    at=c.c1;
  }
  fill(at,frames);
  return out;
}
