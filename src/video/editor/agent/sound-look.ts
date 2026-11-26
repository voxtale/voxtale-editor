// The agent's sound and picture finish: sound-effect hits on gestures
// (set_sfx), the colour grade (set_look), the loudness picture of the mix, and
// standing rules the creator's words ask for (propose_rule).
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod/v4';
import {applyGrade,clipColorSpace,clipConversion,clipLut,parseCube,sampleCube,COLOR_SPACES,GRADE_LOOK_IDS,LUT_SIZE,luma,pruneGrade,toLinear,whiteBalanceFor,writeCube,type ClipRef,type Cube,type EditDoc,type Grade,type GradeLookId,type RGB} from '@voxtale/editdoc';
import {LOOK_COLOR_NOTE} from './media-skill-text';
import {AUDIO_RATE} from '@voxtale/frames';
import {speechLoudness} from '../../audio';
import {libraryClip,librarySound,SFX_SOUND_IDS,SFX_SOUNDS,SFX_UNDER_VOICE,sfxWarnings,soundPeak,type PlacedHit,type SfxSound} from '../../sfx';
import {proposeRule} from '../rules';
import {clipOf,gestureTime,type SfxPlacement} from './cut';
import {ff} from './look';
import {defineTool,type ToolDef} from './port';
import type {Workspace} from './tools';

type Change=(ws:Workspace,f:()=>void)=>Promise<void>;

export const SFX_HITS_MAX=24;
/** More impacts than this in one video and each one means less. */
export const IMPACTS_MAX=3;

const isLibrary=(s:string):s is SfxSound=>(SFX_SOUND_IDS as string[]).includes(s);
const round1=(x:number)=>Math.round(x*10)/10;

/** Kind of gesture an item id names, for "one sound per kind of gesture". */
function gestureKind(on:SfxPlacement['on']):string {
  if('word' in on)return 'word';
  const id=on.item;
  return id.startsWith('g-')?'graphic':id.startsWith('t-')?'text':id.startsWith('b-')?'footage':id.startsWith('zoom-')?'zoom':id.startsWith('ch-')?'chapter':'item';
}

/** An item id as the agent gave it (its own id, or the doc id), resolved against the doc. */
function resolveItem(ws:Workspace,doc:EditDoc,id:string):string|undefined {
  for(const c of [id,`g-${id}`,`t-${id}`,`b-${id}`])if(gestureTime(ws.job,doc,{item:c})!==undefined)return c;
  return undefined;
}

/** Ids a hit can name, for the error when one is missing. */
function gestureIds(doc:EditDoc):string[] {
  const syncedPiece=/^b-.+-\d+$/;
  return [...doc.tracks.graphics,...doc.tracks.text,...doc.tracks['b-roll'],...doc.tracks.zoom].map(i=>i.id)
    .filter(id=>!syncedPiece.test(id)||!doc.tracks['b-roll'].some(x=>id.startsWith(`${x.id}-`)))
    .concat(doc.markers.filter(m=>m.kind==='chapter').map(m=>m.id)).slice(0,40);
}

/** Where a creator's effect file peaks and how loud, from its first seconds; library sounds are known. */
async function measured(ws:Workspace,sound:string):Promise<{clipId:string;peak:number;levelDb:number;label:string}> {
  if(isLibrary(sound)){const s=librarySound(sound);return {clipId:libraryClip(sound).id,peak:s.peak,levelDb:s.levelDb,label:sound};}
  const c=ws.job.clips.find(x=>x.ref.id===sound);
  if(!c||c.ref.role!=='sfx')throw new Error(`no sound ${sound}: use one of ${SFX_SOUND_IDS.join(', ')}${ws.job.clips.some(x=>x.ref.role==='sfx')?` or an sfx clip (${ws.job.clips.filter(x=>x.ref.role==='sfx').map(x=>x.ref.id).join(', ')})`:''}`);
  const cache=ws.sfxPeaks??={};
  if(!cache[c.ref.id]) {
    let p={t:0,db:-12};
    if(ws.frames.audio)try {
      const raw=await ws.frames.audio(c.ref.hash,0,Math.min(c.ref.duration,10));
      const x=new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+Math.floor(raw.byteLength/4)*4));
      if(x.length)p=soundPeak(x,AUDIO_RATE);
    } catch {/* the file's start, at a guessed level */}
    cache[c.ref.id]={peak:p.t,levelDb:p.db};
  }
  return {clipId:c.ref.id,...cache[c.ref.id]!,label:c.ref.name};
}

/** The hits in the built doc, with how loud each peaks against the voice target. */
export function placedHits(ws:Workspace,doc:EditDoc):PlacedHit[] {
  const target=doc.mix.loudnessLufs,by=new Map((ws.sfx??[]).map(p=>[`sfx-${p.id}`,p]));
  return doc.tracks.sfx.filter(i=>i.status!=='suggested').map(i=>{
    const p=by.get(i.id);
    const at=p?i.start+p.peak-i.in:i.start;
    return {id:i.id,sound:p?.sound??clipOf(ws.job,i.clipId)?.ref.name??i.clipId,at,gainDb:i.gainDb,
      ...(p?.levelDb!==undefined?{againstVoiceDb:round1(p.levelDb+i.gainDb-target)}:{})};
  });
}

/** set_sfx warnings and the hit count, for check_cut. */
export function sfxLines(ws:Workspace,doc:EditDoc):string[] {
  const hits=placedHits(ws,doc);
  if(!hits.length)return [];
  const warn=sfxWarnings(hits);
  const ps=ws.sfx??[];
  const impacts=ps.filter(p=>p.sound==='impact').length;
  if(impacts>IMPACTS_MAX)warn.push(`${impacts} impacts: keep them for the ${IMPACTS_MAX} biggest moments, use a click or pop for the rest`);
  const kinds=new Map<string,Set<string>>();
  for(const p of ps){const k=gestureKind(p.on);if(k==='word'||k==='item')continue;(kinds.get(k)??kinds.set(k,new Set()).get(k)!).add(p.sound??p.clipId);}
  for(const [k,s] of kinds)if(s.size>1)warn.push(`${k} entrances use ${s.size} different sounds (${[...s].join(', ')}): one sound per kind of gesture reads as design`);
  return [`sound effects: ${hits.length} hit(s)${ps.length?' (set_sfx)':' (placed by code)'}`,...warn.map(w=>`- ${w}`)];
}

/** The mix's loudness as code knows it before a render: speech, music under it, effects against it. */
export function loudnessLines(ws:Workspace,doc:EditDoc):string[] {
  const target=doc.mix.loudnessLufs,peak=doc.mix.truePeakDb;
  const clips=new Map(doc.clips.map(c=>[c.id,c]));
  const out=[`loudness target: ${target} LUFS integrated, true peak under ${peak} dBTP (the render measures both on the delivered file)`];
  const speech=speechLoudness(doc);
  out.push(speech===undefined?'- speech: not measured (no loudness on the speaking clips)'
    :`- speech: ${speech.toFixed(1)} LUFS as recorded; gain ${doc.mix.speechGainDb>=0?'+':''}${doc.mix.speechGainDb.toFixed(1)} dB lifts it to ${(speech+doc.mix.speechGainDb).toFixed(1)}`);
  const music=doc.tracks.music.filter(m=>m.status!=='suggested');
  if(music.length) {
    const want=-doc.styleRef.snapshot.audio.musicLevelDb;
    const under=music.map(m=>{const l=clips.get(m.clipId)?.loudness?.lufs;return l===undefined?undefined:target-(l+m.gainDb+(m.duck?doc.mix.duckingDb:0));});
    const known=under.filter((x):x is number=>x!==undefined);
    out.push(known.length?`- music: ${Math.min(...known).toFixed(1)}-${Math.max(...known).toFixed(1)} LU under the voice while it talks (style: ${want} LU)`:'- music: level not measured');
  }
  const hits=placedHits(ws,doc).filter(h=>h.againstVoiceDb!==undefined);
  if(hits.length)out.push(`- effects: loudest peaks ${Math.max(...hits.map(h=>h.againstVoiceDb!)).toFixed(1)} dB against the voice target (10 ms peak level, measured on an 8 kHz read for the creator's files)`);
  return out;
}

// ---- colour ---------------------------------------------------------------------

/** Target mid grey of a face-lit frame (sRGB median luma). Our pick, not REDACTED's. */
export const GRADE_TARGET_LUMA=0.45;
/** Exposure is left alone within a third of a stop. */
const EXPOSURE_DEADBAND=1/3,EXPOSURE_MAX=1;
/** White balance moves only past this, at half strength, at most this much. */
const WB_DEADBAND=8,WB_STRENGTH=0.5,WB_MAX=30;
/** A light look: the default and the most set_look allows. */
export const LOOK_DEFAULT=30,LOOK_MAX=60;

export interface FrameStats {medianLuma:number;stopsFromTarget:number;cast:{temperature:number;tint:number}|null;saturation:number}

export function frameStats(px:RGB[]):FrameStats {
  const l=px.map(luma).sort((a,b)=>a-b),med=l[Math.floor(l.length/2)]??0;
  // Grey world over the mid tones: clipped whites and crushed blacks say nothing of the light.
  const mid=px.filter(p=>{const y=luma(p);return y>0.08&&y<0.92;});
  const mean:RGB=[0,1,2].map(i=>mid.reduce((s,p)=>s+p[i]!,0)/Math.max(1,mid.length)) as RGB;
  const sat=px.reduce((s,p)=>s+Math.max(...p)-Math.min(...p),0)/Math.max(1,px.length);
  return {medianLuma:round3(med),stopsFromTarget:round2(Math.log2(Math.max(1e-4,toLinear(med))/toLinear(GRADE_TARGET_LUMA))),
    cast:mid.length?whiteBalanceFor(mean):null,saturation:round3(sat)};
}
const round2=(x:number)=>Math.round(x*100)/100,round3=(x:number)=>Math.round(x*1000)/1000;

/** The correction a clip's measured frames call for: exposure toward the target, half the cast taken out. */
export function correctionFor(s:FrameStats):Grade {
  const g:Grade={};
  if(Math.abs(s.stopsFromTarget)>EXPOSURE_DEADBAND)g.exposure=round2(Math.max(-EXPOSURE_MAX,Math.min(EXPOSURE_MAX,-s.stopsFromTarget)));
  const c=s.cast;
  if(c&&(Math.abs(c.temperature)>WB_DEADBAND||Math.abs(c.tint)>WB_DEADBAND)) {
    const k=(x:number)=>Math.round(Math.max(-WB_MAX,Math.min(WB_MAX,x*WB_STRENGTH)));
    if(k(c.temperature))g.temperature=k(c.temperature);
    if(k(c.tint))g.tint=k(c.tint);
  }
  return g;
}

/** "warm by 12" etc: the correction still called for, as the cast a viewer sees. */
function castText(c:FrameStats['cast']):string {
  if(!c)return 'cast unknown';
  const parts=[Math.abs(c.temperature)>WB_DEADBAND?`${c.temperature<0?'warm':'cool'} ${Math.abs(c.temperature)}`:'',
    Math.abs(c.tint)>WB_DEADBAND?`${c.tint<0?'green':'magenta'} ${Math.abs(c.tint)}`:''].filter(Boolean);
  return parts.length?parts.join(', '):'neutral';
}
const statsText=(s:FrameStats)=>`mid grey ${Math.round(s.medianLuma*100)}% (${s.stopsFromTarget>=0?'+':''}${s.stopsFromTarget} stop vs target), ${castText(s.cast)}, saturation ${Math.round(s.saturation*100)}%`;

/** Small RGB samples of a clip's frames, decoded with ffmpeg; the middle frame's JPEG for the still. */
async function samplesOf(ws:Workspace,clip:string,dir:string):Promise<{px:RGB[];still?:string}> {
  const c=clipOf(ws.job,clip),d=c.ref.duration;
  const times=[0.1,0.3,0.5,0.7,0.9].map(f=>Math.min(d-0.05,f*d));
  const jpegs=await ws.frames.frames(c.ref.hash,times,640);
  const px:RGB[]=[];let still:string|undefined;
  for(const [k,j] of jpegs.entries()) {
    if(!j)continue;
    const jpg=join(dir,`${clip}-${k}.jpg`),raw=join(dir,`${clip}-${k}.rgb`);
    await writeFile(jpg,j);
    if(k===2||!still)still=jpg;
    await ff(['-i',jpg,'-vf','scale=64:-2:flags=area','-f','rawvideo','-pix_fmt','rgb24',raw]);
    const b=await readFile(raw);
    for(let i=0;i+2<b.length;i+=3)px.push([b[i]!/255,b[i+1]!/255,b[i+2]!/255]);
  }
  return {px,...(still?{still}:{})};
}

// ---- tools ----------------------------------------------------------------------

export function soundLookTools(ws:Workspace,change:Change):ToolDef<any>[] {
  const on=z.union([
    z.object({item:z.string().describe('id of a placed graphic, text, footage shot, zoom (zoom-…) or chapter (ch-<k>): the hit lands on its entrance')}).strict(),
    z.object({clip:z.string(),word:z.number().int().describe('word id: the hit lands as the word starts')}).strict(),
  ]);
  const videoClips=()=>ws.job.clips.filter(c=>c.ref.kind!=='audio');
  return [
    defineTool({name:'set_sfx',description:`Replace the sound effects: each hit lands with its loudest moment on a gesture (a graphic, text card or shot coming in, a zoom, a chapter, a word) and follows it through recuts; a hit whose gesture leaves the cut goes with it. Sounds: ${SFX_SOUND_IDS.map(s=>`${s} (${SFX_SOUNDS[s]})`).join('; ')}; or an sfx clip the creator gave. level: dB under the voice at the hit's peak (default per sound, -8 to -14). Few and on purpose: one sound per kind of gesture, impacts only on the big moments, none on plain lines. Empty hits = no effects; auto:true hands placement back to code.`,
      input:{hits:z.array(z.object({on,sound:z.string().describe('a library sound or an sfx clip id'),
          level:z.number().min(-30).max(-2).optional().describe('dB under the voice at the peak'),
          reason:z.string().max(200).describe('why this moment gets a sound')}).strict()).max(SFX_HITS_MAX).optional(),
        auto:z.boolean().optional().describe('true: code places effects again, as before set_sfx')},
      run:async({hits,auto})=>{
        if(!ws.doc)throw new Error('set a cut first');
        if(auto){await change(ws,()=>{ws.sfx=undefined;});return {text:`code places the effects again:\n${sfxLines(ws,ws.doc!).join('\n')||'none placed'}`};}
        const doc=ws.doc,target=doc.mix.loudnessLufs;
        const ps:SfxPlacement[]=[];
        for(const [k,h] of (hits??[]).entries()) {
          let where=h.on as SfxPlacement['on'];
          if('item' in where) {
            const id=resolveItem(ws,doc,where.item);
            if(!id)throw new Error(`hit ${k+1}: no item ${where.item} in the cut. Items: ${gestureIds(doc).join(', ')||'none'}`);
            where={item:id};
          } else if(gestureTime(ws.job,doc,where)===undefined)throw new Error(`hit ${k+1}: word ${where.word} of ${where.clip} is not in the cut`);
          const m=await measured(ws,h.sound);
          const under=h.level??(isLibrary(h.sound)?SFX_UNDER_VOICE[h.sound]:-12);
          const gainDb=round1(Math.max(-60,Math.min(6,target+under-m.levelDb)));
          ps.push({id:`h${k+1}`,clipId:m.clipId,peak:m.peak,gainDb,reason:h.reason,on:where,sound:m.label,levelDb:m.levelDb});
        }
        await change(ws,()=>{ws.sfx=ps;});
        const placed=ws.doc!.tracks.sfx.filter(i=>i.owner==='agent');
        const lines=placed.map(i=>{const p=ps.find(x=>`sfx-${x.id}`===i.id);return `${i.id} ${p?.sound??i.clipId} peaks @${p?(i.start+p.peak-i.in).toFixed(2):i.start.toFixed(2)}s, gain ${i.gainDb} dB: ${i.reason}`;});
        return {text:[ps.length?`${placed.length} hit(s):`:'no sound effects',...lines,...sfxLines(ws,ws.doc!).slice(1)].join('\n')};
      }}),

    defineTool({name:'set_look',description:`Colour: measure a clip's frames and correct them (exposure toward a face-lit mid grey, half of any colour cast), then at most a light look (${GRADE_LOOK_IDS.join(', ')}; intensity ≤${LOOK_MAX}, default ${LOOK_DEFAULT}). Returns the measured numbers before and after and a before|after still. clip "all" grades every footage clip, each from its own measure. correct:false keeps the look only; look "none" removes it; off:true switches the grade off (kept for later). Correct when the numbers call for it; a look only when the creator or the style asks. ${LOOK_COLOR_NOTE}`,
      input:{clip:z.string().describe('clip id, or "all"'),
        colorSpace:z.union([z.enum(COLOR_SPACES),z.literal('auto')]).optional().describe('what the footage was shot in; auto = as detected at open'),
        inputLut:z.string().max(1000).optional().describe('a .cube to apply before the grade instead (e.g. DJI D-Log M to Rec.709); "none" removes it'),
        correct:z.boolean().optional().describe('default true'),
        look:z.union([z.enum(GRADE_LOOK_IDS),z.literal('none')]).optional(),
        intensity:z.number().min(0).max(LOOK_MAX).optional(),
        off:z.boolean().optional()},
      run:async({clip,correct,look,intensity,off,colorSpace,inputLut})=>{
        const targets=clip==='all'?videoClips().map(c=>c.ref.id):[clip];
        for(const id of targets){const c=clipOf(ws.job,id);if(c.ref.kind==='audio')throw new Error(`${id} is sound only`);}
        const dir=join(ws.dir,'looks');
        await mkdir(dir,{recursive:true});
        const grades:Record<string,Grade>={...ws.grades},lines:string[]=[],images:{data:Uint8Array;mime:'image/jpeg'}[]=[];
        const settings={...ws.clipSettings};
        for(const id of targets) {
          // Input first: log/HDR footage goes to Rec.709 before it is measured and graded.
          const now={...settings[id]};
          if(colorSpace)colorSpace==='auto'?delete now.colorSpace:now.colorSpace=colorSpace;
          if(inputLut)inputLut==='none'?delete now.inputLut:now.inputLut=inputLut;
          if(Object.keys(now).length)settings[id]=now;else delete settings[id];
          const ref:ClipRef={...clipOf(ws.job,id).ref,...now};
          let cube:Cube|null=null;
          if(ref.inputLut)try{cube=parseCube(await readFile(ref.inputLut,'utf8'));}catch(e){throw new Error(`${id}: input LUT ${ref.inputLut}: ${(e as Error).message}`);}
          const convert=cube?((c:RGB)=>{const o=sampleCube(cube!,c);c[0]=o[0];c[1]=o[1];c[2]=o[2];}):clipConversion(ref);
          const cs=cube?`input LUT ${ref.inputLut}`:clipColorSpace(ref)??'Rec.709';
          lines.push(`${id} colour: ${cs}${ref.color?.why?` (open found: ${ref.color.log??ref.color.hdr??'Rec.709'}, ${ref.color.why})`:''}`);
          const prev=grades[id];
          if(off){if(prev)grades[id]={...prev,enabled:false};lines.push(`${id}: grade off${prev?'':' (it had none)'}`);continue;}
          const {px:raw,still}=await samplesOf(ws,id,dir);
          if(!raw.length){lines.push(`${id}: frames could not be read, not graded`);continue;}
          const px=convert?raw.map(p=>{const c:RGB=[p[0],p[1],p[2]];convert(c);return c.map(v=>Math.min(1,Math.max(0,v))) as RGB;}):raw;
          const before=frameStats(px);
          const fix=correct===false?{}:correctionFor(before);
          const keepLook=look===undefined&&prev?.look?{look:prev.look,intensity:prev.intensity??LOOK_DEFAULT}:{};
          const g=pruneGrade({...fix,...keepLook,...(look&&look!=='none'?{look:look as GradeLookId,intensity:intensity??LOOK_DEFAULT}:{})});
          if(g)grades[id]=g;else delete grades[id];
          const after=frameStats(px.map(p=>applyGrade(g,p)));
          lines.push(`${id} ${clipOf(ws.job,id).ref.name}:`,`  before: ${statsText(before)}`,
            `  grade: ${g?JSON.stringify(g):'none needed'}`,`  after:  ${statsText(after)}`);
          const lut=clipLut({...ref,grade:g},cube);
          if(lut&&still&&images.length<2) {
            const cube=join(dir,`${id}.cube`),out=join(dir,`${id}-before-after.jpg`);
            await writeFile(cube,writeCube(lut,LUT_SIZE,`${id}`));
            await ff(['-i',still,'-filter_complex',`[0:v]scale=480:-2,setsar=1,split[a][b];[b]lut3d=file='${cube.replace(/'/g,"\\'")}':interp=tetrahedral[g];[a][g]hstack`,'-frames:v','1',out]);
            images.push({data:new Uint8Array(await readFile(out)),mime:'image/jpeg'});
          }
        }
        await change(ws,()=>{ws.grades=Object.keys(grades).length?grades:undefined;ws.clipSettings=Object.keys(settings).length?settings:undefined;});
        return {text:[...lines,'Measured on 5 frames per clip at 64 px; white balance by grey world over the mid tones, so a frame full of skin or one coloured wall reads as a cast: check the still.'].join('\n'),...(images.length?{images}:{})};
      }}),

    defineTool({name:'propose_rule',description:'When the creator asks for something to last ("always", "every time", "from now on", "in every video"), propose it as a standing rule, once, after doing it in this edit. Write it as one or two plain sentences an editor can follow on any video. The creator accepts, rewords or refuses it; accepted rules come in the brief of every later edit. Not for one-off fixes (this cut, this moment).',
      input:{rule:z.string().min(5).max(300),said:z.string().max(300).describe('the creator\'s own words it comes from')},
      run:async({rule,said})=>{
        const r=proposeRule((ws.proposedRules??[]).map((x,k)=>({id:`p${k}`,text:x.text,said:x.said,status:'proposed' as const,proposedAt:0})),{text:rule,said,editId:ws.job.id});
        if(r.fresh)ws.proposedRules=[...(ws.proposedRules??[]),{text:r.rule.text,said:r.rule.said}];
        await writeFile(join(ws.dir,'rules-proposed.json'),JSON.stringify(ws.proposedRules??[],null,1));
        return {text:r.fresh?`Proposed: "${r.rule.text}". The creator will accept, reword or refuse it; tell them in one line what you understood.`:'Already proposed.'};
      }}),
  ];
}
