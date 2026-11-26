// Pure cut logic: transcript packing, word-range cut → EditDoc, deterministic checks.
// Moved from the agent-editor spike (experiments/agent-editor).
// The agent picks words; code snaps, pads and validates (Timeline-Bench: never let the
// agent's own "done" be the judge).
import {planZoom,reframeFor,type EyesAt} from '../../zoom';
import type {StoryClip} from '../../story-edit';
import {planAudio,type MusicCues,type SfxHit} from '../../audio';
import {beatGrid,nearestBeat,weakBeds,type BeatGrid} from '../../beats';
import {libraryClip,SFX_SOUND_IDS,type SfxSound} from '../../sfx';
import type {Face} from './kit';
import type {ProjectBrief} from '../project';
import type {ClipMoments,ClipSync} from '../../moments';
import {applyMulticam,type Multicam} from './multicam';
import {
  FADE_MAX,STYLE_PRESETS,buildCaptions,newEditDoc,outputTimes,packSequence,parseEditDoc,FPS_30,snap,snapDown,snapUp,transitionLength,
  type ARollItem,type Fps,type Grade,type TransitionKind,type ZoomCurve,type ZoomItem,type BRollItem,type ClipIndex,type ClipRef,type EditDoc,type EditStyle,type GraphicItem,type PipCorner,type SourceWord,type TextItem,type WordFix,
} from '@voxtale/editdoc';

export interface Word {id:number;text:string;start:number;end:number}
/** A clip as the agent works on it: its ref, words, index and moments. Frames come from the frame host, by hash. */
export interface JobClip {ref:ClipRef;words:Word[];index?:ClipIndex;moments?:ClipMoments}
/** Face box at a source time, from the index's shot segments. */
export const faceAt=(c:JobClip,t:number):Face|undefined=>c.index?.segments.find(s=>s.face&&s.start<=t&&s.end>t)?.face;
export const speaking=(c:JobClip)=>c.ref.role==='a-roll';
export interface Job {id:string;name:string;clips:JobClip[];style:EditStyle;targetSeconds?:number;instruction?:string;project?:ProjectBrief;
  /** The creator's standing rules, accepted on earlier edits (../rules.ts). */
  rules?:string[];
  /** Clips recorded together, by clip id: `clip` time = `with` time + offset. */
  sync?:ClipSync[]}
/**
 * `pace`: how tight this stretch runs (the pause limit inside it and the breath at its edges).
 * `hold`: seconds of the pause after its last word to keep, a beat for a line to land.
 * `teaser`: a cold open; its words may play again later in the cut.
 * `transition`: into this segment from the one before (none = a hard cut).
 */
export interface WordSegment {clip:string;from:number;to:number;note?:string;pace?:Pace;hold?:number;teaser?:boolean;transition?:SegmentTransition;audioLead?:number;audioLag?:number;fade?:Fade}
/** Picture fade, seconds: in at the start, out at the end. */
export interface Fade {in?:number;out?:number}
/** Fade fields for an item `len` long: both shrunk in step when they would not fit. */
export function fadeFields(f:Fade|undefined,len:number):{fadeIn?:number;fadeOut?:number} {
  const i=Math.min(f?.in??0,FADE_MAX),o=Math.min(f?.out??0,FADE_MAX),k=i+o>len?len/(i+o):1;
  return {...(i>0?{fadeIn:i*k}:{}),...(o>0?{fadeOut:o*k}:{})};
}
export interface SegmentTransition {kind:TransitionKind;seconds?:number}
/** Default transition length: long enough to read, short enough not to drag. Our pick. */
export const TRANSITION_SECONDS=0.4;
/**
 * A clip placed whole (or source seconds `in`..`out` of it) as its own stretch
 * of the cut, speech or not: a silent shot, a music-only or ambient clip.
 * `audio`: keep its own sound (default) or mute it, so music plays under it undimmed.
 */
export interface ShotSegment {clip:string;in?:number;out?:number;audio?:'keep'|'mute';note?:string;transition?:SegmentTransition;audioLead?:number;audioLag?:number;fade?:Fade}
export type Segment=WordSegment|ShotSegment;
export const isShot=(s:Segment):s is ShotSegment=>!('from' in s);
/** A-roll items laid from a ShotSegment: never level-matched, zoomed or aimed by the eyes. */
export const isShotItem=(i:{id:string})=>/-shot-\d+$/.test(i.id);
/** Shortest shot segment, seconds. */
export const SHOT_MIN=0.5;
/** Source seconds a shot segment plays, after defaults and clamping. */
export function shotRange(job:Job,s:ShotSegment):{c:JobClip;in:number;out:number} {
  const c=clipOf(job,s.clip);
  if(c.ref.kind!=='video')throw new Error(`${s.clip} is ${c.ref.kind}; only video clips can be segments of the cut`);
  const a=s.in??0,z=Math.min(s.out??c.ref.duration,c.ref.duration);
  if(a>=c.ref.duration)throw new Error(`${s.clip} is ${c.ref.duration.toFixed(2)}s; in ${a} is past its end`);
  if(z-a<SHOT_MIN)throw new Error(`${s.clip} ${a.toFixed(2)}-${z.toFixed(2)}s is shorter than ${SHOT_MIN}s`);
  return {c,in:a,out:z};
}
export type Pace='fast'|'normal'|'slow';
/** A chapter starts on a spoken word and follows it through recuts. */
export interface ChapterPlacement {clip:string;word:number;title:string}
/** Where the music comes in (a word; absent = the start) and the lines it leaves bare. */
export interface MusicPlacement {from?:{clip:string;word:number};drops?:CaptionSpan[];
  /** Seconds into the first track where it starts (default its measured lively point, past the intro). */
  in?:number}
/**
 * A sound effect on a gesture: an item the agent placed (`g-…`, `t-…`, `b-…`
 * as the timeline names them, or `ch-<n>` for a chapter) or a spoken word.
 * `clipId` is a library sound (`sfx-lib-whoosh`) or the creator's sfx clip;
 * `peak` is seconds into its file of its loudest moment, which lands on the
 * gesture. Never tied to the item: moving it later leaves the hit.
 */
export interface SfxPlacement {id:string;clipId:string;peak:number;gainDb:number;reason:string;
  on:{item:string}|{clip:string;word:number};
  /** For reports: the sound's name and its peak level, dBFS. */
  sound?:string;levelDb?:number}
/** Words to caption (inclusive). Captions are for the hook and key lines, not the whole video. */
export interface CaptionSpan {clip:string;from:number;to:number;why?:string;
  /** Zoom spans only: `push` moves in slowly over the line instead of cutting in. */
  kind?:'punch'|'push';
  /** Zoom spans only: shape of the move in and out (a punch given one moves in over ZOOM_CURVE_SECONDS). */
  curveIn?:ZoomCurve;curveOut?:ZoomCurve}
/** Ease time a curve gives a zoom that would otherwise cut: long enough to read the shape. Our pick. */
export const ZOOM_CURVE_SECONDS=0.3;
/** `placement` comes from the rendered graphic (its `place`), not from the agent. */
export interface GraphicPlacement {id:string;clip:string;word:number;seconds:number;placement?:GraphicItem['placement'];reason:string;fade?:Fade;
  /** Rendered graphic shown, when a variant was chosen over `id` (which stays the placement's handle). */
  shows?:string;
  /** Other rendered graphics to try here. */
  variants?:{id:string;placement?:GraphicItem['placement']}[]}
/**
 * Footage over the voice: clip `broll` from `in` for `seconds`, starting on a
 * spoken word. `sync`: `broll` was recorded with the speaking clip, so it
 * shows what it showed while those words were said, and follows the cut.
 */
export interface BrollPlacement {id:string;broll:string;in?:number;seconds:number;clip:string;word:number;reason:string;sync?:boolean;fit?:'cover'|'contain';
  /** Seconds the picture starts before the anchor word (a J-cut: see it, then hear it named). */
  lead?:number;
  fade?:Fade;
  /** Part of the source frame to show, fractions of it. */
  crop?:{x:number;y:number;w:number;h:number};
  /** Source seconds per output second; not with sync. */
  speed?:number;
  /** Keep the speaker on screen in this corner. */
  pip?:PipCorner}
export interface TextPlacement {id:string;template:TextItem['template'];text:string;subtext?:string;position:TextItem['position'];clip:string;word:number;seconds:number;reason:string;fade?:Fade;
  /** Other versions to try in its place; the placement's own fields are the one shown. */
  variants?:TextVariant[]}
export interface TextVariant {template?:TextItem['template'];text:string;subtext?:string;position?:TextItem['position']}
/** Everything the agent placed over the cut. */
export interface Overlays {wordFixes?:WordFix[];graphics?:GraphicPlacement[];captions?:CaptionSpan[];broll?:BrollPlacement[];text?:TextPlacement[];chapters?:ChapterPlacement[];music?:MusicPlacement;
  /** Lines to punch in on. Given (even empty), only these zoom; absent, jump cuts alternate as in core. */
  zooms?:CaptionSpan[];
  /** Sound effects the agent placed. Given (even empty), only these play; absent, code places them as core does. */
  sfx?:SfxPlacement[];
  /** Colour grade per source clip id (set_look). */
  grades?:Record<string,Grade>;
  /** Per clip id: colour space or input LUT (set_look) and A/V offset (set_av_offset), over what the open found. */
  clipSettings?:Record<string,Pick<ClipRef,'colorSpace'|'inputLut'|'avOffset'>>;
  /** Clips recorded together and which camera/mic each piece uses (set_angles). */
  multicam?:Multicam;
  /** Eyes at a source time, for zoom's eye match; the index's face stands in without it. */
  eyesAt?:EyesAt;
  /**
   * Where a word is heard to start ('in') or end ('out'), from the clip's sound; never past `limit`.
   * `other` is the word's other end: with it the edge may move inward, off a breath or a pause the
   * transcript stretched the word over.
   */
  edge?:(clipId:string,t:number,side:'in'|'out',limit:number,other?:number)=>number;
  /** How far out from a heard word edge the clip stays quiet (room only, no breath or click), never past `limit`. */
  quiet?:(clipId:string,t:number,side:'in'|'out',limit:number)=>number}

/** Shortest and longest b-roll shot; the speaker stays on screen this long at the start (core's values). */
export const BROLL_MIN=1.5,BROLL_MAX=6,HOOK_HOLD=2;
/** A b-roll shot anchored this close before the previous shot ends starts at that end instead of being dropped. */
const NEAR_MISS=0.5;
/** Longest stretch of other footage that is not b-roll (a screen recording, a second camera); longer holds lose the speaker. */
export const SHOW_MAX=12;
/** Least face between two shots of the same footage, so a long stretch about a screen alternates instead of chaining into one hold. */
export const FACE_GAP=1.5;

/** The clock shared with a speaking clip, when `clip` was recorded with it. */
export const syncOf=(job:Job,clip:string,speaker:string)=>job.sync?.find(x=>x.clip===clip&&x.with===speaker);

/**
 * The clip whose shape and rate the picture takes, from the clips IN the cut
 * (opened candidates left out of it don't count): the first speaker in it,
 * else the shape with the most screen time, its longest clip. No cut yet:
 * the first speaker, else the first video.
 */
export function canvasClip(job:Job,items:{clipId:string;in:number;out:number}[]):ClipRef {
  const used=job.clips.filter(c=>c.ref.kind==='video'&&items.some(i=>i.clipId===c.ref.id));
  const talk=used.find(speaking);
  if(talk)return talk.ref;
  if(!used.length)return (job.clips.find(speaking)??job.clips.find(c=>c.ref.kind==='video')??job.clips[0]!).ref;
  const secs=(c:JobClip)=>items.filter(i=>i.clipId===c.ref.id).reduce((t,i)=>t+i.out-i.in,0);
  const shape=(c:JobClip)=>c.ref.width&&c.ref.height?(c.ref.width/c.ref.height).toFixed(2):'?';
  const byShape=new Map<string,number>();
  for(const c of used)byShape.set(shape(c),(byShape.get(shape(c))??0)+secs(c));
  const top=[...byShape].sort((a,b)=>b[1]-a[1])[0]![0];
  return used.filter(c=>shape(c)===top).sort((a,b)=>secs(b)-secs(a))[0]!.ref;
}

/** Contain when the footage's shape differs from the canvas (a screen on a 16:9 cut), so nothing is cropped. */
export function fitFor(c:JobClip,canvas:{width:number;height:number},crop?:{w:number;h:number}):'cover'|'contain' {
  if(c.ref.role==='screen'&&!crop)return 'contain';
  // A cropped region has its own shape: fill the frame when it matches, show it whole when it does not.
  const w=(c.ref.width??0)*(crop?.w??1),h=(c.ref.height??0)*(crop?.h??1);
  return w&&h&&Math.abs(w/h-canvas.width/canvas.height)>0.05*canvas.width/canvas.height?'contain':'cover';
}

/**
 * Padding around kept words, as in video-use: enough breath, never into a neighbour word.
 * A trimmed pause keeps more air after the last word than before the next one. Checked against
 * the human edit of the S1 footage (90-days-reflection): it kept a median 0.30s after and 0.25s
 * before, the before side split between none and ~0.6s, so no case for moving air to the front.
 */
const LEAD=0.08,TAIL=0.14;
/** Breath before and after a run of words, by pace: fast runs sentences together, slow lets them sit. */
const PADS:Record<Pace,[number,number]>={fast:[0.03,0.05],normal:[LEAD,TAIL],slow:[0.1,0.22]};
/** Pause limit inside a fast or slow stretch, against the style's. */
const FAST_PAUSE=0.3,SLOW_PAUSE=1;
/** A held beat stops this far short of the next source word. */
const HOLD_GUARD=0.04;
/** Footage, graphics and text move this far at most to start on a beat. */
const BEAT_REACH=0.12;
export const pauseLimit=(job:Job,s:WordSegment)=>{
  const m=job.style.pace.maxPauseSeconds;
  return s.pace==='fast'?Math.min(m,FAST_PAUSE):s.pace==='slow'?Math.max(m,SLOW_PAUSE):m;
};

/** video-use style: one line per phrase (break on pauses), word ids so the agent can cut by id. */
/**
 * J/L cuts the footage allows, in whole frames: a lead no longer than the source
 * before the piece or the piece before it (less a frame), a lag likewise after.
 * One per join (a lead beats the lag before it); none where pieces do not touch.
 */
export function fitSplits(job:Job,items:ARollItem[],fps:Fps):ARollItem[] {
  const rate=fps.num/fps.den,down=(v:number)=>Math.floor(v*rate+1e-6)/rate;
  const touch=(a?:ARollItem,b?:ARollItem)=>!!a&&!!b&&Math.round(a.end*rate)===Math.round(b.start*rate);
  const dur=(id:string)=>job.clips.find(c=>c.ref.id===id)?.ref.duration??Infinity;
  return items.map((x,i)=>{
    const prev=items[i-1],next=items[i+1],{audioLead,audioLag,...rest}=x;
    const lead=audioLead&&touch(prev,x)?down(Math.min(audioLead,x.in,prev!.end-prev!.start-1/rate)):0;
    const nextLead=touch(x,next)&&next!.audioLead?1:0;
    const lag=audioLag&&touch(x,next)&&!nextLead?down(Math.min(audioLag,dur(x.clipId)-x.out,next!.end-next!.start-1/rate)):0;
    return {...rest,...(lead>0?{audioLead:lead}:{}),...(lag>0?{audioLag:lag}:{})};
  });
}

/** `stressed`: ids of words the speaker leans on; they print as *word*. */
export function packTranscript(c:JobClip,gap=0.5,stressed?:Set<number>):string {
  const lines:string[]=[];
  let cur:Word[]=[];
  const flush=()=>{
    if(!cur.length)return;
    const a=cur[0]!,b=cur.at(-1)!;
    lines.push(`[${a.id}-${b.id} ${a.start.toFixed(2)}-${b.end.toFixed(2)}] ${cur.map(w=>stressed?.has(w.id)?`*${w.text}*`:w.text).join(' ')}`);
    cur=[];
  };
  let prev:Word|undefined;
  for(const w of c.words) {
    if(prev&&w.start-prev.end>=gap){flush();lines.push(`  (pause ${(w.start-prev.end).toFixed(1)}s)`);}
    cur.push(w);prev=w;
    if(/[.?!]$/.test(w.text)&&cur.length>=6)flush();
  }
  flush();
  return `clip ${c.ref.id} "${c.ref.name}" ${c.ref.duration.toFixed(1)}s ${c.words.length} words\n${lines.join('\n')}`;
}

function wordIndex(c:JobClip,id:number):number {
  const i=c.words.findIndex(w=>w.id===id);
  if(i<0)throw new Error(`clip ${c.ref.id} has no word ${id}`);
  return i;
}

export function clipOf(job:Job,id:string):JobClip {
  const c=job.clips.find(x=>x.ref.id===id);
  if(!c)throw new Error(`no clip ${id}; clips: ${job.clips.map(x=>x.ref.id).join(', ')}`);
  return c;
}

export function buildCut(job:Job,segments:Segment[],o:Overlays={}):EditDoc {
  if(!segments.length)throw new Error('a cut needs at least one segment');
  // Edges round to the speaker's frame rate; footage-only edits take the first video's.
  const fps=(job.clips.find(speaking)??job.clips.find(c=>c.ref.kind==='video')??job.clips[0]!).ref.fps??FPS_30;
  // A segment's transition rides on its first piece: the join into it.
  // J/L cuts too: a lead on its first piece, a lag on its last; fitSplits trims them to what the footage allows.
  const withTransition=(s:Segment,k:number,items:ARollItem[]):ARollItem[]=>{
    if(!items.length)return items;
    const out=[...items];
    if(s.transition&&k)out[0]={...out[0]!,transition:{kind:s.transition.kind,duration:transitionLength(s.transition.seconds??TRANSITION_SECONDS,fps)}};
    if(s.audioLead&&k)out[0]={...out[0]!,audioLead:s.audioLead};
    if(s.audioLag&&k<segments.length-1)out[out.length-1]={...out.at(-1)!,audioLag:s.audioLag};
    // Fades too, sized to the piece once packed (lay below).
    if(s.fade?.in)out[0]={...out[0]!,fadeIn:s.fade.in};
    if(s.fade?.out)out[out.length-1]={...out.at(-1)!,fadeOut:s.fade.out};
    return out;
  };
  const raw=segments.flatMap((s,k):ARollItem[]=>withTransition(s,k,piecesOf(s,k)));
  function piecesOf(s:Segment,k:number):ARollItem[] {
    if(isShot(s)) {
      const {c,in:a,out:z}=shotRange(job,s);
      const muted=s.audio==='mute'||!c.ref.hasAudio;
      return [{id:`a-${c.ref.id}-shot-${k}`,clipId:c.ref.id,in:a,out:z,start:0,end:0,
        owner:'agent' as const,stage:'agent',status:'applied' as const,gainDb:muted?-60:0,
        reason:((muted&&c.ref.hasAudio?'(muted) ':'')+(s.note??'whole shot')).slice(0,300),
        evidence:[{kind:'segment' as const,ref:`${c.ref.id}:${a.toFixed(2)}-${z.toFixed(2)}`}]}];
    }
    const c=clipOf(job,s.clip);
    if(!speaking(c))throw new Error(`segment ${k}: ${s.clip} is ${c.ref.role}, not a speaking clip; place it by source seconds (in/out) instead of words`);
    const i=wordIndex(c,s.from),j=wordIndex(c,s.to);
    if(j<i)throw new Error(`segment ${k}: word ${s.to} comes before ${s.from}`);
    // Pauses longer than this stretch's pace allows are cut out by code: each run of words between them is its own item.
    const maxPause=pauseLimit(job,s),[lead,tail]=PADS[s.pace??'normal'];
    const runs:[number,number][]=[];
    let a=i;
    for(let x=i+1;x<=j;x++)if(c.words[x]!.start-c.words[x-1]!.end>maxPause){runs.push([a,x-1]);a=x;}
    runs.push([a,j]);
    return runs.map(([ri,rj],r)=>{
      const first=c.words[ri]!,last=c.words[rj]!,before=c.words[ri-1],after=c.words[rj+1];
      // Where the first word is heard to start and the last to end: the sound, when measured, else the transcript.
      const heardIn=o.edge?o.edge(c.ref.id,first.start,'in',before?before.end:0,first.end):first.start;
      const heardOut=o.edge?o.edge(c.ref.id,last.end,'out',after?after.start:c.ref.duration,last.start):last.end;
      // The neighbouring words' sound, too: the cut sits in the quiet between, not on the next word's first sound.
      const quietFrom=before&&o.edge?o.edge(c.ref.id,before.end,'out',heardIn,before.start):before?.end;
      const quietTo=after&&o.edge?o.edge(c.ref.id,after.start,'in',heardOut,after.end):after?.start;
      // Edges round outward to the frame: the in down, the out up. Rounding to the nearest frame moves
      // an edge up to half a frame (17ms at 30fps), more than a fast pad, into the word it keeps. Only
      // where outward would reach a cut neighbour's sound and the inward frame still holds the whole
      // kept word does it round inward.
      // Pads stop at the first other sound (a breath, a click): a piece never starts or ends on half of one.
      const lead0=Math.min(lead,quietFrom!==undefined?Math.max(0,heardIn-quietFrom)/2:lead);
      const clearIn=o.quiet?o.quiet(c.ref.id,heardIn,'in',quietFrom??0):0;
      const inS=outward(Math.max(0,clearIn,heardIn-lead0),'in',heardIn,Math.max(quietFrom??0,clearIn),fps);
      // A held beat keeps the pause that follows the line, as far as the source has one.
      const held=s.hold&&r===runs.length-1?Math.max(0,Math.min(s.hold,(after?after.start:c.ref.duration)-heardOut-HOLD_GUARD)):0;
      const tail0=Math.min(tail,quietTo!==undefined?Math.max(0,quietTo-heardOut)/2:tail);
      const clearOut=o.quiet?o.quiet(c.ref.id,heardOut,'out',Math.min(c.ref.duration,quietTo??c.ref.duration)):c.ref.duration;
      const outS=outward(Math.min(c.ref.duration,heardOut+Math.max(held,Math.min(tail0,clearOut-heardOut))),'out',heardOut,
        Math.min(quietTo??c.ref.duration,c.ref.duration,held>0?c.ref.duration:clearOut),fps);
      return {id:`a-${c.ref.id}-${first.id}-${last.id}-${k}`,clipId:c.ref.id,in:inS,out:outS,start:0,end:0,
        owner:'agent' as const,stage:'agent',status:'applied' as const,gainDb:0,
        reason:((r?'(pause trimmed) ':'')+(held>tail?'(held beat) ':'')+(s.note??'kept')).slice(0,300),
        evidence:[{kind:'word' as const,ref:`${c.ref.id}:${first.id}`},{kind:'word' as const,ref:`${c.ref.id}:${last.id}`}]};
    });
  }
  const main=canvasClip(job,raw);
  // Library sounds the agent's hits use join the clips; grades ride on their clips.
  const lib=SFX_SOUND_IDS.filter(n=>o.sfx?.some(h=>h.clipId===libraryClip(n).id)&&!job.clips.some(c=>c.ref.id===libraryClip(n).id)).map((n:SfxSound)=>libraryClip(n));
  const graded=(r:ClipRef):ClipRef=>{const g=o.grades?.[r.id];return {...r,...o.clipSettings?.[r.id],...(g?{grade:g}:{})};};
  let doc=newEditDoc({id:job.id,name:job.name,clips:[...job.clips.map(c=>graded(c.ref)),...lib],fps:main.fps,style:job.style,
    canvas:{width:main.width??1920,height:main.height??1080}});
  if(o.wordFixes?.length)doc={...doc,wordFixes:o.wordFixes};
  const lay=(items:typeof raw):EditDoc=>{
    const d={...doc,tracks:{...doc.tracks,'a-roll':fitSplits(job,packSequence(items,doc.fps),doc.fps).map(fitFade)}};
    return {...d,markers:placeChapters(job,d,o.chapters??[])};
  };
  doc=lay(raw);
  // Music with a firm pulse: picture changes (graphics, text, footage) start on its beats.
  // Speech joins never move to the beat: they follow the words (a cut on a beat that clips a breath reads worse).
  const grid=beatGrid(doc,planAudio(doc,musicCues(job,doc,o.music)).music,{firm:true});
  const words:SourceWord[]=(o.captions??[]).flatMap(s=>{
    const c=clipOf(job,s.clip);
    return c.words.slice(wordIndex(c,s.from),wordIndex(c,s.to)+1).map(w=>({clipId:c.ref.id,id:w.id,text:w.text,start:w.start,end:w.end}));
  });
  const captions=job.style.pace.captions==='off'?[]:buildCaptions(doc,words,job.style.brand.captionStyle);
  const placed=placeGraphics(job,doc,o.graphics??[]);
  const graphics=startsOnBeat(placed,grid,doc.fps,cutEnd(doc));
  doc={...doc,tracks:{...doc.tracks,captions,graphics,'b-roll':placeBroll(job,doc,o.broll??[],grid),text:startsOnBeat(placeText(job,doc,o.text??[]),grid,doc.fps,cutEnd(doc))}};
  // Zoom as core's zoom stage does it (punch-ins on jump cuts, push-ins for faster styles, about the face),
  // but none while a graphic is up: the graphic is the emphasis there.
  const zoomClips:StoryClip[]=job.clips.map(c=>({ref:c.ref,...(c.index?{index:c.index}:{})}));
  const covered=(i:{start:number;end:number})=>graphics.some(g=>g.start<i.end&&g.end>i.start);
  const stressed=(o.zooms??[]).map(s=>{
    const c=clipOf(job,s.clip),a=c.words[wordIndex(c,s.from)]!,b=c.words[wordIndex(c,s.to)]!;
    return {clip:c.ref.id,start:a.start,end:b.end,why:s.why??'',push:s.kind==='push',curveIn:s.curveIn,curveOut:s.curveOut};
  });
  const hit=(i:ARollItem)=>stressed.find(s=>s.clip===i.clipId&&i.in<s.end&&i.out>s.start);
  const stress=o.zooms&&((i:ARollItem)=>hit(i)?.why);
  // A side panel shares the frame: the speaker slides to the free side while it is up.
  const reframes=graphics.flatMap(g=>{
    const item=doc.tracks['a-roll'].find(i=>i.start<=g.start&&i.end>g.start);
    if(!item)return [];
    const t=item.in+(g.start-item.start),c=clipOf(job,item.clipId),face=o.eyesAt?.(c.ref.id,t)??faceAt(c,t);
    const z=face&&reframeFor(g,face);
    return z?[z]:[];
  });
  // A placed shot is its own picture: no punch-in on it.
  const shots=doc.tracks['a-roll'].filter(isShotItem),onShot=(i:{start:number;end:number})=>shots.some(x=>x.start<i.end-1e-6&&x.end>i.start+1e-6);
  // Curves the agent asked for land on the zoom over that line (found by source time at its start).
  const curved=(z:ZoomItem):ZoomItem=>{
    const item=doc.tracks['a-roll'].find(i=>i.start<=z.start+1e-6&&i.end>z.start);
    const s=item&&stressed.find(x=>x.clip===item.clipId&&(x.curveIn||x.curveOut)&&item.in+(z.start-item.start)<x.end&&item.in+(z.end-item.start)>x.start);
    if(!s)return z;
    const room=(z.end-z.start)/3,give=(c:ZoomCurve|undefined,e:number)=>c&&c!=='hold'&&e<=0?Math.min(ZOOM_CURVE_SECONDS,room):e;
    return {...z,...(s.curveIn?{curveIn:s.curveIn,easeIn:give(s.curveIn,z.easeIn)}:{}),...(s.curveOut?{curveOut:s.curveOut,easeOut:give(s.curveOut,z.easeOut)}:{})};
  };
  doc={...doc,tracks:{...doc.tracks,zoom:[...planZoom(doc,zoomClips,o.eyesAt,stress?{stress,push:i=>!!hit(i)?.push}:{}).filter(z=>!covered(z)&&!onShot(z)).map(curved),...reframes.filter(z=>!onShot(z))].sort((a,b)=>a.start-b.start)}};
  // Audio as core's audio stage does it: the creator's music under the video, effects on what appears.
  const audio=planAudio(doc,musicCues(job,doc,o.music),o.sfx&&sfxHits(job,doc,o.sfx));
  doc={...doc,tracks:{...doc.tracks,music:audio.music,sfx:audio.sfx},mix:{...doc.mix,...audio.mix}};
  return parseEditDoc(applyMulticam(doc,job,o.multicam)).doc;
}

/**
 * A cut edge on a frame boundary, rounded away from the word it keeps (see buildCut). `word` is the
 * kept word's heard edge, `bound` the nearest source the edge may reach: the cut neighbour's sound
 * on that side, or the clip's end.
 */
export function outward(t:number,side:'in'|'out',word:number,bound:number,fps:EditDoc['fps']):number {
  const down=snapDown(t,fps),up=snapUp(t,fps);
  if(side==='in')return down>=bound-1e-6||up>word+1e-6?down:up;
  return up<=bound+1e-6||down<word-1e-6?up:down;
}

/** Items moved whole so they start on a beat, when one is close and the move collides with nothing. */
function startsOnBeat<T extends {start:number;end:number}>(items:T[],grid:BeatGrid|undefined,fps:EditDoc['fps'],end:number):T[] {
  if(!grid)return items;
  const out:T[]=[];
  [...items].sort((a,b)=>a.start-b.start).forEach((item,k,all)=>{
    const beat=nearestBeat(grid,item.start,BEAT_REACH);
    const d=beat===undefined?0:snap(beat,fps)-item.start;
    const fits=item.start+d>=(out.at(-1)?.end??0)&&item.end+d<=Math.min(end,all[k+1]?.start??end);
    out.push(d&&fits?{...item,start:item.start+d,end:item.end+d}:item);
  });
  return out;
}

/** The agent's music placement as output times. A start word that was cut means the start; a drop needs both its ends in the cut. */
export function musicCues(job:Job,doc:EditDoc,m?:MusicPlacement):MusicCues {
  // By default the track starts where it comes alive, set_music or not.
  const alive=doc.clips.find(c=>c.role==='music'&&c.beats?.livelyFrom!==undefined)?.beats?.livelyFrom;
  if(!m)return alive?{in:alive}:{};
  const from=m.from&&anchorTime(job,doc,m.from.clip,m.from.word);
  const drops=(m.drops??[]).flatMap(s=>{
    const c=clipOf(job,s.clip),last=c.words[wordIndex(c,s.to)]!;
    const a=anchorTime(job,doc,s.clip,s.from),z=anchorTime(job,doc,s.clip,s.to);
    return a===undefined||z===undefined||z<a?[]:[{start:Math.max(0,a-LEAD),end:z+(last.end-last.start)}];
  });
  const inAt=m.in??alive;
  return {...(from!==undefined?{from:Math.max(0,from-LEAD)}:{}),...(drops.length?{drops}:{}),...(inAt?{in:inAt}:{})};
}

/** Output time of a gesture: the start of a placed item or chapter, or a kept word. Undefined when it is not in the cut. */
export function gestureTime(job:Job,doc:EditDoc,on:SfxPlacement['on']):number|undefined {
  if('word' in on)return anchorTime(job,doc,on.clip,on.word);
  const id=on.item;
  const marker=doc.markers.find(m=>m.id===id);
  if(marker)return marker.time;
  const items=[...doc.tracks.graphics,...doc.tracks.text,...doc.tracks['b-roll'],...doc.tracks.zoom];
  // A synced b-roll shot is several pieces (`b-<id>-<k>`): its first piece is the gesture.
  const hit=items.find(i=>i.id===id)??items.filter(i=>i.id.startsWith(`${id}-`)).sort((a,b)=>a.start-b.start)[0];
  return hit?.start;
}

/** The agent's effects as hits on the timeline; a gesture no longer in the cut drops its hit. */
function sfxHits(job:Job,doc:EditDoc,ps:SfxPlacement[]):SfxHit[] {
  return ps.flatMap(p=>{
    const at=gestureTime(job,doc,p.on);
    return at===undefined?[]:[{id:p.id,clipId:p.clipId,at,peak:p.peak,gainDb:p.gainDb,reason:p.reason}];
  });
}

/** Output time of a source word, or undefined when it was cut. */
function anchorTime(job:Job,doc:EditDoc,clip:string,word:number):number|undefined {
  const c=clipOf(job,clip);
  return outputTimes(doc,clip,c.words[wordIndex(c,word)]!.start)[0];
}
const cutEnd=(doc:EditDoc)=>doc.tracks['a-roll'].reduce((m,i)=>Math.max(m,i.end),0);

/** Chapters sit where their word lands; one whose word was cut is dropped, and two cannot share a frame. */
function placeChapters(job:Job,doc:EditDoc,cs:ChapterPlacement[]):EditDoc['markers'] {
  const out:EditDoc['markers']=[];
  cs.forEach((c,k)=>{
    const t=anchorTime(job,doc,c.clip,c.word);
    if(t===undefined)return;
    const time=snap(Math.max(0,t-LEAD),doc.fps);
    if(out.some(m=>m.time===time))return;
    out.push({id:`ch-${k}`,time,kind:'chapter',title:c.title.slice(0,100),owner:'agent',stage:'agent',status:'applied'});
  });
  return out.sort((a,b)=>a.time-b.time);
}

/** B-roll follows its anchor word; shots that would overlap an earlier one or the hook are left out. */
/** A fade in on the first piece, out on the last, each sized to its piece. */
function withFades<T extends {start:number;end:number;fadeIn?:number;fadeOut?:number}>(pieces:T[],f:Fade|undefined):T[] {
  if(!f||!pieces.length)return pieces;
  const out=[...pieces],last=out.length-1;
  out[0]={...out[0]!,...fadeFields({in:f.in,out:last===0?f.out:undefined},out[0]!.end-out[0]!.start)};
  if(last>0)out[last]={...out[last]!,...fadeFields({out:f.out},out[last]!.end-out[last]!.start)};
  return out;
}
/** Segment fades, set on the raw pieces, sized to each piece once it is packed. */
function fitFade(a:ARollItem):ARollItem {
  if(!a.fadeIn&&!a.fadeOut)return a;
  const {fadeIn:_i,fadeOut:_o,...rest}=a;
  return {...rest,...fadeFields({in:a.fadeIn,out:a.fadeOut},a.end-a.start)};
}
function placeBroll(job:Job,doc:EditDoc,bs:BrollPlacement[],grid?:BeatGrid):BRollItem[] {
  const end=cutEnd(doc),out:BRollItem[]=[];
  const placed=bs.map(b=>({b,t:anchorTime(job,doc,b.clip,b.word)})).filter(x=>x.t!==undefined).sort((x,y)=>x.t!-y.t!);
  for(const {b,t} of placed) {
    const src=clipOf(job,b.broll);
    // A shot comes in on the beat when one is close; its source times follow from where it starts.
    const wanted=Math.max(t!-(b.lead??0),HOOK_HOLD),beat=nearestBeat(grid,wanted,BEAT_REACH);
    const at=snap(beat!==undefined&&beat>=HOOK_HOLD?beat:wanted,doc.fps);
    // Shots start on words, which rarely land on the previous shot's last frame: a near miss starts right after it.
    const prev=b.sync?0:out.reduce((m,x)=>x.start<=at?Math.max(m,x.end):m,0);
    const start=prev>at&&prev-at<NEAR_MISS?prev:at;
    const fit=b.fit??fitFor(src,doc.canvas,b.crop);
    const speed=b.sync?1:b.speed??1;
    const item=(id:string,from:number,a:number,z:number):BRollItem=>({id,clipId:b.broll,in:from,out:from+(z-a)*speed,start:a,end:z,owner:'agent',stage:'agent',status:'applied',
      fit,muted:true,opacity:1,...(b.crop?{crop:b.crop}:{}),...(speed!==1?{speed}:{}),...(b.pip?{pip:b.pip}:{}),reason:b.reason.slice(0,300),evidence:[{kind:'word',ref:`${b.clip}:${b.word}`}]});
    const sync=b.sync?syncOf(job,b.broll,b.clip):undefined;
    if(sync) {
      // One piece per kept stretch of the speaker, each at the matching source time, so the
      // footage stays in step with the voice through every cut.
      const stop=snap(Math.min(end,start+b.seconds),doc.fps);
      const pieces=doc.tracks['a-roll'].filter(i=>i.clipId===b.clip&&i.start<stop&&i.end>start).flatMap((i,k)=>{
        const a=Math.max(start,i.start),from=i.in+(a-i.start)+sync.offset;
        const z=snap(Math.min(stop,i.end,a+src.ref.duration-from),doc.fps);
        return from>=0&&z-a>=2*doc.fps.den/doc.fps.num?[item(`b-${b.id}-${k}`,from,a,z)]:[];
      });
      const span=pieces.reduce((n,p)=>n+p.end-p.start,0);
      if(span<BROLL_MIN-1e-6||pieces.some(p=>out.some(x=>x.start<p.end&&x.end>p.start)))continue;
      out.push(...withFades(pieces,b.fade));
      continue;
    }
    const from=b.in??0;
    const stop=snap(Math.min(end,start+b.seconds,start+(src.ref.duration-from)/speed),doc.fps);
    if(stop-start<BROLL_MIN-1e-6||out.some(x=>x.start<stop&&x.end>start))continue;
    out.push(...withFades([item(`b-${b.id}`,from,start,stop)],b.fade));
  }
  return out.sort((a,b)=>a.start-b.start);
}

function placeText(job:Job,doc:EditDoc,ts:TextPlacement[]):TextItem[] {
  const end=cutEnd(doc),out:TextItem[]=[];
  for(const x of ts) {
    const t=anchorTime(job,doc,x.clip,x.word);
    if(t===undefined)continue;
    const start=snap(t,doc.fps),stop=snap(Math.min(end,t+x.seconds),doc.fps);
    if(stop<=start)continue;
    out.push({id:`t-${x.id}`,start,end:stop,owner:'agent',stage:'agent',status:'applied',template:x.template,text:x.text,...fadeFields(x.fade,stop-start),...(x.variants?.length?{variants:x.variants}:{}),
      ...(x.subtext?{subtext:x.subtext}:{}),position:x.position,reason:x.reason.slice(0,300),evidence:[{kind:'word',ref:`${x.clip}:${x.word}`}]});
  }
  return out.sort((a,b)=>a.start-b.start);
}

/** Graphics are anchored to a source word, so they follow the speech through recuts. */
function placeGraphics(job:Job,doc:EditDoc,gs:GraphicPlacement[]):GraphicItem[] {
  const end=doc.tracks['a-roll'].reduce((m,i)=>Math.max(m,i.end),0);
  const out:GraphicItem[]=[];
  for(const g of gs) {
    const c=clipOf(job,g.clip);
    const w=c.words[wordIndex(c,g.word)]!;
    const t=outputTimes(doc,g.clip,w.start)[0];
    if(t===undefined)continue;  // its anchor word was cut
    const start=snap(t,doc.fps),stop=snap(Math.min(end,t+g.seconds),doc.fps);
    if(stop<=start)continue;
    out.push({id:`g-${g.id}`,assetId:g.shows??g.id,assetRevision:0,start,end:stop,owner:'agent',stage:'agent',
      status:'applied',placement:g.placement??'full',...fadeFields(g.fade,stop-start),
      ...(g.variants?.length?{variants:g.variants.map(v=>({assetId:v.id,assetRevision:0,...(v.placement?{placement:v.placement}:{})}))}:{}),reason:g.reason.slice(0,300),evidence:[{kind:'word',ref:`${g.clip}:${g.word}`}]});
  }
  return out.sort((a,b)=>a.start-b.start);
}

export interface CutCheck {metrics:Record<string,number|string>;problems:string[];joins:string[];
  /** Joins where the speaker visibly jumps and nothing hides it. */
  jumps:string[]}

/** The eyes move this much of the frame across a cut before it reads as a jump. */
const JUMP_EYES=0.04;

/** Cuts inside one clip where the speaker's eyes jump, with no footage, graphic or punch-in over the cut. */
export function visibleJumps(doc:EditDoc,eyesAt?:EyesAt):string[] {
  if(!eyesAt)return [];
  const items=doc.tracks['a-roll'],out:string[]=[];
  const over=(xs:{start:number;end:number}[],t:number)=>xs.some(x=>x.start<=t+1e-6&&x.end>t+1e-6);
  for(let k=1;k<items.length;k++) {
    const p=items[k-1]!,i=items[k]!;
    if(p.clipId!==i.clipId||Math.abs(i.in-p.out)<0.05||isShotItem(p)||isShotItem(i))continue;
    const a=eyesAt(p.clipId,Math.max(p.in,p.out-0.05)),b=eyesAt(i.clipId,i.in);
    if(!a||!b)continue;
    const d=Math.hypot(a.x-b.x,a.y-b.y);
    if(d<JUMP_EYES||over(doc.tracks['b-roll'],i.start)||over(doc.tracks.graphics,i.start)||doc.tracks.zoom.some(z=>Math.abs(z.start-i.start)<1e-6||Math.abs(z.end-i.start)<1e-6))continue;
    out.push(`@${i.start.toFixed(1)}s: eyes move ${Math.round(d*100)}% of the frame`);
  }
  return out;
}

const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9']/g,'');

/** The sound step either side of a cut: speech in it means the join has no silence. Shorter than the fast pad. */
const TIGHT_WINDOW=0.02;
/** A cut word heard for this long inside a kept piece is still in the video. */
const STILL_HEARD=0.04;

export interface CutSound {
  /** Joins with no silence at the cut: the source still sounds on one side. */
  tight:string[];
  /** Words left out of every segment that a kept piece still plays. */
  stillHeard:string[];
}

/**
 * What the placed cut sounds like at its edges, for the agent to check: joins
 * that cut through sound, and cut words the padding lets back in. `speech`
 * gives seconds of a clip's source a..b that sound like speech; without it
 * only a word the cut plays half of or more counts as still heard.
 */
export function cutSound(job:Job,doc:EditDoc,segments:Segment[],speech?:(clip:string,a:number,b:number)=>number):CutSound {
  const items=doc.tracks['a-roll'].filter(i=>!isShotItem(i)),tight:string[]=[],stillHeard:string[]=[];
  const kept=new Set<string>();
  for(const s of segments) {
    if(isShot(s))continue;
    const c=clipOf(job,s.clip);
    for(const w of c.words.slice(wordIndex(c,s.from),wordIndex(c,s.to)+1))kept.add(`${s.clip}:${w.id}`);
  }
  const words=(clip:string)=>job.clips.find(c=>c.ref.id===clip)?.words??[];
  if(speech)for(let k=1;k<items.length;k++) {
    const p=items[k-1]!,i=items[k]!;
    if(p.clipId===i.clipId&&Math.abs(i.in-p.out)<0.02)continue;
    const after=speech(p.clipId,p.out-TIGHT_WINDOW,p.out)>=TIGHT_WINDOW-1e-9,before=speech(i.clipId,i.in,i.in+TIGHT_WINDOW)>=TIGHT_WINDOW-1e-9;
    if(!after&&!before)continue;
    const last=words(p.clipId).filter(w=>w.start<p.out).at(-1),next=words(i.clipId).find(w=>w.end>i.in);
    const where=[after&&last?`after "${last.text}"`:'',before&&next?`before "${next.text}"`:''].filter(Boolean).join(' and ');
    tight.push(`tight join at ${i.start.toFixed(1)}s: no silence ${where||'at the cut'}`);
  }
  for(const i of items)for(const w of words(i.clipId)) {
    if(kept.has(`${i.clipId}:${w.id}`))continue;
    const a=Math.max(w.start,i.in),b=Math.min(w.end,i.out);
    if(b-a<STILL_HEARD)continue;
    const heard=speech?speech(i.clipId,a,b)>=STILL_HEARD:b-a>=(w.end-w.start)/2;
    if(heard)stillHeard.push(`"${w.text}" (${i.clipId}:${w.id}, meant to be cut) still heard at ${(i.start+a-i.in).toFixed(1)}s`);
  }
  return {tight,stillHeard};
}

/** How far past the closing out point to read the source: a closing line cut off by a few seconds sits in here. */
const CLOSE_LOOK=10;

/**
 * What the source says in the seconds after the cut's last a-roll item ends,
 * so the agent sees a closing line or resolution it stopped just short of.
 * Undefined when the source says nothing there.
 */
export function afterClose(job:Job,doc:EditDoc,look=CLOSE_LOOK):string|undefined {
  const last=doc.tracks['a-roll'].reduce<EditDoc['tracks']['a-roll'][number]|undefined>((m,i)=>!m||i.end>m.end?i:m,undefined);
  if(!last)return undefined;
  const c=job.clips.find(x=>x.ref.id===last.clipId);
  const said=(c?.words??[]).filter(w=>w.end>last.out+0.02&&w.start<last.out+look);
  if(!said.length)return undefined;
  return `${last.clipId} at ${said[0]!.start.toFixed(1)}–${said.at(-1)!.end.toFixed(1)}s (the cut ends at ${last.out.toFixed(1)}s): "${said.map(w=>w.text).join(' ')}"`;
}

export function checkCut(job:Job,doc:EditDoc,segments:Segment[],graphicCount=0,eyesAt?:EyesAt):CutCheck {
  const items=doc.tracks['a-roll'];
  const dur=items.reduce((m,i)=>Math.max(m,i.end),0);
  const spoken=segments.filter((s):s is WordSegment=>!isShot(s));
  const wordsOf=(s:WordSegment)=>{const c=clipOf(job,s.clip);return c.words.slice(wordIndex(c,s.from),wordIndex(c,s.to)+1);};
  const kept=spoken.flatMap(wordsOf);
  const source=job.clips.filter(speaking).reduce((n,c)=>n+c.ref.duration,0);
  const problems:string[]=[];
  if(job.targetSeconds) {
    const r=dur/job.targetSeconds;
    if(r<0.85||r>1.15)problems.push(`length ${dur.toFixed(1)}s is ${Math.round(r*100)}% of the ${job.targetSeconds}s target (want 85-115%)`);
  }
  segments.forEach((s,k)=>{
    let len:number;
    if(isShot(s)){const r=shotRange(job,s);len=r.out-r.in;}
    else {const words=wordsOf(s);len=words.at(-1)!.end-words[0]!.start;}
    if(len<job.style.pace.minShotSeconds/2)problems.push(`segment ${k} is only ${len.toFixed(2)}s`);
  });
  // Leftover retakes: the same 3 words said twice within 25 kept words.
  const toks=kept.map(w=>norm(w.text));
  const seen=new Map<string,number>();
  for(let k=0;k+2<toks.length;k++) {
    const g=toks.slice(k,k+3).join(' ');
    if(g.split(' ').some(t=>!t))continue;
    const p=seen.get(g);
    if(p!==undefined&&k-p<=25)problems.push(`"${g}" said twice (kept words ${kept[p]!.id} and ${kept[k]!.id}): leftover retake?`);
    seen.set(g,k);
  }
  // Words used twice across segments.
  const used=new Set<string>();
  for(const s of spoken) {
    if(s.teaser)continue;
    for(const w of wordsOf(s)) {
      const key=`${s.clip}:${w.id}`;
      if(used.has(key)){problems.push(`word ${key} is used twice`);break;}
      used.add(key);
    }
  }
  // Source seconds of a clip placed twice.
  const ranges=segments.map((s,k)=>({s,k,r:isShot(s)?shotRange(job,s):undefined}));
  for(const a of ranges)for(const b of ranges) {
    if(!a.r||!b.r||b.k<=a.k||a.s.clip!==b.s.clip)continue;
    if(a.r.in<b.r.out-0.05&&b.r.in<a.r.out-0.05)problems.push(`segments ${a.k} and ${b.k} both play ${a.s.clip} ${Math.max(a.r.in,b.r.in).toFixed(1)}-${Math.min(a.r.out,b.r.out).toFixed(1)}s`);
  }
  // Each segment's ends as the viewer meets them: its words, or what the shot is.
  const startOf=(k:number)=>items.find(i=>i.id.endsWith(`-${k}`))?.start;
  const ends=(s:Segment,side:'head'|'tail')=>{
    if(isShot(s)) {
      const {c,in:a,out:z}=shotRange(job,s);
      const said=c.words.filter(w=>w.start>=a-0.05&&w.end<=z+0.05);
      const sound=s.audio==='mute'||!c.ref.hasAudio?'muted':'own sound';
      const words=said.length?` "${(side==='head'?said.slice(0,5):said.slice(-5)).map(w=>w.text).join(' ')}"`:', no words';
      return `[shot ${c.ref.id} ${a.toFixed(1)}-${z.toFixed(1)}s, ${sound}${words}]`;
    }
    const c=clipOf(job,s.clip),i=wordIndex(c,s.from),j=wordIndex(c,s.to);
    return side==='head'?c.words.slice(i,Math.min(j+1,i+5)).map(w=>w.text).join(' ')+'…':'…'+c.words.slice(Math.max(i,j-4),j+1).map(w=>w.text).join(' ');
  };
  const joins=segments.slice(1).map((s,k)=>{
    const p=segments[k]!;
    const at=startOf(k+1);
    let gap:number|undefined;
    if(!isShot(p)&&!isShot(s)) {
      // The silence a viewer hears across the join: what the outgoing item keeps after its last word, plus the lead into the next.
      const pc=clipOf(job,p.clip),c=clipOf(job,s.clip);
      const out=items.filter(i=>i.id.endsWith(`-${k}`)).at(-1),inc=items.find(i=>i.id.endsWith(`-${k+1}`));
      gap=out&&inc?(out.out-pc.words[wordIndex(pc,p.to)]!.end)+(c.words[wordIndex(c,s.from)]!.start-inc.in):undefined;
    }
    return `join ${k+1} @${at?.toFixed(1)}s${gap!==undefined?` gap ${Math.max(0,gap).toFixed(2)}s`:''}: ${ends(p,'tail')} | ${ends(s,'head')}`;
  });
  // The longest stretch where the picture does not change: no cut, footage, graphic, text or zoom starting or ending.
  const marks=[0,dur,...items.map(i=>i.start),...[...doc.tracks['b-roll'],...doc.tracks.graphics,...doc.tracks.text,...doc.tracks.zoom].flatMap(i=>[i.start,i.end])]
    .filter(t=>t>=0&&t<=dur).sort((a,b)=>a-b);
  let still=0,stillAt=0;
  for(let k=1;k<marks.length;k++)if(marks[k]!-marks[k-1]!>still){still=marks[k]!-marks[k-1]!;stillAt=marks[k-1]!;}
  const covered=[...doc.tracks['b-roll'],...doc.tracks.graphics].reduce((n,i)=>n+i.end-i.start,0);
  const speech=kept.reduce((n,w)=>n+(w.end-w.start),0);
  const grid=beatGrid(doc,doc.tracks.music,{firm:true}),weak=weakBeds(doc,doc.tracks.music);
  const changes=[...doc.tracks.graphics,...doc.tracks.text,...doc.tracks['b-roll']];
  return {
    metrics:{
      seconds:+dur.toFixed(1),target:job.targetSeconds??'none',sourceSeconds:+source.toFixed(1),
      keptRatio:+(dur/Math.max(source,1e-6)).toFixed(2),segments:segments.length,shots:segments.length-spoken.length,pauseTrims:items.length-segments.length,cutsPerMinute:+((items.length-1)/(dur/60)).toFixed(1),
      styleCutsPerMinute:job.style.pace.targetCutsPerMinute,wordsPerMinute:Math.round(kept.length/(dur/60)),
      speechShare:+(speech/dur).toFixed(2),graphics:graphicCount,broll:doc.tracks['b-roll'].length,text:doc.tracks.text.length,
      music:doc.tracks.music.length,sfx:doc.tracks.sfx.length,
      captionSeconds:+doc.tracks.captions.reduce((n,c)=>n+c.end-c.start,0).toFixed(1),
      zoomedSegments:doc.tracks.zoom.length,chapters:doc.markers.filter(m=>m.kind==='chapter').length,
      coveredShare:+(covered/dur).toFixed(2),styleBrollShare:job.style.pace.brollCoverage,
      longestStill:`${still.toFixed(1)}s from ${stillAt.toFixed(1)}s`,
      ...(grid?{musicBpm:grid.bpm,changesOnBeat:`${changes.filter(i=>nearestBeat(grid,i.start,doc.fps.den/doc.fps.num/2+1e-3)!==undefined).length}/${changes.length}`}:{}),
      ...(weak.length?{musicBeat:weak.map(w=>`weak beat (confidence ${w.confidence.toFixed(2)}, ${w.bpm} bpm), did not snap`).join('; ')}:{}),
    },
    problems,joins,jumps:visibleJumps(doc,eyesAt),
  };
}

export const styleOf=(id:string|undefined):EditStyle=>STYLE_PRESETS[(id??'calm-explainer') as keyof typeof STYLE_PRESETS]??STYLE_PRESETS['calm-explainer'];
