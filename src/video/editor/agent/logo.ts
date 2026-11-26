// The brand logo over the cut (bd voxtale-editor-jo6.1): the agent says where
// (a corner or x,y), how big (a share of the frame's width) and when (spoken
// words, or the whole cut); code turns that into EditDoc logo items. The file
// is the style's brand-kit logo, or a logo clip the creator gave at open.
import {outputTimes,snap,type ClipRef,type EditDoc,type LogoItem} from '@voxtale/editdoc';
import {fadeFields,type Fade,type Job} from './cut';

export const LOGO_CORNERS=['top-left','top-right','bottom-left','bottom-right'] as const;
export type LogoCorner=(typeof LOGO_CORNERS)[number];
/** Gap from the frame edge for a corner logo, share of the short side. REDACTED's corner label inset. */
const MARGIN=0.04;

export interface LogoPlacement {
  id:string;
  /** A corner, or x,y (top-left, fractions of the frame). */
  corner?:LogoCorner;x?:number;y?:number;
  /** Width, share of the frame's width. */
  size:number;
  /** Spoken words it spans; absent = from the start / to the end of the cut. */
  from?:{clip:string;word:number};to?:{clip:string;word:number};
  opacity?:number;fade?:Fade;
}

/** The logo file as an EditDoc image clip. width/height: the image's pixels (its shape sets the logo's height). */
export function logoClip(o:{hash:string;name:string;width:number;height:number}):ClipRef {
  return {id:'brand-logo',hash:o.hash,name:o.name,kind:'image',role:'logo',roleSource:'creator',duration:3600,
    width:o.width,height:o.height,hasAudio:false,timecodeStart:0} as ClipRef;
}

const wordAt=(job:Job,doc:EditDoc,p:{clip:string;word:number},edge:'start'|'end'):number|undefined=>{
  const w=job.clips.find(c=>c.ref.id===p.clip)?.words.find(x=>x.id===p.word);
  return w?outputTimes(doc,p.clip,w[edge])[0]:undefined;
};

/** Logo items for a built cut. A span whose words were cut goes; one past the cut's end stops there. */
export function placeLogos(job:Job,doc:EditDoc,ref:ClipRef,ps:LogoPlacement[]):LogoItem[] {
  const end=doc.tracks['a-roll'].reduce((m,i)=>Math.max(m,i.end),0);
  const {width:W,height:H}=doc.canvas,m=MARGIN*Math.min(W,H);
  const shape=ref.width&&ref.height?ref.height/ref.width:1;
  const out:LogoItem[]=[];
  for(const p of ps) {
    const s=p.from?wordAt(job,doc,p.from,'start'):0,e=p.to?wordAt(job,doc,p.to,'end'):end;
    if(s===undefined||e===undefined)continue;
    const start=snap(s,doc.fps),stop=snap(Math.min(end,e),doc.fps);
    if(stop<=start)continue;
    const w=Math.min(1,Math.max(0.02,p.size)),h=w*W*shape/H;
    const c=p.corner??(p.x===undefined&&p.y===undefined?'top-right':undefined);
    const x=c?(c.endsWith('left')?m/W:1-w-m/W):Math.min(1-w,Math.max(0,p.x??0));
    const y=c?(c.startsWith('top')?m/H:1-h-m/H):Math.min(Math.max(0,1-h),Math.max(0,p.y??0));
    out.push({id:`logo-${p.id}`,clipId:ref.id,start,end:stop,owner:'agent',x:Math.max(0,x),y:Math.max(0,y),w,opacity:p.opacity??1,...fadeFields(p.fade,stop-start)});
  }
  return out.sort((a,b)=>a.start-b.start);
}
