// P2 agent timeline: the v1 take and graphics stages run on one a-roll clip
// and the result becomes an EditDoc. Multi-clip assembly replaces this in P3.
import type {ClipRef,EditDoc,EditStyle} from '@voxtale/editdoc';
import {editSchema,type Edit} from './model';
import type {Transcript} from './transcript-model';
import {planTakes,planGraphics,type Planner,type VideoOutput} from './pipeline';
import {buildTakeEdit,buildGraphicsEdit} from './editing';
import {graphicsPlanSchema} from './planner';
import {editDocFromEdit} from './editdoc';

const even=(n:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,Math.round(n/2)*2));

/** Whole-clip v1 edit for an a-roll clip. */
export function editForClip(clip:ClipRef,name:string):Edit {
  if(clip.kind!=='video')throw new Error('The first edit needs a video a-roll clip');
  const fps=Math.max(1,Math.min(60,Math.round(clip.fps?clip.fps.num/clip.fps.den:30)));
  return editSchema.parse({version:1,name:name.slice(0,120)||'Untitled edit',source:clip.name,fps,
    width:even(clip.width??1920,320,3840),height:even(clip.height??1080,240,2160),
    scenes:[{id:'scene-1',in:0,out:Math.floor(clip.duration*fps)/fps}]});
}

export interface FirstEditInput {
  id:string;
  name:string;
  clip:ClipRef;
  transcript:Transcript;
  style?:EditStyle;
  planner:Planner;
  output:VideoOutput;
}

export async function planFirstEdit(o:FirstEditInput):Promise<EditDoc> {
  const edit=editForClip(o.clip,o.name);
  const takes=await planTakes(edit,o.transcript,o.planner,o.output);
  const cut=buildTakeEdit(edit,o.transcript,takes.plan).edit;
  o.output.progress?.('Planning graphics');
  const graphics=await planGraphics(cut,o.transcript,o.planner,o.output);
  const final=buildGraphicsEdit(cut,o.transcript,graphicsPlanSchema.parse(graphics.plan));
  await o.output.write('edit',final);
  return editDocFromEdit(final,{clip:o.clip,id:o.id,transcript:o.transcript,...(o.style?{style:o.style}:{})});
}
