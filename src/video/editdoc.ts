// Bridge between the v1 single-source Edit (what the Remotion renderer and
// the take/graphics planners speak) and EditDoc v2 (@voxtale/editdoc, what
// the desktop app and the staged agent speak). Both directions are frame
// exact: timeline(), mappedCaptions() and graphic frames survive a round trip.
import {
  STYLE_PRESETS,applyStagePatch,newEditDoc,parseEditDoc,stagePatchBetween,withBrand,
  type ClipRef,type EditDoc,type EditStyle,type Fps,type Item,type StageName,type StagePatch,
} from '@voxtale/editdoc';
import {editSchema,timeline,type Edit,type Scene} from './model';
import type {Transcript} from './transcript-model';
import {digest} from './hash';

type Graphic=NonNullable<Scene['graphics']>[number];
const TEMPLATE={'lower-third':'lowerThird',callout:'callout',chapter:'chapter'} as const;
const STYLE={lowerThird:'lower-third',callout:'callout',chapter:'chapter'} as const;
const TITLE_SUFFIX='.title';

/** The v1 source as a v2 clip. The transcript carries the file's sha256 and length. */
export function clipFromTranscript(edit:Edit,t:Pick<Transcript,'sourceHash'|'duration'>,id='source'):ClipRef {
  const end=Math.max(t.duration,...edit.scenes.map(s=>s.out));
  return {id,hash:/^[0-9a-f]{64}$/.test(t.sourceHash)?t.sourceHash:digest(t.sourceHash),name:edit.source.split(/[\\/]/).pop()||id,
    kind:'video',role:'a-roll',roleSource:'creator',duration:end,fps:{num:edit.fps,den:1},width:edit.width,height:edit.height,hasAudio:true,timecodeStart:0};
}

export interface FromEditOptions {
  clip:ClipRef;                       // the v1 source
  style?:EditStyle;
  id?:string;
  /** Word ids for captions ("clipId:wordId"); without it captions carry time refs. */
  transcript?:Pick<Transcript,'words'>;
  /** Clip for a b-roll or music path. Required when the edit has either. */
  mediaClip?:(path:string,kind:'image'|'video'|'audio')=>ClipRef;
}

/** v1 Edit → EditDoc v2. Every item is agent-owned and applied. */
export function editDocFromEdit(edit:Edit,o:FromEditOptions):EditDoc {
  const fps:Fps={num:edit.fps,den:1};
  const sec=(frame:number)=>frame/edit.fps,frame=(s:number)=>Math.round(s*edit.fps);
  const style=withBrand(o.style??STYLE_PRESETS['calm-explainer'],{colors:{accent:edit.accent} as EditStyle['brand']['colors']});
  const extra=new Map<string,ClipRef>();
  const media=(path:string,kind:'image'|'video'|'audio')=>{
    if(!o.mediaClip)throw new Error(`Edit uses ${path}; pass mediaClip to convert it`);
    const c=o.mediaClip(path,kind);extra.set(c.id,c);return c;
  };
  const doc=newEditDoc({id:o.id??`edit-${digest(edit).slice(0,12)}`,name:edit.name,fps,canvas:{width:edit.width,height:edit.height},clips:[o.clip],style});
  const tracks=structuredClone(doc.tracks);
  const shots=timeline(edit);
  for(const s of shots) {
    const start=sec(s.from),end=sec(s.from+s.duration);
    tracks['a-roll'].push({id:s.id,clipId:o.clip.id,in:sec(s.sourceStart),out:sec(s.sourceStart+s.duration),start,end,owner:'agent',status:'applied',gainDb:0});
    if(s.zoom!==1)tracks.zoom.push({id:`${s.id}-zoom`,start,end,owner:'agent',status:'applied',scale:s.zoom,x:0.5,y:0.5,target:'face',easeIn:0,easeOut:0});
    if(s.title)tracks.text.push({id:`${s.id}${TITLE_SUFFIX}`,start,end,owner:'agent',status:'applied',template:s.titleStyle==='card'?'title':'lowerThird',text:s.title,position:'auto'});
    for(const g of s.graphics??[]) {
      const from=Math.max(0,frame(g.in)-s.sourceStart),dur=Math.min(s.duration-from,frame(g.out)-frame(g.in));
      if(dur>0)tracks.text.push({id:g.id,start:sec(s.from+from),end:sec(s.from+from+dur),owner:'agent',status:'applied',template:TEMPLATE[g.style],text:g.text,position:'auto'});
    }
    if(s.broll) {
      const c=media(s.broll.path,s.broll.kind);
      const bin=s.broll.kind==='image'?0:s.broll.in;
      tracks['b-roll'].push({id:`${s.id}.broll`,clipId:c.id,in:bin,out:bin+sec(s.duration),start,end,owner:'agent',status:'applied',fit:s.broll.fit,muted:true,opacity:1});
    }
  }
  // Captions: same clamping as mappedCaptions, one item per scene they show in.
  const words=o.transcript?.words??[];
  for(const s of shots) edit.captions.forEach((c,i)=>{
    if(c.sceneId&&c.sceneId!==s.id)return;
    const a=Math.max(frame(c.start),s.sourceStart),b=Math.min(frame(c.end),s.sourceStart+s.duration);
    if(b<=a)return;
    const refs=words.filter(w=>w.start<c.end&&w.end>c.start&&frame(w.start)>=s.sourceStart-1&&frame(w.end)<=s.sourceStart+s.duration+1).map(w=>`${o.clip.id}:${w.id}`);
    tracks.captions.push({id:`cap-${s.id}-${i+1}`,start:sec(s.from+a-s.sourceStart),end:sec(s.from+b-s.sourceStart),owner:'agent',status:'applied',text:c.text,
      words:refs.length?refs:[`${o.clip.id}:t${Math.round(c.start*1000)}`]});
  });
  const total=sec(shots.reduce((n,s)=>n+s.duration,0));
  if(edit.music) {
    const c=media(edit.music.path,'audio');
    const len=Math.floor(Math.min(total,c.duration)*edit.fps)/edit.fps;
    if(len>0)tracks.music.push({id:'music',clipId:c.id,in:0,out:len,start:0,end:len,owner:'agent',status:'applied',
      gainDb:Math.max(-60,20*Math.log10(Math.max(edit.music.volume,1e-3))),fadeIn:0,fadeOut:0,duck:false});
  }
  const speechGainDb=Math.max(-24,Math.min(24,20*Math.log10(Math.max(edit.speechVolume,1e-3))));
  return parseEditDoc({...doc,clips:[o.clip,...extra.values()],tracks,mix:{...doc.mix,speechGainDb}}).doc;
}

export interface ToEditOptions {
  /** File path the v1 renderer should read for a clip. */
  clipPath(clip:ClipRef):string;
}

/**
 * EditDoc v2 → v1 Edit for the Remotion renderer. v1 plays one source with
 * back-to-back scenes, so this refuses docs that need more: several a-roll
 * clips, gaps, voiceover, or b-roll that does not span a whole scene.
 * Suggestions are left out.
 */
export function editFromEditDoc(doc:EditDoc,o:ToEditOptions):Edit {
  if(doc.fps.den!==1)throw new Error('v1 renders integer frame rates only');
  const fps=doc.fps.num;
  const live=<T extends Item>(xs:T[])=>xs.filter(x=>x.status!=='suggested').sort((a,b)=>a.start-b.start);
  const f=(s:number)=>Math.round(s*fps),sec=(n:number)=>n/fps;
  const clips=new Map(doc.clips.map(c=>[c.id,c]));
  const aroll=live(doc.tracks['a-roll']);
  if(!aroll.length)throw new Error('Nothing on the a-roll track');
  const sources=new Set(aroll.map(a=>a.clipId));
  if(sources.size>1)throw new Error('v1 renders one a-roll clip; this edit uses '+sources.size);
  if(live(doc.tracks.voiceover).length)throw new Error('v1 cannot render voiceover');
  const source=clips.get(aroll[0]!.clipId)!;
  let cursor=0;
  const scenes:Scene[]=aroll.map(a=>{
    if(f(a.start)!==cursor)throw new Error(`v1 cannot render a gap before ${a.id}`);
    cursor=f(a.end);
    return {id:a.id.replace(/[^a-zA-Z0-9_-]/g,'_'),in:a.in,out:a.out,zoom:Math.min(2,live(doc.tracks.zoom).find(z=>z.start<=a.start&&a.start<z.end)?.scale??1),titleStyle:'lower-third'};
  });
  // Output frame → scene index and source frame.
  const at=(outFrame:number,endExclusive=false)=>{
    const i=aroll.findIndex(a=>endExclusive?outFrame>f(a.start)&&outFrame<=f(a.end):outFrame>=f(a.start)&&outFrame<f(a.end));
    if(i<0)throw new Error(`Nothing on the a-roll at ${sec(outFrame)}s`);
    return {i,source:f(aroll[i]!.in)+outFrame-f(aroll[i]!.start)};
  };
  const captions:Edit['captions']=[];
  for(const c of live(doc.tracks.captions)) {
    const a=at(f(c.start)),b=at(f(c.end),true);
    if(a.i!==b.i)throw new Error(`Caption ${c.id} spans a cut`);
    captions.push({start:sec(a.source),end:sec(b.source),text:c.text,sceneId:scenes[a.i]!.id});
  }
  for(const t of live(doc.tracks.text)) {
    const a=at(f(t.start)),b=at(f(t.end),true);
    const scene=scenes[a.i]!;
    if(t.id.endsWith(TITLE_SUFFIX)&&t.template!=='callout'&&t.template!=='chapter') {
      scene.title=t.text;scene.titleStyle=t.template==='title'?'card':'lower-third';continue;
    }
    if(t.template==='title')throw new Error(`v1 shows title cards for whole scenes only (${t.id})`);
    const g:Graphic={id:t.id.replace(/[^a-zA-Z0-9_-]/g,'_'),in:sec(a.source),out:sec(b.i===a.i?b.source:f(aroll[a.i]!.out)),text:t.text.slice(0,90),style:STYLE[t.template]};
    scene.graphics=[...(scene.graphics??[]),g];
  }
  for(const b of live(doc.tracks['b-roll'])) {
    const i=aroll.findIndex(a=>f(a.start)===f(b.start)&&f(a.end)===f(b.end));
    if(i<0)throw new Error(`v1 shows b-roll for whole scenes only (${b.id})`);
    const clip=clips.get(b.clipId)!;
    scenes[i]!.broll={path:o.clipPath(clip),kind:clip.kind==='image'?'image':'video',in:clip.kind==='image'?0:b.in,fit:b.fit};
  }
  const music=live(doc.tracks.music)[0];
  return editSchema.parse({
    version:1,name:doc.name,source:o.clipPath(source),fps,width:doc.canvas.width,height:doc.canvas.height,scenes,captions,
    ...(music?{music:{path:o.clipPath(clips.get(music.clipId)!),volume:Math.min(1,10**(music.gainDb/20))}}:{}),
    speechVolume:Math.min(2,10**(doc.mix.speechGainDb/20)),accent:doc.styleRef.snapshot.brand.colors.accent,
  });
}

/**
 * Apply a v1 stage result to a doc as one or more policy-checked stage
 * patches: takes → assembly (a-roll) + text (captions); graphics → text.
 */
export function applyEditStage(doc:EditDoc,result:Edit,stages:StageName[],stamp:StagePatch['stamp'],o:Omit<FromEditOptions,'clip'|'style'|'id'>={}):EditDoc {
  const clip=doc.clips.find(c=>c.id===doc.tracks['a-roll'][0]?.clipId)??doc.clips[0];
  if(!clip)throw new Error('Doc has no clips');
  const target=editDocFromEdit(result,{...o,clip,style:doc.styleRef.snapshot,id:doc.id});
  let next=doc;
  for(const stage of stages)next=applyStagePatch(next,stagePatchBetween(next,target,stage,stamp)).doc;
  return next;
}
