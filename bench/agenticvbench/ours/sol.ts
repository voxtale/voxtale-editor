// Wrapper over ../to-solution.ts: for Assembly tasks the
// expected set is the picked clips, not every clip in materials.
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {toSolution} from '../to-solution.ts';
const [editJson,materials,mp4,out,mode]=process.argv.slice(2);
const doc=JSON.parse(readFileSync(editJson!,'utf8'));
const all=readdirSync(materials!).filter(f=>/^\d+\.mp4$/.test(f)).map(f=>f.replace('.mp4','')).sort((a,b)=>+a-+b);
let {segments,warnings,errors}=toSolution(doc,all);
if(mode==='asm')errors=errors.filter(e=>!e.startsWith('clip(s) left out'));
const d=Number(Bun.spawnSync(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',mp4!]).stdout.toString().trim());
if(segments.length){const end=segments.at(-1)!.output[1];if(Math.abs(d-end)>0.1)warnings.push(`solution.mp4 is ${d.toFixed(3)} s but the timeline ends at ${end} s`);}
for(const w of warnings)console.error(`warn: ${w}`);for(const e of errors)console.error(`error: ${e}`);
writeFileSync(out!,JSON.stringify({segments},null,2)+'\n');
console.error(`wrote ${out}: ${segments.length} slots, ${warnings.length} warning(s), ${errors.length} error(s)`);
if(errors.length)process.exit(1);
