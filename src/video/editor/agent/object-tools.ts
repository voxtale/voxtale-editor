// pick_object: the agent picks objects on a still for the mask drawn back over a graphic (bd voxtale-editor-8a6).
// Text in object-mask-skill.ts.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod/v4';
import {MASK_OBJECTS_MAX} from '@voxtale/editdoc';
import {clipOf} from './cut';
import {defineTool,type ToolDef} from './port';
import {PICK_OBJECT_DESCRIPTION} from './object-mask-skill';
import type {Workspace} from './tools';

/** One prompt: points on the object, points off it, a box; fractions of the source frame. */
export interface ObjectPrompt {mode:'add'|'remove';points?:[number,number][];exclude?:[number,number][];box?:[number,number,number,number]}
/** What the segmenter found for one prompt: share of the frame, box (fractions), its own score. */
export interface PickedObject {mode:'add'|'remove';area:number;box:[number,number,number,number]|null;score:number}
/** Segments prompts on a still: writes the mask PNG to `out` and an overlay JPEG to `overlay`. */
export type ObjectPicker=(image:string,out:string,overlay:string,objects:ObjectPrompt[])=>Promise<PickedObject[]>;

/** Width the still is fetched at: SAM's own input size, so the prompt lands where the agent meant. */
const PICK_WIDTH=1024;

const frac=z.number().min(0).max(1);
export const objectPromptSchema=z.object({
  mode:z.enum(['add','remove']),
  points:z.array(z.tuple([frac,frac])).max(8).optional().describe('points on the object, [x,y] fractions of the source frame'),
  exclude:z.array(z.tuple([frac,frac])).max(8).optional().describe('points that are not the object'),
  box:z.tuple([frac,frac,frac,frac]).optional().describe('[x,y,w,h] round the object: top-left corner and size, fractions'),
}).strict();

const pct=(x:number)=>`${(x*100).toFixed(1)}%`;

/** A line per picked object, with what looks wrong. */
export function pickedText(found:PickedObject[]):string {
  return found.map((f,i)=>{
    const where=f.box?`box [${f.box.map(v=>v.toFixed(3)).join(', ')}]`:'nothing found';
    const warn=!f.box?' — nothing there: move the point onto the object or draw a box':
      f.area>0.5?' — covers over half the frame: likely the background or the whole person; add a box or exclude points':'';
    return `${i+1} ${f.mode}: ${pct(f.area)} of the frame, ${where}, score ${f.score.toFixed(2)}${warn}`;
  }).join('\n');
}

export function objectTools(ws:Workspace):ToolDef<any>[] {
  const pick=ws.picker;
  if(!pick)return [];
  return [defineTool({name:'pick_object',description:PICK_OBJECT_DESCRIPTION,
    input:{clip:z.string(),t:z.number().min(0).describe('source second of the still'),
      objects:z.array(objectPromptSchema).min(1).max(MASK_OBJECTS_MAX)},
    run:async({clip,t,objects})=>{
      const c=clipOf(ws.job,clip);
      if(c.ref.kind!=='video')throw new Error(`${clip} is not video`);
      if(t>=c.ref.duration)throw new Error(`${clip} is ${c.ref.duration.toFixed(2)}s long: pick a still before that`);
      for(const o of objects) {
        if(!o.points?.length&&!o.box)throw new Error('each object needs points or a box');
        if(o.box&&(o.box[0]+o.box[2]>1.0001||o.box[1]+o.box[3]>1.0001))throw new Error('box reaches outside the frame: x+w and y+h must be at most 1');
      }
      const [jpeg]=await ws.frames.frames(c.ref.hash,[t],PICK_WIDTH);
      if(!jpeg)throw new Error(`no frame of ${clip} at ${t.toFixed(2)}s`);
      const dir=join(ws.dir,'picks');
      await mkdir(dir,{recursive:true});
      const n=ws.picks=(ws.picks??0)+1;
      const still=join(dir,`${n}.jpg`),out=join(dir,`${n}-mask.png`),overlay=join(dir,`${n}-pick.jpg`);
      await writeFile(still,jpeg);
      const found=await pick(still,out,overlay,objects);
      return {text:`${clip} at ${t.toFixed(2)}s:\n${pickedText(found)}\nGood picks go to place_graphic as maskObjects, each with clip "${clip}" and t ${t.toFixed(2)}.`,
        images:[{data:new Uint8Array(await readFile(overlay)),mime:'image/jpeg'}]};
    }})];
}
