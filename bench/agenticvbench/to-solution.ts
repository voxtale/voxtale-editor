// Turn our editor's EditDoc (.edit/edit.json) into the solution.json an
// AgenticVBench Sequencing or Assembly judge reads.
//
//   bun bench/agenticvbench/to-solution.ts <edit.json> --materials <dir> \
//       [--mp4 <solution.mp4>] [--out <solution.json>]
//
// One judge slot per clip. Each a-roll item gives `output` = [start, end) on
// the rendered timeline and `source_range` = [in, out) in its clip, so word-
// snapped trims from set_cut are reported as they are (the judge scores order
// and checks each slot by SSIM at 25/50/75 % through both ranges; it does not
// require full clips). Clip numbers come from clip names: "7.mp4" -> "7".
// Clips with no words come from set_cut shot segments ({clip} or {clip,in,out};
// item ids end "-shot-N"); they are a-roll items like any other, so the same
// mapping holds. A shot without its own sound is still a slot.
//
// The judge zeroes the whole task on a missing or repeated clip, and fails a
// slot whose frames do not match its source. So this script refuses to write
// on a missing/extra/repeated clip, and warns on anything that changes the
// picture over a slot (zoom, b-roll, text, captions, graphics) or breaks the
// straight in->out mapping (a clip split in two with a gap in source).
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {basename,extname,resolve} from 'node:path';

type Item={id:string;start:number;end:number;status?:string;clipId?:string;in?:number;out?:number;speed?:number;zoom?:unknown;transition?:{kind:string;duration:number}};
type Doc={clips:{id:string;name:string;duration?:number}[];tracks:Record<string,Item[]>};
export type Segment={output:[number,number];source:string;source_range:[number,number]};

const r3=(x:number)=>Math.round(x*1000)/1000;
const shown=(xs:Item[]|undefined)=>(xs??[]).filter(i=>i.status!=='suggested');
const overlaps=(a:Item,b:{start:number;end:number})=>a.start<b.end&&b.start<a.end;

/** Pure: EditDoc -> segments + warnings. `expected` = clip numbers the task ships. */
export function toSolution(doc:Doc,expected:string[]):{segments:Segment[];warnings:string[];errors:string[]} {
  const warnings:string[]=[],errors:string[]=[];
  const nameOf=new Map(doc.clips.map(c=>[c.id,basename(c.name,extname(c.name))]));
  const aroll=shown(doc.tracks['a-roll']).slice().sort((a,b)=>a.start-b.start);
  // Merge back-to-back items of one clip (a cut inside a clip): the judge wants one slot per clip.
  const merged:(Item&{parts:number;gap:number})[]=[];
  for(const it of aroll){
    const last=merged.at(-1);
    if(last&&last.clipId===it.clipId){
      last.gap+=Math.abs((it.in??0)-(last.out??0));
      last.end=it.end;last.out=it.out;last.parts++;
    } else merged.push({...it,parts:1,gap:0});
  }
  const segments:Segment[]=merged.map(m=>({
    output:[r3(m.start),r3(m.end)],
    source:nameOf.get(m.clipId??'')??`?${m.clipId}`,
    source_range:[r3(m.in??0),r3(m.out??0)],
  }));
  for(const m of merged){
    const s=nameOf.get(m.clipId??'');
    if(m.parts>1&&m.gap>0.05)warnings.push(`clip ${s}: ${m.parts} pieces with ${m.gap.toFixed(2)} s cut out of the middle; output no longer maps 1:1 to source, SSIM check may fail this slot`);
    if(m.zoom)warnings.push(`clip ${s}: zoom on a-roll; SSIM check may fail this slot`);
    // A crossfade or whip overlaps the clip before by duration/2: output no longer starts on source `in`.
    if(m.transition)warnings.push(`clip ${s}: ${m.transition.kind} transition into it; frames near the join mix two clips`);
    const full=doc.clips.find(c=>c.id===m.clipId)?.duration;
    if(full&&((m.in??0)>0.05||full-(m.out??0)>0.1))warnings.push(`clip ${s}: plays ${(m.in??0).toFixed(2)}-${(m.out??0).toFixed(2)} s of ${full.toFixed(2)} s; the task asks for whole clips`);
  }
  for(let k=1;k<merged.length;k++){
    const gap=merged[k]!.start-merged[k-1]!.end;
    if(Math.abs(gap)>0.02)warnings.push(`output gap ${gap.toFixed(3)} s before clip ${segments[k]!.source}`);
  }
  if(merged.length&&merged[0]!.start>0.02)warnings.push(`timeline starts at ${merged[0]!.start} s, not 0`);
  // Anything drawn over the a-roll changes the frames the judge compares.
  for(const track of ['b-roll','zoom','text','captions','graphics']){
    for(const it of shown(doc.tracks[track])){
      const hit=merged.filter(m=>overlaps(m,it)).map(m=>nameOf.get(m.clipId??''));
      if(hit.length)warnings.push(`${track} item ${it.id} over clip(s) ${hit.join(',')}; SSIM check may fail there`);
    }
  }
  const used=segments.map(s=>s.source);
  const dup=used.filter((s,i)=>used.indexOf(s)!==i);
  const missing=expected.filter(e=>!used.includes(e));
  const extra=used.filter(s=>!expected.includes(s));
  if(dup.length)errors.push(`clip(s) used twice, not back to back: ${[...new Set(dup)].join(',')}`);
  if(missing.length)errors.push(`clip(s) left out: ${missing.join(',')} (judge scores the task 0)`);
  if(extra.length)errors.push(`unknown source(s): ${extra.join(',')}`);
  return {segments,warnings,errors};
}

function probeDuration(mp4:string):number {
  const p=Bun.spawnSync(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',mp4]);
  return Number(p.stdout.toString().trim());
}

if(import.meta.main){
  const args=process.argv.slice(2);
  const flag=(f:string)=>{const i=args.indexOf(f);return i>=0?args[i+1]:undefined;};
  const editJson=args[0],materials=flag('--materials');
  if(!editJson||!materials){console.error('usage: to-solution.ts <edit.json> --materials <dir> [--mp4 <file>] [--out <file>]');process.exit(2);}
  const doc=JSON.parse(readFileSync(editJson,'utf8')) as Doc;
  const expected=readdirSync(materials).filter(f=>/^\d+\.mp4$/.test(f)).map(f=>f.replace('.mp4','')).sort((a,b)=>+a-+b);
  const {segments,warnings,errors}=toSolution(doc,expected);
  const mp4=flag('--mp4');
  if(mp4&&segments.length){
    const d=probeDuration(mp4),end=segments.at(-1)!.output[1];
    if(Math.abs(d-end)>0.1)warnings.push(`solution.mp4 is ${d.toFixed(3)} s but the timeline ends at ${end} s`);
  }
  for(const w of warnings)console.error(`warn: ${w}`);
  for(const e of errors)console.error(`error: ${e}`);
  if(errors.length)process.exit(1);
  const out=resolve(flag('--out')??'solution.json');
  writeFileSync(out,JSON.stringify({segments},null,2)+'\n');
  console.error(`wrote ${out}: ${segments.length} slots, ${warnings.length} warning(s)`);
}
