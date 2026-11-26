// Multicam on the cut: which camera shows and which mic plays for each
// a-roll piece. The piece keeps its words in the master clip's time; the
// angle and mic are read in step through the sync group (see
// @voxtale/editdoc sync.ts). The agent's choices win; elsewhere `auto` picks
// the member whose sound rises most over its own median.
import {activeMember,groupOf,syncTime,type ARollItem,type EditDoc,type PipCorner,type SyncGroup} from '@voxtale/editdoc';
import type {Job} from './cut';

/** A word range of the master clip (inclusive word ids) and what to use there. */
export interface AngleChoice {clip:string;from:number;to:number;
  angle?:string;mic?:string;layout?:'camera'|'split'|'pip';companion?:string;pipCorner?:PipCorner;why?:string}
export interface Multicam {
  groups:SyncGroup[];
  /** dB per `step` seconds of each member's own file (sound-sync activityLevels). */
  levels?:Record<string,number[]>;
  step?:number;
  /** Pick the mic (and, if asked, the camera) by who sounds most active, where no choice covers. */
  auto?:{mic?:boolean;angle?:boolean};
  choices?:AngleChoice[];
}

const isVideo=(doc:EditDoc,id:string)=>doc.clips.find(c=>c.id===id)?.kind==='video';
const sounds=(doc:EditDoc,id:string)=>!!doc.clips.find(c=>c.id===id)?.hasAudio;

/** Source time range of the master covered by a choice. */
function span(job:Job,c:AngleChoice):[number,number]|null {
  const j=job.clips.find(x=>x.ref.id===c.clip);
  const a=j?.words.find(w=>w.id===c.from),b=j?.words.find(w=>w.id===c.to);
  return a&&b?[a.start,b.end]:null;
}

/** Set doc.groups and each grouped a-roll piece's angle, mic and layout. */
export function applyMulticam(doc:EditDoc,job:Job,m:Multicam|undefined):EditDoc {
  if(!m?.groups.length)return doc;
  const ids=new Set(doc.clips.map(c=>c.id));
  const groups=m.groups.map(g=>({...g,members:g.members.filter(x=>ids.has(x.clipId))})).filter(g=>g.members.length>=2);
  const ranges=(m.choices??[]).map(c=>({c,r:span(job,c)})).filter(x=>x.r);
  const aroll=doc.tracks['a-roll'].map((item):ARollItem=>{
    const g=groupOf(groups,item.clipId);
    if(!g)return item;
    const mid=(item.in+item.out)/2;
    const pick=ranges.find(x=>x.c.clip===item.clipId&&mid>=x.r![0]&&mid<=x.r![1])?.c;
    const gt0=item.in+g.members.find(x=>x.clipId===item.clipId)!.start,gt1=gt0+(item.out-item.in);
    const auto=(want:(id:string)=>boolean)=>m.levels?activeMember(g,m.levels,m.step??0.1,gt0,gt1,g.members.map(x=>x.clipId).filter(want)):undefined;
    const angle=pick?.angle??(m.auto?.angle?auto(id=>isVideo(doc,id)):undefined);
    const mic=pick?.mic??(m.auto?.mic?auto(id=>sounds(doc,id)):undefined);
    const out:ARollItem={...item};
    if(angle&&angle!==item.clipId)out.angle=angle;
    if(mic&&mic!==item.clipId)out.mic=mic;
    if(pick?.layout&&pick.layout!=='camera') {
      const other=pick.companion??g.members.find(x=>x.clipId!==(angle??item.clipId)&&isVideo(doc,x.clipId))?.clipId;
      if(other) {
        out.layout=pick.layout;
        out.companions=[{clipId:other,offset:syncTime(groups,item.clipId,0,other)!}];
        if(pick.layout==='pip')out.pipCorner=pick.pipCorner??'bottom-right';
      }
    }
    return out;
  });
  return {...doc,groups,tracks:{...doc.tracks,'a-roll':aroll}};
}

/** Job sync entries from groups: `clip` time = `with` time + offset, against the talk clip. */
export function syncFromGroups(groups:readonly SyncGroup[],talk:string):{clip:string;with:string;offset:number}[] {
  const g=groupOf(groups,talk);
  if(!g)return [];
  return g.members.filter(x=>x.clipId!==talk).map(x=>({clip:x.clipId,with:talk,offset:Math.round(syncTime(groups,talk,0,x.clipId)!*10000)/10000}));
}
