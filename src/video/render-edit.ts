import {ffmpegPath,ffprobePath} from './ffmpeg-path';
// Cloud render of an EditDoc to one MP4 with ffmpeg: the same picture, mix and
// timing VoxTale Desktop exports, without a browser. Runs no generated code.
//
// The timeline renders in frame-exact chunks (bounded filter graphs, so a long
// edit with thousands of cuts stays cheap), each chunk once for picture and once
// for sound. Chunks join by stream copy, then one loudness pass lands the mix on
// the edit's target, as the desktop export does.
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
  CAPTION_DIM,CAPTION_POP,captionLook,captionPlacement,captionText,captionWords,cutFade,dbToVolume,duckPoints,lanes,limiterCeiling,loudnessGain,mixSpeech,parseLoudness,
  shown,textContent,toSrt,textLook,textPosition,pipBox,transitionJoins,zoomKeysBetween,
  SETTLE_BACK,splitBoxes,stackBoxes,coverRegion,companionSources,speechSounds,clipLut,parseCube,pictureSource,writeCube,LUT_SIZE,type Easing,type EditDoc,type MotionTrack,type Reframe,trackAt,type LoudnessLevel,type MaskObject,type ZoomKey,type ZoomProperty,
} from '@voxtale/editdoc';
import {run} from './media';
import {encodeArgs,machineEncoder,muxTag,SOFTWARE,type VideoEncoder} from './encoders';
import {assBusy,copyArgs,copyCandidates,copyRange,copyableSource,mixedChunks,packetProbeArgs,parsePackets,parseSourceProbe,sourceProbeArgs,type CopyPart} from './fast-copy';
import {writeLibrary} from './sfx';

export const SAMPLE_RATE=48000;
/** Volume changes land on this many samples; fades stay smooth at a few ms. */
const VOLUME_STEP=64;
/** ASS font size per CSS pixel: libass sizes by ascender+descender, CSS by em (Inter's ratio). */
const ASS_FONT_SCALE=1.21;
const TEXT_LINE_HEIGHT=1.2,CAPTION_LINE_HEIGHT=1.3,BOX_PAD=10;

export interface RenderEditOptions {
  doc:EditDoc;
  /** Clip content hash → full-quality file on disk. */
  media:Record<string,string>;
  /** Graphic asset id → alpha WebM at canvas size. A graphic without one is left out and reported. */
  graphics?:Record<string,string>;
  /**
   * Writes a subject (person) mask video for source seconds [start, end) of a clip at `fps` to `out`; false when it
   * cannot (no model). Graphics marked behindSubject need it; without it they are drawn over the speaker and reported.
   */
  subjectMask?:SubjectMasker;
  out:string;
  /** Scratch folder; emptied when the render ends. */
  work:string;
  ffmpeg?:string;
  ffprobe?:string;
  /** Extra fonts folder for text and captions (brand fonts). */
  fontsDir?:string;
  /**
   * "burn" (default) draws captions into the picture. "track" leaves the
   * picture clean and adds them as a subtitle track the player can switch
   * off and an editor can still change.
   */
  captions?:'burn'|'track';
  chunkSeconds?:number;
  concurrency?:number;
  preset?:string;
  crf?:number;
  progress?:(fraction:number)=>void;
  signal?:AbortSignal;
  /** Delivery size and rate, when they differ from the doc's canvas and fps (see outputFilter). */
  output?:OutputShape;
  /** Video encoder; default the machine's (encoders.ts: GPU when one works, else libx264). */
  encoder?:VideoEncoder;
  /**
   * Stream-copy passages of one untouched source instead of encoding them
   * (fast-copy.ts). Opt-in (fast: true), default off until the joined file is checked
   * in QuickTime; ignored when the output is reshaped. The joined
   * file is checked frame by frame count, and rendered again without copies if short.
   */
  fast?:boolean;
}

/**
 * The file a brief asks for. The cut is composed at its canvas, then scaled
 * whole into width x height: "contain" (default) letterboxes or pillarboxes
 * and never crops; "cover" fills the frame and crops the overflow. fps
 * resamples the frame rate.
 */
export interface OutputShape {width?:number;height?:number;fps?:number;fit?:'contain'|'cover'}

/** The ffmpeg -vf that turns a canvas-sized render into `shape`, or null when nothing changes. */
export function outputFilter(canvas:{width:number;height:number},fps:number,shape:OutputShape={}):string|null {
  const W=shape.width??canvas.width,H=shape.height??canvas.height,steps:string[]=[];
  if(W%2||H%2)throw new Error(`output size must be even: ${W}x${H}`);
  if(W!==canvas.width||H!==canvas.height) {
    if(shape.fit==='cover')steps.push(`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos`,`crop=${W}:${H}`);
    else steps.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`,`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`);
    steps.push('setsar=1');
  }
  if(shape.fps&&Math.abs(shape.fps-fps)>1e-3)steps.push(`fps=${num(shape.fps)}`);
  return steps.length?steps.join(','):null;
}

export interface RenderEditResult {
  out:string;
  frames:number;
  duration:number;
  /** The mix as rendered (before), the one gain step, and the delivered file measured again (after). */
  loudness?:{before:LoudnessLevel;gainDb:number;after?:LoudnessLevel};
  /** Clips drawn through a colour grade (their 3D LUT). */
  graded?:string[];
  /** Items drawn or heard other than asked: a graphic still rendering, its subject mask missing, an angle/mic/companion that does not cover the piece (master used). */
  skipped:{itemId:string;reason:'graphic-not-ready'|'subject-mask-missing'|'angle-out-of-range'|'mic-out-of-range'|'companion-out-of-range'}[];
  /** The encoder used, and output frames stream-copied from sources instead of encoded. */
  encoder?:string;
  copiedFrames?:number;
}
/**
 * Request for one mask video. `subject` (default true): the person mask is the base; `objects`: picked objects added to it
 * or cut out of it (MaskObject with its clip dropped; `t` is a source second of the same clip).
 */
export interface SubjectMaskRequest {video:string;start:number;end:number;fps:number;out:string;subject?:boolean;objects?:Omit<MaskObject,'clipId'>[]}
export type SubjectMasker=(o:SubjectMaskRequest)=>Promise<boolean>;

export class MissingMediaError extends Error {
  constructor(readonly clips:string[]) {super(`Missing media for ${clips.length} clip(s): ${clips.join(', ')}`);}
}

// ---- timeline model ---------------------------------------------------------------

export interface Picture {
  itemId:string;
  path:string;
  kind:'video'|'image'|'graphic';
  /** Output frames [fs, fe). */
  fs:number;fe:number;
  start:number;
  in:number;
  fit:'cover'|'contain';
  opacity:number;
  zoom:ZoomKey[];
  /** Part of the source frame shown, fractions of it. */
  crop?:{x:number;y:number;w:number;h:number};
  /** Source seconds per output second. */
  speed?:number;
  /** Drawn into this box of the canvas (pixels) instead of the whole frame: the speaker in a corner. */
  box?:{x:number;y:number;width:number;height:number};
  /** Timed effects, output seconds: transitions and picture fades. */
  fx?:PictureFx[];
  /** .cube file of the clip's colour grade, applied to every frame. */
  lut?:string;
  /** Alpha from this mask video (white = keep); its frame 0 shows source second `in`. The speaker drawn over a graphic. */
  mask?:{path:string;in:number};
  /** The brand logo: scaled to box.width, its own shape and see-through kept, no border, top-left at box.x,box.y. */
  logo?:true;
  /** A stack band (v9): fills its box edge to edge, no border. */
  band?:true;
  /** Auto reframe (cover fit, whole frame): the crop follows the speaker instead of the middle. */
  reframe?:Reframe;
  /** A graphic pinned to the set: it moves with the spot (offsets in canvas fractions, item seconds). */
  track?:MotionTrack;
}
/** Fade to or from see-through (no colour) or a flat colour; slide across (fractions of the width); scale up or down; blur sideways. */
export type PictureFx=
  |{type:'fade';t0:number;t1:number;dir:'in'|'out';color?:'black'|'white'}
  |{type:'slide';t0:number;t1:number;from:number;to:number}
  |{type:'push';t0:number;t1:number;from:number;to:number;curve:'in'|'out'}
  |{type:'blur';t0:number;t1:number};
interface Sound {
  path:string;
  start:number;end:number;
  in:number;
  volume:number;
  fadeIn:number;fadeOut:number;
  /** Volume over the item's own time, replacing `volume` where present. */
  duck:{time:number;value:number}[];
}
interface Caption {start:number;end:number;layer:number;lines:{text:string;x:number;y:number;
  /** Moves in a straight line from x,y to here over the event (a motion-tracked text). */
  to?:{x:number;y:number};
  /** Ready ASS text with its own override tags, used as is. */
  ass?:string}[];style:string;tags:string}

export interface RenderPlan {
  width:number;height:number;
  rate:string;fps:number;
  /** MP4 ticks per second: a whole number of ticks per frame. */
  timescale:number;
  frames:number;
  pictures:Picture[];
  sounds:Sound[];
  ass:string;
  skipped:RenderEditResult['skipped'];
  /** Output frame ranges a chunk boundary must not split (timed effects run inside one chunk). */
  holds:[number,number][];
}

/** First output frame at or after `t`: the frame OpenReel shows an item from. */
const frameAt=(t:number,fps:number)=>Math.ceil(t*fps-1e-6)||0;

const TRACK_DRAW=['a-roll','b-roll','graphics'] as const;

export {splitBoxes};

/** A mask video whose frame 0 shows source second `in`. */
export interface SubjectMask {path:string;in:number}
/** A piece of a-roll a behindSubject graphic covers, and the source seconds its mask must span (in the clip shown: the angle on multicam). */
export interface SubjectSpan {key:string;graphicId:string;arollId:string;clipId:string;start:number;end:number;srcStart:number;srcEnd:number;
  /** The person mask is the base (behindSubject); false: the added objects alone. */
  subject:boolean;
  /** Picked objects on this clip, added to or cut out of the mask. */
  objects:Omit<MaskObject,'clipId'>[]}

/**
 * Where the speaker goes back over a graphic: each behindSubject graphic against each shown a-roll piece under it,
 * less the time full-frame b-roll hides the speaker.
 */
export function subjectSpans(doc:EditDoc):SubjectSpan[] {
  const cover=shown(doc.tracks['b-roll']).filter(b=>!b.pip&&b.opacity>=1).map(b=>[b.start,b.end] as const).sort((x,y)=>x[0]-y[0]);
  const out:SubjectSpan[]=[];
  for(const g of shown(doc.tracks.graphics)) {
    if(!g.behindSubject&&!g.maskObjects?.some(o=>o.mode==='add'))continue;
    for(const a of shown(doc.tracks['a-roll'])) {
      const src=pictureSource(doc,a);
      const objects=(g.maskObjects??[]).filter(o=>o.clipId===src.clipId).map(({clipId:_,...o})=>o);
      // Without the person, only objects added on this clip put anything over the graphic.
      if(!g.behindSubject&&!objects.some(o=>o.mode==='add'))continue;
      let s=Math.max(a.start,g.start);
      const e=Math.min(a.end,g.end);
      const pieces:[number,number][]=[];
      for(const [b0,b1] of cover) {
        if(b1<=s||b0>=e)continue;
        if(b0>s)pieces.push([s,b0]);
        s=Math.max(s,b1);
      }
      if(s<e)pieces.push([s,e]);
      for(const [p0,p1] of pieces)if(p1-p0>1e-3)out.push({key:`${g.id}.${a.id}.${p0.toFixed(3)}`,graphicId:g.id,arollId:a.id,clipId:src.clipId,
        start:p0,end:p1,srcStart:src.in+(p0-a.start),srcEnd:src.in+(p1-a.start),subject:!!g.behindSubject,objects});
    }
  }
  return out;
}

/** What to draw and play, bottom layer first. Throws MissingMediaError when a clip's file is not in `media`. */
export function planRender(doc:EditDoc,media:Record<string,string>,graphics:Record<string,string>={},luts:Record<string,string>={},
  /** SubjectSpan key → its mask video (subjectSpans). */
  masks:Record<string,SubjectMask>={}):RenderPlan {
  const fps=doc.fps.num/doc.fps.den;
  const {width,height}=doc.canvas;
  const clips=new Map(doc.clips.map(c=>[c.id,c]));
  const missing=new Set<string>();
  const pathOf=(clipId:string)=>{
    const c=clips.get(clipId);
    const p=c&&media[c.hash];
    if(!p)missing.add(c?.name??clipId);
    return p??'';
  };
  const skipped:RenderPlan['skipped']=[];
  const pictures:Picture[]=[];
  const behind:string[]=[];
  // Bottom first: a-roll, b-roll, graphics; within a track the last lane first.
  for(const kind of TRACK_DRAW) {
    const items=shown(doc.tracks[kind] as {id:string;status:string;start:number;end:number}[]);
    const lane=lanes(items);
    const order=items.map((item,i)=>({item,lane:lane[i]!})).sort((a,b)=>b.lane-a.lane);
    for(const {item} of order) {
      const fs=frameAt(item.start,fps),fe=frameAt(item.end,fps);
      if(fe<=fs)continue;
      if(kind==='graphics') {
        const g=item as EditDoc['tracks']['graphics'][number];
        const path=graphics[g.assetId];
        if(!path) {skipped.push({itemId:g.id,reason:'graphic-not-ready'});continue;}
        pictures.push({itemId:g.id,path,kind:'graphic',fs,fe,start:g.start,in:0,fit:'contain',opacity:1,zoom:[],...(g.track?{track:g.track}:{})});
        behind.push(g.id);
        continue;
      }
      const c=item as EditDoc['tracks']['a-roll'][number]|EditDoc['tracks']['b-roll'][number];
      const b=kind==='b-roll'?c as EditDoc['tracks']['b-roll'][number]:null;
      const a=kind==='a-roll'?c as EditDoc['tracks']['a-roll'][number]:null;
      // Multicam: the picture comes from the piece's angle, read in step through its sync group.
      const src=a?pictureSource(doc,a):{clipId:c.clipId,in:c.in,out:c.out,fellBack:false};
      if(src.fellBack)skipped.push({itemId:c.id,reason:'angle-out-of-range'});
      const clip=clips.get(src.clipId);
      const path=pathOf(src.clipId);
      const two=a?companionSources(doc,a,src.clipId):[];
      const split=a?.layout==='split'&&two.length>0,pip=a?.layout==='pip'&&two.length>0;
      if((a?.layout==='split'||a?.layout==='pip')&&!two.length)skipped.push({itemId:c.id,reason:'companion-out-of-range'});
      const stack=a?.layout==='stack'&&a.stack?a.stack:null;
      const halves=split?splitBoxes(doc.canvas):stack?stackBoxes(doc.canvas,stack.split):null;
      // Stack: two bands of this one picture, webcam region on top, game region below.
      const size=clip?.width&&clip.height?{width:clip.width,height:clip.height}:doc.canvas;
      pictures.push({
        itemId:c.id,path,kind:clip?.kind==='image'?'image':'video',fs,fe,start:c.start,in:src.in,
        fit:b?b.fit:'cover',opacity:b?b.opacity:1,
        zoom:a&&!split&&!stack?zoomKeysBetween(doc.tracks.zoom,c.start,c.end,doc.canvas):[],
        ...(stack?{crop:coverRegion(size,stack.top,halves![0]),band:true as const}:{}),
        ...(halves?{box:halves[0]}:{}),
        ...(clip?.kind==='video'&&clip.reframe&&!halves&&!b?.crop&&(b?b.fit==='cover':true)?{reframe:clip.reframe}:{}),
        ...(b?.crop?{crop:b.crop}:{}),...(b?.speed&&b.speed!==1?{speed:b.speed}:{}),...(luts[src.clipId]?{lut:luts[src.clipId]}:{}),
      });
      // Split: the companion beside (or under, on a tall canvas); pip: the first companion small in a corner.
      if(stack) pictures.push({itemId:`${c.id}.stack`,path,kind:clip?.kind==='image'?'image':'video',fs,fe,start:c.start,in:src.in,fit:'cover',opacity:1,zoom:[],
        box:halves![1],crop:coverRegion(size,stack.bottom,halves![1]),band:true,...(luts[src.clipId]?{lut:luts[src.clipId]}:{})});
      const m=two[0];
      if(m&&(split||pip)) {
        const box=split?halves![1]:pipBox(doc.canvas,a!.pipCorner??'bottom-right');
        pictures.push({itemId:`${c.id}.${split?'split':'pip'}`,path:pathOf(m.clipId),kind:clips.get(m.clipId)?.kind==='image'?'image':'video',fs,fe,start:c.start,in:m.in,fit:'cover',opacity:1,zoom:[],box,...(luts[m.clipId]?{lut:luts[m.clipId]}:{})});
      }
    }
    if(kind!=='graphics')applyTransitions(doc,kind,pictures,fps);
    applyFades(items as Faded[],pictures);
    // The speaker in a corner over footage that asks for it: each a-roll piece under the shot, drawn small on top.
    if(kind==='b-roll')for(const b of shown(doc.tracks['b-roll'])) {
      if(!b.pip)continue;
      const box=pipBox(doc.canvas,b.pip);
      for(const a of shown(doc.tracks['a-roll'])) {
        const s=Math.max(a.start,b.start),e=Math.min(a.end,b.end),fs=frameAt(s,fps),fe=frameAt(e,fps);
        if(fe<=fs||clips.get(a.clipId)?.kind!=='video')continue;
        pictures.push({itemId:`${b.id}.pip.${a.id}`,path:pathOf(a.clipId),kind:'video',fs,fe,start:s,in:a.in+(s-a.start),fit:'cover',opacity:1,zoom:[],box,...(luts[a.clipId]?{lut:luts[a.clipId]}:{})});
      }
    }
  }

  // Text behind the speaker: the a-roll under it again, cut out by its subject mask, on top of the graphic.
  const spans=subjectSpans(doc).filter(x=>behind.includes(x.graphicId));
  for(const x of spans) {
    const base=pictures.find(p=>p.itemId===x.arollId&&p.kind==='video');
    const mask=masks[x.key];
    if(!mask||!base) {if(!skipped.some(k=>k.itemId===x.graphicId&&k.reason==='subject-mask-missing'))skipped.push({itemId:x.graphicId,reason:'subject-mask-missing'});continue;}
    const fs=frameAt(x.start,fps),fe=frameAt(x.end,fps);
    if(fe<=fs)continue;
    const at=pictures.findIndex(p=>p.itemId===x.graphicId)+1;
    pictures.splice(at,0,{...base,itemId:`${x.graphicId}.subject.${x.arollId}`,fs,fe,mask});
  }

  // The brand logo, above everything drawn so far; captions and text come later, on top.
  const logos=doc.logos.filter(l=>clips.get(l.clipId)?.kind==='image');
  for(const l of logos) {
    const fs=frameAt(l.start,fps),fe=frameAt(l.end,fps);
    if(fe<=fs)continue;
    const w=Math.max(2,Math.round(l.w*width/2)*2);
    pictures.push({itemId:l.id,path:pathOf(l.clipId),kind:'image',fs,fe,start:l.start,in:0,fit:'contain',opacity:l.opacity,zoom:[],logo:true,
      box:{x:Math.round(l.x*width),y:Math.round(l.y*height),width:w,height:w}});
  }
  applyFades(logos,pictures);

  const {mix}=doc;
  const speech=mixSpeech(doc);
  const sounds:Sound[]=[];
  const sounding=(clipId:string)=>{const c=clips.get(clipId);return !!c&&c.hasAudio&&c.kind!=='image';};
  // J/L cuts, mic picks and avOffset: where and what each piece is heard (speechSounds).
  for(const h of speechSounds(doc)) {
    const f=cutFade(doc,h.span);
    if(h.fellBack)skipped.push({itemId:h.item.id,reason:'mic-out-of-range'});
    sounds.push({path:pathOf(h.clipId),start:h.start,end:h.end,in:h.in,volume:dbToVolume(h.item.gainDb+mix.speechGainDb),fadeIn:f,fadeOut:f,duck:[]});
  }
  for(const b of shown(doc.tracks['b-roll'])) {
    if(b.muted||!sounding(b.clipId))continue;
    sounds.push({path:pathOf(b.clipId),start:b.start,end:b.end,in:b.in,volume:1,fadeIn:0,fadeOut:0,duck:[]});
  }
  for(const m of shown(doc.tracks.music)) {
    if(!sounding(m.clipId))continue;
    const d=m.end-m.start,volume=dbToVolume(m.gainDb);
    sounds.push({
      path:pathOf(m.clipId),start:m.start,end:m.end,in:m.in,volume,
      fadeIn:Math.min(m.fadeIn,d/2),fadeOut:Math.min(m.fadeOut,d/2),
      duck:m.duck?duckPoints(speech,m.start,d,volume,dbToVolume(m.gainDb+mix.duckingDb),mix.duckAttack,mix.duckRelease):[],
    });
  }
  for(const s of [...shown(doc.tracks.sfx),...shown(doc.tracks.voiceover)]) {
    if(!sounding(s.clipId))continue;
    sounds.push({path:pathOf(s.clipId),start:s.start,end:s.end,in:s.in,volume:dbToVolume(s.gainDb),fadeIn:0,fadeOut:0,duck:[]});
  }
  if(missing.size)throw new MissingMediaError([...missing]);

  const holds=pictures.flatMap(p=>(p.fx??[]).map(x=>[Math.floor(x.t0*fps+1e-6),Math.ceil(x.t1*fps-1e-6)] as [number,number]));
  const ends=[...pictures.map(p=>p.fe),...sounds.map(s=>frameAt(s.end,fps))];
  for(const t of shown(doc.tracks.text))ends.push(frameAt(t.end,fps));
  return {
    width,height,rate:`${doc.fps.num}/${doc.fps.den}`,fps,timescale:doc.fps.num*Math.ceil(90000/doc.fps.num),
    frames:Math.max(0,...ends),
    pictures,sounds,ass:assScript(doc,fps),skipped,holds,
  };
}

// ---- text and captions (ASS) ----------------------------------------------------

/** CSS colour (#rrggbb or rgba()) to ASS colour and alpha. */
function assColor(css:string):{color:string;alpha:string} {
  let r=255,g=255,b=255,a=1;
  const m=/^rgba?\(([^)]+)\)$/.exec(css.trim());
  if(m) {
    const p=m[1]!.split(',').map(Number);
    [r,g,b]=[p[0]??255,p[1]??255,p[2]??255];a=p[3]??1;
  } else if(/^#[0-9a-f]{6}$/i.test(css)) {
    const n=parseInt(css.slice(1),16);r=(n>>16)&255;g=(n>>8)&255;b=n&255;
  }
  const hex=(x:number)=>Math.round(Math.max(0,Math.min(255,x))).toString(16).toUpperCase().padStart(2,'0');
  return {color:`&H${hex(b)}${hex(g)}${hex(r)}&`,alpha:`&H${hex(255*(1-a))}&`};
}

function assTime(seconds:number):string {
  const cs=Math.max(0,Math.round(seconds*100));
  const h=Math.floor(cs/360000),m=Math.floor(cs/6000)%60,s=Math.floor(cs/100)%60;
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;
}

/** ASS has no escape for braces or backslashes; swap them for look-alikes. */
const assText=(s:string)=>s.replace(/\\/g,'⧵').replace(/\{/g,'(').replace(/\}/g,')');

/** One ASS script with every text item and caption, laid out as OpenReel draws them. */
export function assScript(doc:EditDoc,fps:number):string {
  const {width:W,height:H}=doc.canvas;
  const {brand}=doc.styleRef.snapshot;
  const events:Caption[]=[];
  // Events span half a frame either side of the frames that show them, so centisecond rounding never moves a frame.
  const span=(start:number,end:number)=>({start:(frameAt(start,fps)-0.5)/fps,end:(frameAt(end,fps)-0.5)/fps});
  const box=(look:{fontSize:number},lineHeight:number,bg:string)=>{
    const {color,alpha}=assColor(bg);
    const ybord=Math.max(0,(lineHeight-look.fontSize*ASS_FONT_SCALE)/2);
    return `\\3c${color}\\3a${alpha}\\xbord${BOX_PAD}\\ybord${ybord.toFixed(1)}`;
  };
  const captions=captionPlacement(doc);
  for(const t of shown(doc.tracks.text)) {
    const text=textContent(t);
    const look=textLook(t.template,brand,H,t.look);
    const pos=textPosition(t.template,t.position,{text,brand,captions,width:W,height:H,fontSize:look.fontSize});
    const lh=look.fontSize*TEXT_LINE_HEIGHT;
    const lines=text.split('\n');
    const fill=assColor(look.color);
    let tags=`\\fn${look.fontFamily}\\fs${(look.fontSize*ASS_FONT_SCALE).toFixed(1)}\\b${look.fontWeight}\\c${fill.color}\\1a${fill.alpha}`;
    let style='Plain';
    if(look.backgroundColor) {style='Box';tags+=box(look,lh,look.backgroundColor);}
    else if(look.shadowColor) {
      const s=assColor(look.shadowColor);
      tags+=`\\bord3\\blur${Math.round((look.shadowBlur??0)/2)}\\3c${s.color}\\3a${s.alpha}`;
    }
    const fad=(a:number,b:number)=>a||b?`\\fad(${Math.round(a*1000)},${Math.round(b*1000)})`:'';
    const lineAt=(i:number,st:{dx:number;dy:number;s:number})=>({x:(pos.x+st.dx)*W,y:(pos.y+st.dy)*H+(i-(lines.length-1)/2)*lh*st.s});
    if(t.track) {
      // Pinned to the set: one event per stretch between track keys, moving in a straight line (\move), scaled (\t) when the set grows.
      const len=t.end-t.start,times=[...new Set([0,...t.track.keys.map(k=>k.t).filter(x=>x>0&&x<len),len])].sort((a,b)=>a-b);
      for(let k=0;k+1<times.length;k++) {
        const a=trackAt(t.track,times[k]!),b=trackAt(t.track,times[k+1]!),when=span(t.start+times[k]!,t.start+times[k+1]!);
        if(when.end<=when.start)continue;
        const ms=Math.round((when.end-when.start)*1000),pct=(v:number)=>(v*100).toFixed(1);
        const grow=Math.abs(a.s-1)>1e-3||Math.abs(b.s-1)>1e-3?`\\fscx${pct(a.s)}\\fscy${pct(a.s)}\\t(0,${ms},\\fscx${pct(b.s)}\\fscy${pct(b.s)})`:'';
        events.push({...when,layer:0,style,tags:tags+grow+fad(k===0?t.fadeIn??0:0,k+2===times.length?t.fadeOut??0:0),
          lines:lines.map((line,i)=>({text:line,...lineAt(i,a),to:lineAt(i,b)}))});
      }
      continue;
    }
    tags+=fad(t.fadeIn??0,t.fadeOut??0);
    events.push({...span(t.start,t.end),layer:0,style,tags,lines:lines.map((line,i)=>({text:line,...lineAt(i,{dx:0,dy:0,s:1})}))});
  }
  if(captions) {
    const look=captionLook(doc);
    const lh=look.fontSize*CAPTION_LINE_HEIGHT;
    const fill=assColor(look.color);
    const boxed=look.backgroundColor!=='none';
    const hl=assColor(look.highlightColor),stroke=assColor(look.strokeColor);
    const font=`\\fn${look.fontFamily}\\fs${(look.fontSize*ASS_FONT_SCALE).toFixed(1)}\\b${look.fontWeight}\\c${fill.color}\\1a${fill.alpha}`;
    // No box: an outline and a soft shadow keep the letters readable on any picture.
    const edge=`\\bord${look.strokeWidth.toFixed(1)}\\3c${stroke.color}\\3a&H00&\\shad${(look.shadow/4).toFixed(1)}\\4c&H000000&\\4a&H80&`;
    const tags=font+(boxed?box(look,lh,look.backgroundColor):edge);
    const style=boxed?'Box':'Plain';
    const dim=`&H${Math.round(255*(1-CAPTION_DIM)).toString(16).toUpperCase().padStart(2,'0')}&`;
    const pop=Math.round(CAPTION_POP.scale*100),popMs=Math.round(CAPTION_POP.seconds*1000);
    // Portrait bottom ends at 72% height: Shorts/Reels/TikTok cover the lower quarter with their own UI.
    const bottom=(n:number)=>H>W?H*0.72-n*lh:H-look.fontSize*2-n*lh;
    const baseY=(n:number)=>look.position==='top'?look.fontSize*2:look.position==='center'?H/2-n*lh/2:bottom(n);
    for(const c of shown(doc.tracks.captions)) {
      const at=c.wordStarts,moving=look.animation!=='none'&&at&&captionWords(c,0);
      if(!moving) {
        const lines=captionText(c.text,look).split('\n').map(l=>l.trim()).filter(Boolean);
        events.push({...span(c.start,c.end),layer:1,style,tags,lines:lines.map((text,i)=>({text,x:W/2,y:baseY(lines.length)+i*lh+lh/2}))});
        continue;
      }
      // One event per spoken word: the line as it looks while that word is said.
      const y=baseY(1)+lh/2;
      at.forEach((t,k)=>{
        const when=span(c.start+t,k+1<at.length?c.start+at[k+1]!:c.end);
        if(when.end<=when.start)return;
        const ws=captionWords(c,t)!.map(w=>({...w,text:assText(captionText(w.text,look))}));
        const line=(f:(w:typeof ws[number])=>string)=>ws.map(f).join(' ');
        const on=`\\c${hl.color}`,off=`\\c${fill.color}`;
        let ass:string;
        if(look.animation==='word')ass=`{\\fscx80\\fscy80\\t(0,${popMs},\\fscx100\\fscy100)}${ws.find(w=>w.active)!.text}`;
        else if(look.animation==='karaoke')ass=line(w=>w.active||w.spoken?`{${on}\\1a&H00&}${w.text}`:`{${off}\\1a${dim}}${w.text}`);
        else if(look.animation==='pop')ass=line(w=>w.active?`{${on}\\fscx${pop}\\fscy${pop}}${w.text}{${off}\\fscx100\\fscy100}`:w.text);
        else if(look.animation==='highlight')ass=line(w=>w.active?`{${on}}${w.text}{${off}}`:w.text);
        else {
          // Pill: a box in the highlight colour behind the spoken word only, under the line itself.
          const pad=`\\xbord${BOX_PAD}\\ybord${Math.max(0,(lh-look.fontSize*ASS_FONT_SCALE)/2).toFixed(1)}`;
          events.push({...when,layer:1,style:'Box',tags:font+pad+'\\shad0',lines:[{text:'',x:W/2,y,
            ass:line(w=>`{\\1a&HFF&\\3c${hl.color}\\3a${w.active?'&H00&':'&HFF&'}}${w.text}`)}]});
          ass=line(w=>w.text);
        }
        events.push({...when,layer:2,style:'Plain',tags:font+(look.animation==='pill'||!boxed?edge:''),lines:[{text:'',x:W/2,y,ass}]});
        if(boxed&&look.animation!=='pill')events.push({...when,layer:1,style:'Box',tags:font+box(look,lh,look.backgroundColor)+'\\1a&HFF&',
          lines:[{text:look.animation==='word'?ws.find(w=>w.active)!.text:ws.map(w=>w.text).join(' '),x:W/2,y}]});
      });
    }
  }
  const style=(name:string,borderStyle:number)=>
    `Style: ${name},Inter,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,${borderStyle},0,0,5,0,0,0,1`;
  return [
    '[Script Info]','ScriptType: v4.00+',`PlayResX: ${W}`,`PlayResY: ${H}`,'WrapStyle: 2','ScaledBorderAndShadow: yes','',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Plain',1),style('Box',3),'',
    '[Events]','Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events.flatMap(e=>e.lines.map(l=>
      `Dialogue: ${e.layer},${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,{\\an5${l.to?`\\move(${l.x.toFixed(1)},${l.y.toFixed(1)},${l.to.x.toFixed(1)},${l.to.y.toFixed(1)})`:`\\pos(${l.x.toFixed(1)},${l.y.toFixed(1)})`}${e.tags}}${l.ass??assText(l.text)}`)),
    '',
  ].join('\n');
}

/**
 * Transitions on one picture track, as changes to its pictures. The middle sits
 * on the join. Crossfade and whip show both pieces at once, so the piece before
 * runs on past the join and the piece after starts early, by half the length
 * each (the validator checks the source has it). Dips fade each side to the
 * colour; a zoom transition scales into the join and back out of it.
 */
function applyTransitions(doc:EditDoc,kind:'a-roll'|'b-roll',pictures:Picture[],fps:number) {
  type Piece=EditDoc['tracks']['a-roll'][number]|EditDoc['tracks']['b-roll'][number];
  for(const j of transitionJoins<Piece>(shown<Piece>(doc.tracks[kind] as Piece[]),doc.fps)) {
    const a=pictures.find(p=>p.itemId===j.from.id),b=pictures.find(p=>p.itemId===j.to.id);
    if(!a||!b)continue;
    const half=j.transition.duration/2,t0=j.at-half,t1=j.at+half;
    const fx=(p:Picture,...x:PictureFx[])=>{p.fx=[...(p.fx??[]),...x];};
    switch(j.transition.kind) {
      case 'crossfade':
      case 'whip': {
        a.fe=frameAt(t1,fps);
        b.fs=frameAt(t0,fps);b.in-=half*(b.speed??1);b.start=t0;
        if(j.transition.kind==='crossfade')fx(b,{type:'fade',t0,t1,dir:'in'});
        else {fx(a,{type:'slide',t0,t1,from:0,to:-1},{type:'blur',t0,t1});fx(b,{type:'slide',t0,t1,from:1,to:0},{type:'blur',t0,t1});}
        break;
      }
      case 'dip-black':
      case 'dip-white': {
        const color=j.transition.kind==='dip-black'?'black':'white';
        fx(a,{type:'fade',t0,t1:j.at,dir:'out',color});fx(b,{type:'fade',t0:j.at,t1,dir:'in',color});
        break;
      }
      case 'zoom':
        fx(a,{type:'push',t0,t1:j.at,from:1,to:ZOOM_THROUGH,curve:'in'},{type:'blur',t0:j.at-half/2,t1:j.at});
        fx(b,{type:'push',t0:j.at,t1,from:ZOOM_THROUGH,to:1,curve:'out'},{type:'blur',t0:j.at,t1:j.at+half/2});
        break;
    }
  }
}
type Faded={id:string;start:number;end:number;fadeIn?:number;fadeOut?:number};
/** Picture fades: to and from see-through, so what lies under shows (black under a-roll). */
function applyFades(items:Faded[],pictures:Picture[]) {
  for(const it of items) {
    const p=pictures.find(x=>x.itemId===it.id);
    if(!p||!(it.fadeIn||it.fadeOut))continue;
    p.fx=[...(p.fx??[]),
      ...(it.fadeIn?[{type:'fade' as const,t0:it.start,t1:it.start+it.fadeIn,dir:'in' as const}]:[]),
      ...(it.fadeOut?[{type:'fade' as const,t0:it.end-it.fadeOut,t1:it.end,dir:'out' as const}]:[])];
  }
}
/** How far a zoom transition scales into the join: enough to read as motion, not so far the frame turns to mush. Our pick, by eye. */
const ZOOM_THROUGH=1.6;

/**
 * Chunks of about `per` frames over [0, frames). A boundary that would fall
 * inside a held range moves to its end, so a fade or slide runs in one chunk.
 */
export function chunkBounds(frames:number,per:number,holds:[number,number][]=[]):{k:number;c0:number;c1:number}[] {
  const out:{k:number;c0:number;c1:number}[]=[];
  let c0=0;
  while(c0<frames) {
    let c1=Math.min(frames,c0+per);
    for(let moved=true;moved;) {
      moved=false;
      for(const [h0,h1] of holds)if(c1>h0&&c1<h1&&c1<frames){c1=Math.min(frames,h1);moved=true;}
    }
    out.push({k:out.length,c0,c1});
    c0=c1;
  }
  return out;
}

// ---- expressions ------------------------------------------------------------------

const num=(x:number)=>Number.isInteger(x)?String(x):x.toFixed(6).replace(/0+$/,'');

/** \`ease()\` from @voxtale/editdoc as an ffmpeg expression of x (0..1). */
function easeExpr(easing:Easing|undefined,x:string):string {
  switch(easing) {
    case 'ease-in-out':return `if(lt(${x},0.5),2*${x}*${x},-1+(4-2*${x})*${x})`;
    case 'snap':return `(1-pow(1-${x},3))`;
    case 'build':return `pow(${x},3)`;
    case 'settle':return `(1+${num(SETTLE_BACK+1)}*pow(${x}-1,3)+${num(SETTLE_BACK)}*pow(${x}-1,2))`;
    default:return x;
  }
}

/**
 * A keyed value as an ffmpeg expression of `u`: sum of per-segment terms, flat
 * so hundreds of keys stay shallow. Only segments touching [from, to] count.
 */
export function keyedExpr(keys:{time:number;value:number;easing?:Easing}[],u:string,from=-Infinity,to=Infinity):string {
  const ks=[...keys].sort((a,b)=>a.time-b.time);
  if(!ks.length)return '1';
  const first=ks[0]!,last=ks.at(-1)!;
  if(ks.length===1||ks.every(k=>k.value===first.value))return num(first.value);
  const terms:string[]=[];
  if(from<first.time)terms.push(`lt(${u},${num(first.time)})*${num(first.value)}`);
  for(let i=0;i<ks.length-1;i++) {
    const a=ks[i]!,b=ks[i+1]!;
    if(b.time<=a.time||b.time<from||a.time>to)continue;
    const inside=`gte(${u},${num(a.time)})*lt(${u},${num(b.time)})`;
    if(a.value===b.value||a.easing==='hold') {terms.push(`${inside}*${num(a.value)}`);continue;}
    const x=`((${u}-${num(a.time)})/${num(b.time-a.time)})`;
    const e=easeExpr(a.easing,x);
    terms.push(`${inside}*(${num(a.value)}+${num(b.value-a.value)}*${e})`);
  }
  if(to>=last.time)terms.push(`gte(${u},${num(last.time)})*${num(last.value)}`);
  return terms.length?terms.join('+'):num(first.value);
}

const pick=(keys:ZoomKey[],p:ZoomProperty)=>keys.filter(k=>k.property===p);

export function pictureFilter(p:Picture,skip:number,frames:number,plan:RenderPlan):string {
  const {width:W,height:H,rate}=plan;
  const f=[p.speed?`setpts=(PTS-STARTPTS)/${num(p.speed)}`:`setpts=PTS-STARTPTS`,`fps=${rate}`,`trim=end_frame=${frames}`];
  if(p.crop)f.push(`crop=w='2*trunc(iw*${num(p.crop.w)}/2)':h='2*trunc(ih*${num(p.crop.h)}/2)':x='iw*${num(p.crop.x)}':y='ih*${num(p.crop.y)}'`);
  if(p.logo&&p.box)f.push(`scale=${p.box.width}:-2`);
  else if(p.box)f.push(`scale=${p.box.width}:${p.box.height}:force_original_aspect_ratio=increase`,`crop=${p.box.width}:${p.box.height}`,
    ...(p.band?[]:[`drawbox=c=white@0.9:t=${Math.max(2,Math.round(p.box.width/160))}`]));
  else if(p.fit==='cover'&&p.reframe) {
    // The crop's centre on the speaker's path (source time), clamped inside the frame.
    const u=`(${num(p.in)}+(t+${num(skip)})*${num(p.speed??1)})`,sp=p.speed??1;
    const cx=keyedExpr(p.reframe.keys.map(k=>({time:k.t,value:k.x,easing:'linear' as const})),u,p.in+skip*sp,p.in+(skip+frames/plan.fps)*sp);
    f.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`,`crop=${W}:${H}:x='clip(iw*(${cx})-${W}/2,0,iw-${W})':y='(ih-${H})/2'`);
  }
  else if(p.fit==='cover')f.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`,`crop=${W}:${H}`);
  else f.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`);
  f.push('setsar=1');
  // The grade, after scaling (fewer pixels through the LUT), before zoom and fades.
  if(p.lut)f.push(`lut3d=file='${filterPath(p.lut)}':interp=tetrahedral`);
  if(p.zoom.length) {
    const u=`(t+${num(skip)})`,end=skip+frames/plan.fps;
    const s=keyedExpr(pick(p.zoom,'scale'),u,skip,end);
    const px=pick(p.zoom,'position.x'),py=pick(p.zoom,'position.y');
    const x=px.length?keyedExpr(px,u,skip,end):'0',y=py.length?keyedExpr(py,u,skip,end):'0';
    // Scale about the centre, then shift: crop from the middle of the bigger frame, less the shift.
    f.push(`scale=w='2*trunc(${W}*(${s})/2)':h='2*trunc(${H}*(${s})/2)':eval=frame`,
      `crop=w=${W}:h=${H}:x='(${W}*(${s})-${W})/2-(${x})':y='(${H}*(${s})-${H})/2-(${y})'`);
  }
  // Effect times as seconds into this picture's part of the chunk.
  const local=(t:number)=>Math.max(0,t-p.start-skip);
  for(const x of p.fx??[]) {
    if(x.type!=='push')continue;
    const a=local(x.t0),d=Math.max(1e-3,local(x.t1)-a),q=`clip((t-${num(a)})/${num(d)},0,1)`;
    const e=x.curve==='in'?`(${q})*(${q})`:`(1-(1-${q})*(1-${q}))`;
    const sc=`(${num(x.from)}+${num(x.to-x.from)}*${e})`;
    f.push(`scale=w='2*trunc(${W}*${sc}/2)':h='2*trunc(${H}*${sc}/2)':eval=frame`,`crop=w=${W}:h=${H}:x='(iw-${W})/2':y='(ih-${H})/2'`);
  }
  for(const x of p.fx??[])if(x.type==='blur')
    f.push(`avgblur=sizeX=${Math.max(2,Math.round(W/48))}:sizeY=1:enable='between(t,${num(local(x.t0))},${num(local(x.t1))})'`);
  f.push('format=yuva420p');
  for(const x of p.fx??[]) {
    if(x.type!=='fade')continue;
    const st=local(x.t0),d=local(x.t1)-st;
    // Wholly past: an "in" is done; an "out" is gone, so its last state holds from the first frame.
    if(d<=0){if(x.dir==='out')f.push(`fade=t=out:st=0:d=0.001${x.color?`:color=${x.color}`:':alpha=1'}`);continue;}
    f.push(`fade=t=${x.dir}:st=${num(st)}:d=${num(d)}${x.color?`:color=${x.color}`:':alpha=1'}`);
  }
  if(p.opacity<1)f.push(`colorchannelmixer=aa=${num(p.opacity)}`);
  return f.join(',');
}

/**
 * A path inside a quoted filter option. The graph parser keeps quoted text as
 * is, then the option parser unescapes it: a colon (C: drive) goes in escaped,
 * a quote closes the quotes, goes in escaped twice, and reopens. Windows paths
 * get forward slashes, which ffmpeg reads there too.
 */
export const filterPath=(p:string,win=process.platform==='win32')=>(win?p.replace(/\\/g,'/'):p).replace(/:/g,'\\:').replace(/'/g,`'\\\\\\''`);

/** Overlay offsets (pixels) of a pinned graphic at item time `u`: it moves with the spot, its size held. */
export function trackOverlay(track:MotionTrack,u:string,W:number,H:number):{x:string;y:string} {
  const keys=(f:(k:MotionTrack['keys'][number])=>number,size:number)=>keyedExpr(track.keys.map(k=>({time:k.t,value:f(k)*size,easing:'linear' as const})),u);
  return {x:keys(k=>k.dx,W),y:keys(k=>k.dy,H)};
}

/** Picture of frames [c0, c1): black, then each item over it, then text and captions. */
function videoChunkArgs(plan:RenderPlan,c0:number,c1:number,assFile:string,fontsDir:string|undefined,out:string,o:{encode:string[];ts:boolean}):{args:string[];graph:string} {
  const {width:W,height:H,rate,fps}=plan;
  const inputs:string[]=['-f','lavfi','-i',`color=c=black:s=${W}x${H}:r=${rate}`];
  const graph:string[]=[];
  let last='0:v',n=0,input=0;
  for(const p of plan.pictures) {
    const a=Math.max(p.fs,c0),b=Math.min(p.fe,c1);
    if(b<=a)continue;
    const skip=Math.max(0,a/fps-p.start);
    const frames=b-a;
    const secs=num((frames+2)/fps);
    n++;input++;
    const src=input;
    if(p.kind==='image')inputs.push('-loop','1','-framerate',rate,'-t',secs,'-i',p.path);
    else if(p.kind==='graphic')inputs.push('-c:v','libvpx-vp9','-ss',num(skip),'-t',secs,'-i',p.path);
    else inputs.push('-ss',num(p.in+skip*(p.speed??1)),'-t',num((frames+2)/fps*(p.speed??1)),'-i',p.path);
    if(p.mask) {
      // The mask, sized to the source frame, becomes its alpha before any crop, scale or zoom: both move together.
      inputs.push('-ss',num(Math.max(0,p.in+skip-p.mask.in)),'-t',secs,'-i',p.mask.path);
      const m=++input;
      graph.push(`[${src}:v]setpts=PTS-STARTPTS,fps=${rate}[s${n}]`,`[${m}:v]setpts=PTS-STARTPTS,fps=${rate},format=gray[k${n}]`,
        `[k${n}][s${n}]scale2ref[kk${n}][ss${n}]`,`[ss${n}][kk${n}]alphamerge,${pictureFilter(p,skip,frames,plan)},setpts=PTS+${a-c0}[p${n}]`);
    }
    else graph.push(`[${src}:v]${pictureFilter(p,skip,frames,plan)},setpts=PTS+${a-c0}[p${n}]`);
    // A slide moves the picture across the frame over its window, smoothly in and out.
    const slide=(p.fx??[]).filter(x=>x.type==='slide').map(x=>{
      const q=`clip((t+${num(c0/fps)}-${num(x.t0)})/${num(Math.max(1e-3,x.t1-x.t0))},0,1)`;
      return `${W}*(${num(x.from)}+${num(x.to-x.from)}*(${q})*(${q})*(3-2*(${q})))`;
    })[0];
    const baseX=p.fit==='contain'&&!p.box?'(W-w)/2':p.box?String(p.box.x):'0';
    const pinned=p.track?trackOverlay(p.track,`(t+${num(c0/fps)}-${num(p.start)})`,W,H):null;
    const pos=pinned?`:x='(W-w)/2+${pinned.x}':y='(H-h)/2+${pinned.y}'`:slide?`:x='${baseX}+${slide}':y=${p.box?p.box.y:p.fit==='contain'?`'(H-h)/2'`:'0'}`
      :p.box?`:x=${p.box.x}:y=${p.box.y}`:p.fit==='contain'?`:x='(W-w)/2':y='(H-h)/2'`:'';
    graph.push(`[${last}][p${n}]overlay=eof_action=pass${pos}[o${n}]`);
    last=`o${n}`;
  }
  const fonts=fontsDir?`:fontsdir='${filterPath(fontsDir)}'`:'';
  const text=plan.ass.includes('\nDialogue:')?`setpts=PTS+${c0},ass=filename='${filterPath(assFile)}'${fonts},setpts=PTS-STARTPTS,`:'';
  graph.push(`[${last}]${text}format=yuv420p[vout]`);
  return {graph:graph.join(';\n'),args:[
    ...inputs,'-map','[vout]','-frames:v',String(c1-c0),'-an',
    ...o.encode,'-r',rate,
    ...(o.ts?['-f','mpegts']:['-video_track_timescale',String(plan.timescale)]),'-y',out,
  ]};
}

/** Sound of samples [s0, s1) as float WAV: each item at its gain, fades and ducking, summed. */
function audioChunkArgs(plan:RenderPlan,s0:number,s1:number,channels:Map<string,number>,out:string):{args:string[];graph:string} {
  const T0=s0/SAMPLE_RATE,T1=s1/SAMPLE_RATE;
  const inputs:string[]=[];
  const graph:string[]=[];
  const mixed:string[]=[];
  for(const s of plan.sounds) {
    const vs=Math.max(s.start,T0),ve=Math.min(s.end,T1);
    if(ve<=vs)continue;
    const skip=vs-s.start,d=s.end-s.start;
    const len=Math.round((ve-vs)*SAMPLE_RATE);
    if(len<=0)continue;
    const j=mixed.length;
    inputs.push('-ss',num(s.in+skip),'-t',num((len+SAMPLE_RATE/10)/SAMPLE_RATE),'-i',s.path);
    const u=`(t+${num(skip)})`;
    const gain=s.duck.length?`(${keyedExpr(s.duck,u,skip,skip+ve-vs)})`:num(s.volume);
    const fades=[
      ...(s.fadeIn>0&&skip<s.fadeIn?[`min(1,max(0,${u}/${num(s.fadeIn)}))`]:[]),
      ...(s.fadeOut>0&&skip+(ve-vs)>d-s.fadeOut?[`min(1,max(0,(${num(d)}-${u})/${num(s.fadeOut)}))`]:[]),
    ];
    const volume=[gain,...fades].join('*');
    // The browser plays mono on both sides at full level; ffmpeg's own upmix would drop it 3 dB.
    const ch=channels.get(s.path)??2;
    const layout=ch===1?'pan=stereo|c0=c0|c1=c0,':ch>2?'aformat=channel_layouts=stereo,':'';
    graph.push(`[${j}:a]${layout}aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,`+
      `atrim=end_sample=${len},asetnsamples=n=${VOLUME_STEP}:p=0,volume='${volume}':eval=frame,`+
      `adelay=${Math.round((vs-T0)*SAMPLE_RATE)}S:all=1[s${j}]`);
    mixed.push(`[s${j}]`);
  }
  const total=s1-s0;
  if(!mixed.length) {
    inputs.push('-f','lavfi','-i',`anullsrc=r=${SAMPLE_RATE}:cl=stereo`);
    graph.push(`[0:a]atrim=end_sample=${total}[aout]`);
  } else {
    graph.push(`${mixed.join('')}amix=inputs=${mixed.length}:normalize=0:dropout_transition=0,apad,atrim=end_sample=${total}[aout]`);
  }
  return {graph:graph.join(';\n'),args:[...inputs,'-map','[aout]','-c:a','pcm_f32le','-ar',String(SAMPLE_RATE),'-y',out]};
}

// ---- render -----------------------------------------------------------------------

async function pool<T>(items:T[],limit:number,fn:(item:T)=>Promise<void>,signal?:AbortSignal) {
  let next=0;
  await Promise.all(Array.from({length:Math.max(1,Math.min(limit,items.length))},async()=>{
    while(next<items.length) {
      if(signal?.aborted)throw new Error('Cancelled');
      await fn(items[next++]!);
    }
  }));
}

async function channelCounts(ffprobe:string,paths:string[],signal?:AbortSignal):Promise<Map<string,number>> {
  const out=new Map<string,number>();
  await pool([...new Set(paths)],4,async p=>{
    const s=await run(ffprobe,['-v','error','-select_streams','a:0','-show_entries','stream=channels','-of','csv=p=0',p],signal).catch(()=>'');
    out.set(p,Number.parseInt(s.trim(),10)||2);
  },signal);
  return out;
}

/** A .cube per clip with an active grade, clip id → file. */
/**
 * One .cube per clip that needs one: its input (the creator's inputLut, else
 * the log/HDR conversion of its colour space), then its grade. A broken
 * inputLut throws: rendering log footage without it would look wrong.
 */
export async function writeLuts(doc:EditDoc,dir:string):Promise<Record<string,string>> {
  const out:Record<string,string>={};
  for(const c of doc.clips) {
    const cube=c.inputLut?parseCube(await readFile(c.inputLut,'utf8')):null;
    const lut=clipLut(c,cube);
    if(!lut)continue;
    await mkdir(dir,{recursive:true});
    const f=join(dir,`${c.id.replace(/[^\w.-]/g,'_')}.cube`);
    await writeFile(f,writeCube(lut,LUT_SIZE,c.name));
    out[c.id]=f;
  }
  return out;
}

/** The programme loudness against its target, as lines for a person or the agent. */
export function loudnessReport(l:NonNullable<RenderEditResult['loudness']>,target:{lufs:number;truePeakDb:number}):string[] {
  const fmt=(x:LoudnessLevel)=>`${x.lufs.toFixed(1)} LUFS integrated, true peak ${x.truePeakDb.toFixed(1)} dBTP`;
  const out=[`mix as built: ${fmt(l.before)}; gain ${l.gainDb>=0?'+':''}${l.gainDb.toFixed(1)} dB to the ${target.lufs} LUFS target`];
  if(l.after) {
    const off=l.after.lufs-target.lufs,over=l.after.truePeakDb-target.truePeakDb;
    out.push(`delivered: ${fmt(l.after)} (${Math.abs(off)<=1?'on target':`${off>0?'+':''}${off.toFixed(1)} LU off target`}${over>0.2?`; peak ${over.toFixed(1)} dB over the ${target.truePeakDb} dBTP ceiling`:''})`);
  }
  return out;
}

const quoteList=(p:string)=>`file '${p.replace(/'/g,`'\\''`)}'`;

/** One mask per subject span the masker could make; none without a masker. */
async function writeSubjectMasks(o:RenderEditOptions,media:Record<string,string>,dir:string):Promise<Record<string,SubjectMask>> {
  const spans=subjectSpans(o.doc).filter(x=>o.graphics?.[o.doc.tracks.graphics.find(g=>g.id===x.graphicId)?.assetId??'']);
  if(!spans.length||!o.subjectMask)return {};
  await mkdir(dir,{recursive:true});
  const clips=new Map(o.doc.clips.map(c=>[c.id,c]));
  const fps=o.doc.fps.num/o.doc.fps.den,out:Record<string,SubjectMask>={};
  for(const [k,x] of spans.entries()) {
    const c=clips.get(x.clipId),video=c&&c.kind==='video'?media[c.hash]:undefined;
    if(!video)continue;
    const file=join(dir,`m${k}.avi`);
    // Two frames of margin each side, as the chunk inputs read past their ends.
    const start=Math.max(0,x.srcStart-2/fps);
    if(await o.subjectMask({video,start,end:x.srcEnd+2/fps,fps,out:file,...(x.objects.length?{subject:x.subject,objects:x.objects}:{})}).catch(()=>false))out[x.key]={path:file,in:start};
  }
  return out;
}

/**
 * Copy parts for the plan: candidates (one plain picture, nothing over it)
 * whose source is copyable, each cut to clean keyframe bounds. Probe errors
 * mean no copy, never a failed render.
 */
async function planCopies(plan:RenderPlan,ffprobe:string,enc:VideoEncoder,signal?:AbortSignal):Promise<CopyPart[]> {
  const holds=plan.holds.map(([a,b])=>[a,b] as [number,number]);
  const cands=copyCandidates(plan,[...assBusy(plan.ass,plan.fps),...holds]);
  const sources=new Map<string,ReturnType<typeof parseSourceProbe>>();
  const out:CopyPart[]=[];
  for(const c of cands) {
    if(!sources.has(c.path))sources.set(c.path,await run(ffprobe,sourceProbeArgs(c.path),signal).then(parseSourceProbe,()=>null));
    const src=sources.get(c.path);
    if(!src||!copyableSource(src,plan,enc.codec))continue;
    const end=c.src+(c.f1-c.f0)/plan.fps;
    const packets=await run(ffprobe,packetProbeArgs(c.path,src.startTime+c.src,src.startTime+end+2),signal).then(t=>parsePackets(t,src.startTime),()=>[]);
    const r=copyRange(packets,c,plan.fps);
    if(r)out.push({path:c.path,...r});
  }
  return out;
}

async function countFrames(ffprobe:string,file:string,signal?:AbortSignal):Promise<number> {
  const t=await run(ffprobe,['-v','error','-select_streams','v:0','-count_packets','-show_entries','stream=nb_read_packets','-of','csv=p=0',file],signal).catch(()=>'');
  return Number.parseInt(t.trim(),10)||0;
}

export async function renderEditDoc(o:RenderEditOptions):Promise<RenderEditResult> {
  // ffmpeg-path.ts finds a libass build (env var, then ffmpeg-full on Mac).
  const ffmpeg=o.ffmpeg??ffmpegPath(),ffprobe=o.ffprobe??ffprobePath();
  const enc=o.encoder??await machineEncoder({ffmpeg});
  try {
    return await renderWith(o,ffmpeg,ffprobe,enc);
  } catch(e) {
    // A GPU encoder that passed the test encode can still fail on a real one (busy, out of sessions, odd size): the CPU instead.
    if(!enc.hardware||o.signal?.aborted||e instanceof MissingMediaError||/Nothing on the timeline/.test(String(e)))throw e;
    return renderWith(o,ffmpeg,ffprobe,{codec:enc.codec,name:SOFTWARE[enc.codec],hardware:false});
  }
}

async function renderWith(o:RenderEditOptions,ffmpeg:string,ffprobe:string,enc:VideoEncoder):Promise<RenderEditResult> {
  const ff=(args:string[])=>run(ffmpeg,['-hide_banner','-nostdin','-loglevel','error',...args],o.signal);
  const soft=o.captions==='track'&&shown(o.doc.tracks.captions).length>0;
  await rm(o.work,{recursive:true,force:true});
  await mkdir(o.work,{recursive:true});
  try {
    // Library sound effects are made again from their name; graded clips get a .cube each.
    const library=await writeLibrary(join(o.work,'sfx'),o.doc.clips.filter(c=>!o.media[c.hash]).map(c=>c.hash));
    const luts=await writeLuts(o.doc,join(o.work,'luts'));
    const masks=await writeSubjectMasks(o,{...library,...o.media},join(o.work,'masks'));
    const plan=planRender(soft?{...o.doc,tracks:{...o.doc.tracks,captions:[]}}:o.doc,{...library,...o.media},o.graphics,luts,masks);
    if(plan.frames<=0)throw new Error('Nothing on the timeline to render');
    const assFile=join(o.work,'text.ass');
    await writeFile(assFile,plan.ass);
    const channels=await channelCounts(ffprobe,plan.sounds.map(s=>s.path),o.signal);
    const per=Math.max(1,Math.round((o.chunkSeconds??30)*plan.fps));
    const reshape=outputFilter(o.doc.canvas,plan.fps,o.output);
    const quality={crf:o.crf??18,preset:o.preset??'veryfast',width:plan.width,height:plan.height,fps:plan.fps};
    const encode=encodeArgs(enc,quality);
    // Copies only pay when the joined picture is not encoded again at the end.
    const copies=o.fast===true&&!reshape?await planCopies(plan,ffprobe,enc,o.signal):[];
    const ts=copies.length>0;
    const chunks=mixedChunks(plan.frames,per,plan.holds,copies,chunkBounds);
    const sample=(frame:number)=>Math.round(frame/plan.fps*SAMPLE_RATE);
    const ext=ts?'ts':'mp4';
    // A chunk's picture: copied from its source, else encoded; a copy short of frames is encoded instead.
    const picture=async(k:number|string,c0:number,c1:number,copy?:CopyPart):Promise<number>=>{
      const file=join(o.work,`v${k}.${ext}`);
      if(copy) {
        const ok=await ff(copyArgs(copy,plan.fps,file)).then(()=>countFrames(ffprobe,file,o.signal),()=>0);
        if(ok===copy.frames)return copy.frames;
      }
      const v=videoChunkArgs(plan,c0,c1,assFile,o.fontsDir,file,{encode,ts});
      const vg=join(o.work,`v${k}.graph`);
      await writeFile(vg,v.graph);
      await ff(['-filter_complex_script',vg,...v.args]);
      return 0;
    };
    let done=0,copied=0;
    o.progress?.(0);
    await pool(chunks,o.concurrency??2,async({k,c0,c1,copy})=>{
      copied+=await picture(k,c0,c1,copy);
      const a=audioChunkArgs(plan,sample(c0),sample(c1),channels,join(o.work,`a${k}.wav`));
      const ag=join(o.work,`a${k}.graph`);
      await writeFile(ag,a.graph);
      await ff(['-filter_complex_script',ag,...a.args]);
      o.progress?.(++done/(chunks.length+1));
    },o.signal);
    const vlist=join(o.work,'video.txt'),alist=join(o.work,'audio.txt'),mixWav=join(o.work,'mix.wav');
    // MPEG-TS parts carry no MP4 durations: each gets its exact length, so joins land on the frame.
    await writeFile(vlist,chunks.map(c=>quoteList(join(o.work,`v${c.k}.${ext}`))+(ts?`\nduration ${num((c.c1-c.c0)/plan.fps)}`:'')).join('\n'));
    await writeFile(alist,chunks.map(c=>quoteList(join(o.work,`a${c.k}.wav`))).join('\n'));
    await ff(['-f','concat','-safe','0','-i',alist,'-c','copy','-rf64','auto','-y',mixWav]);
    // Loudness: one gain step and a limiter, as the desktop export applies.
    const target={lufs:o.doc.mix.loudnessLufs,truePeakDb:o.doc.mix.truePeakDb};
    const before=parseLoudness(await run(ffmpeg,['-hide_banner','-nostdin','-i',mixWav,'-af','ebur128=peak=true:framelog=quiet','-f','null','-'],o.signal));
    const gainDb=before?loudnessGain(before,target):0;
    const af=gainDb?['-af',`volume=${gainDb}dB,alimiter=limit=${limiterCeiling(target.truePeakDb).toFixed(4)}:level=0`]:[];
    const srt=join(o.work,'captions.srt');
    if(soft)await writeFile(srt,toSrt(o.doc));
    await ff([
      '-f','concat','-safe','0','-i',vlist,'-i',mixWav,...(soft?['-i',srt]:[]),'-map','0:v','-map','1:a',...(soft?['-map','2:s']:[]),
      ...(reshape?['-vf',reshape,...encodeArgs(enc,{...quality,...(o.output?.width?{width:o.output.width}:{}),...(o.output?.height?{height:o.output.height}:{}),...(o.output?.fps?{fps:o.output.fps}:{})})]:['-c:v','copy']),
      ...muxTag(enc.codec),...(ts?['-video_track_timescale',String(plan.timescale)]:[]),
      ...af,'-c:a','aac','-b:a','192k','-ar',String(SAMPLE_RATE),
      ...(soft?['-c:s','mov_text','-metadata:s:s:0','language=eng','-disposition:s:0','default']:[]),'-movflags','+faststart','-y',o.out,
    ]);
    // A join that lost or doubled frames: the whole picture encoded instead.
    if(ts&&await countFrames(ffprobe,o.out,o.signal)!==plan.frames)return renderWith({...o,fast:false},ffmpeg,ffprobe,enc);
    // The delivered file, measured: what the viewer's player will meet.
    const after=before?parseLoudness(await run(ffmpeg,['-hide_banner','-nostdin','-i',o.out,'-vn','-af','ebur128=peak=true:framelog=quiet','-f','null','-'],o.signal)):undefined;
    o.progress?.(1);
    return {
      out:o.out,frames:plan.frames,duration:plan.frames/plan.fps,
      ...(before?{loudness:{before,gainDb,...(after?{after}:{})}}:{}),skipped:plan.skipped,
      ...(Object.keys(luts).length?{graded:Object.keys(luts)}:{}),encoder:enc.name,...(copied?{copiedFrames:copied}:{}),
    };
  } finally {
    await rm(o.work,{recursive:true,force:true});
  }
}
