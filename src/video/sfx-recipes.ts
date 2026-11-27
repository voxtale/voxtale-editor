// Sound effects made on this computer from a recipe: an ffmpeg lavfi audio
// graph the agent picks or writes, rendered by code. Only filters that make or
// change sound are allowed: none reads or writes a file. Generated sound is
// ours to use, so no licence or download question comes up.
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {soundPeak} from './sfx';

export const SFX_GRAPH_SOURCES=new Set(['sine','anoisesrc','aevalsrc','anullsrc','afirsrc','sinc']);
export const SFX_GRAPH_FILTERS=new Set([
  'afade','acrossfade','volume','lowpass','highpass','bandpass','bandreject','allpass','equalizer','lowshelf','highshelf',
  'tiltshelf','bass','treble','biquad','asubboost','asubcut','asupercut','asuperpass','asuperstop','aecho','areverse',
  'atempo','asetrate','aresample','aformat','amix','amerge','asplit','pan','adelay','apad','atrim','asetpts','concat',
  'aloop','tremolo','vibrato','aphaser','flanger','chorus','apulsator','acompressor','alimiter','agate','compand',
  'acrusher','aexciter','crystalizer','asoftclip','apsyclip','aeval','afftfilt','afir','aderivative','aintegral',
  'afreqshift','aphaseshift','extrastereo','stereotools','stereowiden','haas','adecorrelate','dynaudnorm','deesser',
]);
/** Longest effect, seconds. */
export const SFX_MAX_SECONDS=30;
const MAX_GRAPH=2000;

/** The graph without quoted text and escapes: what ffmpeg reads as names. */
const bare=(graph:string)=>graph.replace(/'[^']*'|\\./gs,'');
/** Filter names in a graph, labels stripped. */
export function graphFilters(graph:string):string[] {
  return bare(graph).split(/[;,]/).map(p=>p.replace(/^(\s*\[[^\]]*\])*\s*/,'')).filter(n=>n.trim()).map(n=>/^[\w.-]*/.exec(n)![0]);
}

/** Why this graph may not run, or null. */
export function badSfxGraph(graph:string):string|null {
  if(graph.length>MAX_GRAPH)return `graph longer than ${MAX_GRAPH} characters`;
  const names=graphFilters(graph);
  const bad=[...new Set(names.filter(n=>!SFX_GRAPH_SOURCES.has(n)&&!SFX_GRAPH_FILTERS.has(n)))].sort();
  if(bad.length||!names.length)return `filter not allowed: ${bad.join(', ')||'none'}. Sources: ${[...SFX_GRAPH_SOURCES].sort().join(', ')}; filters: ${[...SFX_GRAPH_FILTERS].sort().join(', ')}`;
  if(!names.some(n=>SFX_GRAPH_SOURCES.has(n)))return 'no sound source (sine, anoisesrc, aevalsrc …)';
  // "/option=file" would read the option's value from a file.
  if(/(^|[=:,;\]])\s*\//.test(bare(graph)))return 'an option may not be read from a file ("/option=")';
  return null;
}

/** A starter recipe: its graph at a pitch factor (1 = as written). */
interface Recipe {about:string;graph:(p:number)=>string}
const f=(x:number)=>Number(x.toFixed(1));

/**
 * Starter recipes, each ending on a fade-out. The first five are REDACTED's (rules/bruitages.md); variants change pitch.
 * from REDACTED rules/bruitages.md
 */
export const SFX_RECIPES={
  whoosh:{about:'air past the camera, for a move or a slide',graph:p=>`anoisesrc=d=0.6:seed=7:c=pink:a=0.8,bandpass=f=${f(1200*p)}:t=o:w=1.5,afade=t=in:d=0.35:curve=exp,afade=t=out:st=0.35:d=0.25:curve=exp`},
  impact:{about:'a low hit, for the big moment',graph:p=>`sine=f=${f(60*p)}:d=0.6,afade=t=out:d=0.55:curve=exp[a];anoisesrc=d=0.08:seed=7:c=white,afade=t=out:d=0.08[b];[a][b]amix=inputs=2:normalize=0`},
  riser:{about:'a rising tone, into a reveal',graph:p=>`aevalsrc='0.4*sin(2*PI*(${f(150*p)}*t+${f(300*p)}*t*t))':d=1.5,afade=t=in:d=1.4:curve=exp,afade=t=out:st=1.45:d=0.05`},
  click:{about:'a short click, for a UI step',graph:p=>`anoisesrc=d=0.012:seed=7:c=white:a=0.9,highpass=f=${f(2000*p)},afade=t=out:d=0.012`},
  pop:{about:'a falling blip, for something appearing',graph:p=>`aevalsrc='0.8*sin(2*PI*(${f(900*p)}*t-${f(3000*p)}*t*t))':d=0.12,afade=t=in:d=0.003,afade=t=out:d=0.1:curve=exp`},
  tick:{about:'a soft tick, for a counter or list item',graph:p=>`sine=f=${f(2400*p)}:d=0.03,afade=t=in:d=0.002,afade=t=out:st=0.004:d=0.026:curve=exp,volume=0.6`},
  ding:{about:'a bell tone, for a correct answer or a done step',graph:p=>`sine=f=${f(1320*p)}:d=1.2,afade=t=out:d=1.15:curve=exp[a];sine=f=${f(2640*p)}:d=0.6,volume=0.3,afade=t=out:d=0.55:curve=exp[b];[a][b]amix=inputs=2:normalize=0`},
  thud:{about:'a dull low knock, for a card landing',graph:p=>`anoisesrc=d=0.25:seed=7:c=brown:a=0.9,lowpass=f=${f(300*p)},afade=t=in:d=0.004,afade=t=out:st=0.02:d=0.23:curve=exp`},
  swish:{about:'a fast high swish, for a quick cut or a flick',graph:p=>`anoisesrc=d=0.3:seed=7:c=white:a=0.6,highpass=f=${f(2500*p)},afade=t=in:d=0.18:curve=exp,afade=t=out:st=0.18:d=0.12:curve=exp`},
  drop:{about:'a falling bass, after a build or on a title',graph:p=>`aevalsrc='0.8*sin(2*PI*(${f(140*p)}*t-${f(45*p)}*t*t))':d=1.2,afade=t=in:d=0.01,afade=t=out:st=0.4:d=0.8:curve=exp`},
  glitch:{about:'a digital crackle, for an error or a jump',graph:p=>`anoisesrc=d=0.25:seed=7:c=white:a=0.7,acrusher=bits=4:mode=log:aa=0,tremolo=f=${f(30*p)}:d=0.9,afade=t=out:st=0.15:d=0.1`},
  shutter:{about:'a two-part camera click, for a photo or a freeze',graph:p=>`anoisesrc=d=0.02:seed=7:c=white:a=0.9,highpass=f=${f(1500*p)},afade=t=out:d=0.02[a];anoisesrc=d=0.03:seed=7:c=white:a=0.7,bandpass=f=${f(3000*p)}:w=2000,afade=t=out:d=0.03,adelay=70[b];[a][b]amix=inputs=2:normalize=0,apad=pad_dur=0.05,afade=t=out:st=0.1:d=0.05`},
} satisfies Record<string,Recipe>;
export type SfxRecipe=keyof typeof SFX_RECIPES;
export const SFX_RECIPE_IDS=Object.keys(SFX_RECIPES) as SfxRecipe[];
/** Variant k's pitch factor: same kind of sound, not the same sound twice. */
export const SFX_VARIANTS=[1,0.84,1.19,0.71,1.41];
export const recipeGraph=(r:SfxRecipe,variant=0)=>SFX_RECIPES[r].graph(SFX_VARIANTS[variant%SFX_VARIANTS.length]!);

export interface MadeSfx {path:string;hash:string;duration:number;peak:number;levelDb:number}
type Ff=(args:string[])=>Promise<void>;

/**
 * Render a graph to a 48 kHz WAV in `dir`, limited under -1 dBFS, and measure its loudest moment. The same graph and length
 * are the same sound: one hash, one file, made once.
 * from REDACTED REDACTED/sfx.py (ffmpeg -f lavfi, alimiter, pcm_s24le, written via a .part file)
 */
export async function makeSfx(ff:Ff,dir:string,name:string,graph:string,seconds?:number):Promise<MadeSfx> {
  const why=badSfxGraph(graph);
  if(why)throw new Error(`recipe refused: ${why}`);
  if(seconds!==undefined&&!(seconds>0&&seconds<=SFX_MAX_SECONDS))throw new Error(`duration: 0 to ${SFX_MAX_SECONDS}s`);
  const slug=name.replace(/[^\w-]+/g,'_').slice(0,60)||'sfx';
  // The recipe is the sound's identity: noise without a seed differs run to run, the clip must not.
  const hash=createHash('sha256').update(`sfx-recipe\n${graph}\n${seconds??SFX_MAX_SECONDS}`).digest('hex'),key=hash.slice(0,8);
  await mkdir(dir,{recursive:true});
  const out=join(dir,`${slug}-${key}.wav`),part=`${out}.part`,pcm=join(dir,`${slug}-${key}.f32`);
  try {
    if(!existsSync(out)) {
      await ff(['-f','lavfi','-i',graph,'-t',String(seconds??SFX_MAX_SECONDS),'-af','alimiter=limit=0.891:level=0:latency=1','-ar','48000','-c:a','pcm_s24le','-f','wav',part]);
      await rename(part,out);
    }
    await ff(['-i',out,'-ac','1','-ar','8000','-f','f32le','-c:a','pcm_f32le',pcm]);
  } catch(e) {
    await rm(part,{force:true});
    throw new Error(`recipe failed: ${String((e as Error).message??e).split(/\s+/).join(' ').slice(-400)}`);
  }
  const bytes=await readFile(pcm);
  await rm(pcm,{force:true});
  const x=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+Math.floor(bytes.byteLength/4)*4));
  if(!x.length)throw new Error('recipe failed: no sound');
  const p=soundPeak(x,8000);
  return {path:out,hash,duration:x.length/8000,peak:p.t,levelDb:p.db};
}
