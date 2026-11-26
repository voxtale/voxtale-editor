import {z} from 'zod';

const time = z.number().finite().nonnegative();
const text = z.string().trim().min(1).max(160);
export const sceneSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  in: time,
  out: time,
  zoom: z.number().min(1).max(2).default(1),
  title: text.optional(),
  graphics: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/), in: time, out: time,
    text: z.string().trim().min(1).max(90), style: z.enum(['lower-third', 'callout', 'chapter']),
  }).strict()).max(20).optional(),
  titleStyle: z.enum(['lower-third', 'card']).default('lower-third'),
  broll: z.object({path: z.string().min(1), kind: z.enum(['image', 'video']),
    in: time.default(0), fit: z.enum(['cover', 'contain']).default('cover')}).strict().optional(),
}).strict();
export const editSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(120),
  source: z.string().min(1),
  fps: z.number().int().min(1).max(60).default(30),
  width: z.number().int().min(320).max(3840).refine(n => n % 2 === 0).default(1920),
  height: z.number().int().min(240).max(2160).refine(n => n % 2 === 0).default(1080),
  scenes: z.array(sceneSchema).min(1).max(1000),
  captions: z.array(z.object({start: time, end: time, text, sceneId: z.string().optional()}).strict()).default([]),
  music: z.object({path: z.string().min(1), volume: z.number().min(0).max(1).default(0.12)}).strict().optional(),
  speechVolume: z.number().min(0).max(2).default(1),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#E84860'),
}).strict().superRefine((edit, ctx) => {
  const ids = new Set<string>();
  edit.scenes.forEach((s, i) => {
    if (ids.has(s.id)) ctx.addIssue({code:'custom', path:['scenes', i, 'id'], message:'Duplicate scene ID'});
    ids.add(s.id);
    const graphicIds=new Set<string>();
    for(const g of s.graphics??[]) {
      if(graphicIds.has(g.id)||g.in<s.in||g.out>s.out||Math.round(g.out*edit.fps)<=Math.round(g.in*edit.fps))
        ctx.addIssue({code:'custom',path:['scenes',i,'graphics'],message:'Graphic needs a unique ID and a valid range inside its scene'});
      graphicIds.add(g.id);
    }
    if (Math.round(s.out * edit.fps) <= Math.round(s.in * edit.fps))
      ctx.addIssue({code:'custom', path:['scenes', i], message:'Scene must keep at least one frame'});
  });
  edit.captions.forEach((c, i) => {
    if(c.sceneId&&!ids.has(c.sceneId))ctx.addIssue({code:'custom',path:['captions',i],message:'Caption references an unknown scene'});
    if (c.end <= c.start) ctx.addIssue({code:'custom', path:['captions', i], message:'Caption end must follow start'});
  });
});
export type Edit = z.infer<typeof editSchema>;
export type Scene = Edit['scenes'][number];
export function timeline(edit: Edit) {
  let from = 0;
  return edit.scenes.map(scene => {
    const sourceStart = Math.round(scene.in * edit.fps);
    const duration = Math.round(scene.out * edit.fps) - sourceStart;
    const result = {...scene, sourceStart, from, duration};
    from += duration;
    return result;
  });
}
export function durationFrames(edit: Edit) {return timeline(edit).reduce((n,s) => n + s.duration, 0);}
// Captions use original source time. Intersect them with every kept range,
// including repeated/reordered ranges; never shift them by cumulative cut time alone.
export function mappedCaptions(edit: Edit) {
  return timeline(edit).flatMap(scene => edit.captions.flatMap(c => {
    if(c.sceneId && c.sceneId!==scene.id)return [];
    const start = Math.max(Math.round(c.start * edit.fps), scene.sourceStart);
    const end = Math.min(Math.round(c.end * edit.fps), scene.sourceStart + scene.duration);
    return end > start ? [{from:scene.from + start - scene.sourceStart, duration:end-start, text:c.text}] : [];
  }));
}
export function parseSrt(srt: string): Edit['captions'] {
  const stamp = (s:string) => {
    const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(s.trim());
    if (!m || +m[2]! > 59 || +m[3]! > 59) throw new Error(`Invalid SRT timestamp: ${s}`);
    return +m[1]! * 3600 + +m[2]! * 60 + +m[3]! + +m[4]! / 1000;
  };
  const content = srt.replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  if (!content) return [];
  return content.split(/\n\s*\n/).map(block => {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]!)) lines.shift();
    const times = lines.shift()?.split(/\s+-->\s+/);
    if (times?.length !== 2) throw new Error('Invalid SRT cue');
    return {start:stamp(times[0]!), end:stamp(times[1]!), text:lines.join(' ').replace(/<[^>]*>/g, '')};
  });
}
export function keepOutsideSilence(duration:number, silences:Array<{start:number;end:number}>, padding=0.15) {
  const cuts = silences.map(s => ({start:Math.min(duration,Math.max(0,s.start+padding)),end:Math.max(0,Math.min(duration,s.end-padding))}))
    .filter(s => s.end>s.start).sort((a,b) => a.start-b.start);
  const kept:Array<{in:number;out:number}> = [];
  let cursor=0;
  for (const cut of cuts) {
    if (cut.start>cursor) kept.push({in:cursor,out:cut.start});
    cursor=Math.max(cursor,cut.end);
  }
  if (cursor<duration) kept.push({in:cursor,out:duration});
  return kept;
}
