// Look-first tools and gates. survey_clips shows each footage clip's stills
// (both edges and three between) with its camera movement and shot size
// measured; rank_candidates checks a choice between clips scored every brief
// field from those frames. Wordless clips have only index text until looked
// at, so placing one unseen is refused (see the gates at the end). The
// survey is the overview; a run of wordless shots in a cut also waits for a
// close look (timeline_view) at each, since small stills alone misordered
// them on bench2 (seq-23, seq-26).
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod/v4';
import {clipOf,speaking,type Job,type JobClip} from './cut';
import {ff} from './look';
import {defineTool,type ToolDef} from './port';
import {labelFlags,measureMovement,rankCandidates,SAMPLE_H,SAMPLE_W,shotSize,splitFrames,surveyTimes,type Look,type ShotSize} from './survey';
import type {Workspace} from './tools';

/** Most clips one survey shows: one row of stills each. */
export const SURVEY_MAX=6;
/** Grey frames sampled per clip for movement; spacing never under 0.1 s. */
const MOTION_FRAMES=40;
const STILL_W=320;

/** Video clips with no speaker of their own: chosen from text unless someone looks. */
const footageClips=(job:Job)=>job.clips.filter(c=>c.ref.kind==='video'&&!speaking(c)&&c.ref.role!=='music'&&c.ref.role!=='sfx');
export const hasFootage=(job:Job)=>footageClips(job).length>0;
export const viewed=(ws:Workspace,id:string)=>ws.viewed?.has(id)??false;
export const markViewed=(ws:Workspace,id:string)=>{(ws.viewed??=new Set()).add(id);};
export const markLooked=(ws:Workspace,id:string)=>{(ws.looked??=new Set()).add(id);};

type Motion={every:number;frames:Uint8Array[]}|null;

async function motionOf(ws:Workspace,c:JobClip):Promise<Motion> {
  const cache=ws.motion??=new Map();
  if(cache.has(c.ref.id))return cache.get(c.ref.id)!;
  let got:Motion=null;
  if(ws.frames.sample)try {
    const every=Math.max(0.1,Math.round(c.ref.duration/MOTION_FRAMES*100)/100);
    const frames=splitFrames(await ws.frames.sample(c.ref.hash,every,SAMPLE_W,SAMPLE_H));
    if(frames.length>=2)got={every,frames};
  } catch {/* not measured */}
  cache.set(c.ref.id,got);
  return got;
}
function lookIn(m:Motion,start:number,end:number):Look|undefined {
  if(!m)return undefined;
  const fs=m.frames.filter((_,k)=>k*m.every>=start-1e-6&&k*m.every<end);
  return fs.length>=2?measureMovement(fs):undefined;
}
/** Shot size from the index's face boxes: the size held longest. */
function sizeOf(c:JobClip,start=0,end=c.ref.duration):{size:ShotSize;h:number}|undefined {
  const segs=(c.index?.segments??[]).filter(s=>s.face&&s.end>start&&s.start<end)
    .sort((a,b)=>(Math.min(b.end,end)-Math.max(b.start,start))-(Math.min(a.end,end)-Math.max(a.start,start)));
  const h=segs[0]?.face?.h;
  return h===undefined?undefined:{size:shotSize(h)!,h};
}
const lookText=(l:Look|undefined)=>!l?'not measured (no frame sampler here): judge it from the stills'
  :`${l.movement==='unclear'?'unclear (the frames disagree: something in shot moves on its own; judge from the stills)':l.movement} (first to last frame: scale ${l.scale.toFixed(3)}, shift ${l.dx.toFixed(2)} wide ${l.dy.toFixed(2)} high, fit ${l.fit.toFixed(2)}). Measured on the whole frame: a person walking at the lens also grows; check on the stills`;
const f2=(x:number)=>x.toFixed(2);

/** One row of stills per clip, tiled. Missing stills repeat a neighbour so rows stay aligned. */
async function sheet(dir:string,rows:Uint8Array[][]):Promise<Uint8Array|undefined> {
  await mkdir(dir,{recursive:true});
  let n=0;
  for(const r of rows)for(const j of r)await writeFile(join(dir,`s-${n++}.jpg`),j);
  const out=join(dir,'survey.jpg');
  await ff(['-start_number','0','-i',join(dir,'s-%d.jpg'),'-vf',`scale=${STILL_W}:-2,tile=${rows[0]!.length}x${rows.length}:padding=4:color=white`,'-frames:v','1',out]);
  return new Uint8Array(await readFile(out));
}

export function surveyTools(ws:Workspace):ToolDef<any>[] {
  return [
    defineTool({name:'survey_clips',description:`The overview of footage, before you choose or place it. For each clip (up to ${SURVEY_MAX} a call; default the footage not looked at yet): one row of stills at its first frame, a quarter, half, three quarters and its last frame, with its camera movement measured from the frames (static, push-in, pull-out, pan, tilt) and its shot size from the face (close, medium, wide). Index lines it disagrees with come back as LOW CONFIDENCE. The index was written from 1-2 stills a segment; the stills and the measures win. For a clip with no words, nothing else tells you what it shows. Small stills only: for order and close calls, follow with timeline_view.`,
      input:{clips:z.array(z.string()).max(SURVEY_MAX).optional()},
      run:async({clips})=>{
        const pick=clips?.length?clips.map(id=>clipOf(ws.job,id)):footageClips(ws.job).filter(c=>!viewed(ws,c.ref.id)).slice(0,SURVEY_MAX);
        if(!pick.length)return {text:'every footage clip has been looked at; name clips to look again'};
        const lines:string[]=[],rows:Uint8Array[][]=[];
        for(const c of pick) {
          if(c.ref.kind!=='video')throw new Error(`${c.ref.id} is not video`);
          const fps=c.ref.fps?c.ref.fps.num/c.ref.fps.den:30;
          const times=surveyTimes(c.ref.duration,fps);
          const got=await ws.frames.frames(c.ref.hash,times,STILL_W).catch(()=>[] as (Uint8Array|null)[]);
          const first=got.find(Boolean);
          const motion=await motionOf(ws,c);
          const size=sizeOf(c);
          lines.push(`${c.ref.id} "${c.ref.name}" ${c.ref.role}, ${c.ref.duration.toFixed(1)}s${first?` (row ${rows.length+1}: stills at ${times.map(f2).join(', ')}s)`:': frames failed, not looked at'}`,
            `  camera: ${lookText(lookIn(motion,0,c.ref.duration))}`,
            `  shot size: ${size?`${size.size} (face ${Math.round(size.h*100)}% of the frame height)`:'no face in the index: judge it from the stills'}`);
          if(first) {
            let last=first;
            rows.push(times.map((_,k)=>(last=got[k]??last)));
            markViewed(ws,c.ref.id);
          } else (ws.unseeable??=new Set()).add(c.ref.id);
          if(c.index) {
            for(const s of c.index.segments)lines.push(`  index ${s.id} ${s.start.toFixed(1)}-${s.end.toFixed(1)}s ${s.shotType}: ${s.description.slice(0,140)}`);
            for(const f of labelFlags(c.index,(a,b)=>lookIn(motion,a,b)))lines.push(`  LOW CONFIDENCE ${f.segment}: ${f.why}`);
          }
        }
        const img=rows.length?await sheet(join(ws.dir,'survey',String(ws.edits??0)+'-'+pick.map(c=>c.ref.id).join('-')),rows).catch(()=>undefined):undefined;
        const left=footageClips(ws.job).filter(c=>!viewed(ws,c.ref.id)).map(c=>c.ref.id);
        lines.push(left.length?`not looked at yet: ${left.join(', ')}`:'every footage clip looked at',
          'This is the overview: small stills, no sound, no words. Before you order wordless shots, timeline_view every clip whose place is still unclear and both clips of any pair you could swap; set_cut waits for that on footage shots placed next to each other.',
          'Choosing between clips for a slot: score each on every field the brief names with rank_candidates.');
        return {text:lines.join('\n'),...(img?{images:[{data:img,mime:'image/jpeg' as const}]}:{})};
      }}),

    defineTool({name:'rank_candidates',description:'Choose between clips for one slot from what their frames show. Name every field the brief asks for (subject, action, shot size, camera movement, setting, light …) and score every candidate on every field: 2 matches, 1 partly, 0 does not, with what you saw in the frames. Code checks every candidate was looked at and every field scored, tests what you saw against the measured movement and shot size, and returns the ranking. Score from the stills, not the index text.',
      input:{slot:z.string().max(200).describe('what the slot needs, in the brief\'s words'),
        fields:z.array(z.string().max(40)).min(1).max(8),
        candidates:z.array(z.string()).min(2).max(12).describe('clip ids in the running'),
        scores:z.array(z.object({clip:z.string(),field:z.string().max(40),score:z.number().int().min(0).max(2),seen:z.string().max(200).describe('what the frames show for this field')})).min(2).max(96)},
      run:async({slot,fields,candidates,scores})=>{
        for(const id of candidates)clipOf(ws.job,id);
        const measured=new Map<string,{look?:Look;size?:ShotSize}>();
        for(const id of candidates) {
          const c=clipOf(ws.job,id),m=await motionOf(ws,c),look=lookIn(m,0,c.ref.duration),size=sizeOf(c)?.size;
          measured.set(id,{...(look?{look}:{}),...(size?{size}:{})});
        }
        const r=rankCandidates({fields,scores,candidates,viewed:ws.viewed??new Set(),measured:id=>measured.get(id)});
        const errs=[
          r.unviewed.length&&`look at ${r.unviewed.join(', ')} first (survey_clips): its frames were never shown to you`,
          r.unscored.length&&`no scores for ${r.unscored.join(', ')}`,
          r.missing.length&&`fields not scored: ${r.missing.join('; ')}`,
        ].filter(Boolean);
        if(errs.length)throw new Error(errs.join('\n'));
        return {text:[`ranking for "${slot}" (${fields.length} fields, ${fields.length*2} points):`,
          ...r.ranked.map((x,k)=>`${k+1}. ${x.clip} ${x.total}`),
          ...r.close.map(x=>`close: ${x}. Look at both again on the field that splits them`),
          ...(r.flags.length?['CHECK AGAIN, what you saw disagrees with the measures:',...r.flags.map(x=>`- ${x}`)]:[])].join('\n')};
      }}),
  ];
}

/** Gate on show_footage: a clip never looked at is refused once. */
export function showGate(ws:Workspace,footage:string):void {
  if(viewed(ws,footage))return;
  const asked=ws.viewAsked??=new Set();
  if(asked.has(footage))return;
  asked.add(footage);
  throw new Error(`look at ${footage} first (survey_clips or timeline_view): you have only its index text, written from 1-2 stills. Call again to place it unseen`);
}

/** Note wording that says the agent doubts a clip's place. */
const UNSURE=/\b(unsure|not sure|uncertain|could (?:be )?swap|swappable|either way|could go (?:before|after|either))\b/i;

/**
 * Gate on set_cut, four checks (the first on any clip, talk included):
 * - a clip the agent marks unsure (the `unsure` list or a note) waits for timeline_view, every time;
 * Then three on footage shots (wordless video placed as
 * its own stretch):
 * - a footage shot never looked at is refused, every time (blind placement);
 * - footage in a run (next to another footage shot) waits for a close look
 *   with timeline_view, every time: only the picture sets its order;
 * - other footage not looked at yet is refused once.
 * Clips whose frames could not be read never hold the cut.
 */
export function cutGate(ws:Workspace,segs:{clip:string;shot:boolean;note?:string}[],unsure:string[]=[]):void {
  const footage=new Set(footageClips(ws.job).map(c=>c.ref.id));
  const isFoot=(k:number)=>!!segs[k]?.shot&&footage.has(segs[k]!.clip);
  const can=(id:string)=>!ws.unseeable?.has(id);
  // Clips the agent itself doubts (the unsure list, or a note that says so), talk or not, wait for a close look, every time.
  const inCut=new Set(segs.map(s=>s.clip));
  const doubted=[...new Set([...unsure,...segs.filter(s=>s.note&&UNSURE.test(s.note)).map(s=>s.clip)])];
  const open=doubted.filter(id=>inCut.has(id)&&can(id)&&!ws.looked?.has(id));
  if(open.length)throw new Error(`you are unsure where ${open.join(', ')} go${open.length>1?'':'es'}: timeline_view each over its whole length (frames, sound, words), and the clips it could swap with, then set_cut again. Keep a clip in unsure only while its place is still a guess`);
  if(!segs.some((_,k)=>isFoot(k)))return;
  const placed=[...new Set(segs.filter((_,k)=>isFoot(k)).map(s=>s.clip))];
  const blind=placed.filter(id=>can(id)&&!viewed(ws,id));
  if(blind.length)throw new Error(`look at ${blind.join(', ')} before you place ${blind.length>1?'them':'it'}: survey_clips (up to ${SURVEY_MAX} a call), then timeline_view where the order is unclear. Index text and transcript do not show what a clip without words looks like`);
  const run=[...new Set(segs.filter((_,k)=>isFoot(k)&&(isFoot(k-1)||isFoot(k+1))).map(s=>s.clip))];
  const far=run.filter(id=>can(id)&&!ws.looked?.has(id));
  if(far.length)throw new Error(`seen only as survey stills: ${far.join(', ')}. These sit next to other wordless shots, so only the picture sets their order. timeline_view each over its whole length (frames, sound, words) and check where it goes against its neighbours, then set_cut again`);
  const left=footageClips(ws.job).filter(c=>can(c.ref.id)&&!viewed(ws,c.ref.id)).map(c=>c.ref.id);
  const asked=ws.viewAsked??=new Set();
  if(!left.length||asked.has('#cut'))return;
  asked.add('#cut');
  throw new Error(`look at every footage clip before you sequence them: ${left.join(', ')} not looked at yet (survey_clips, up to ${SURVEY_MAX} a call). Call again to set the cut without them`);
}

/** Index lines for find_footage: labels to distrust, and clips nobody has looked at. */
export function labelNotes(ws:Workspace,clips:JobClip[]):string {
  const out:string[]=[];
  for(const c of clips) {
    if(!c.index||c.moments?.moments.length)continue;
    const m=ws.motion?.get(c.ref.id)??null;
    for(const f of labelFlags(c.index,(a,b)=>lookIn(m,a,b)))out.push(`LOW CONFIDENCE ${c.ref.id} ${f.segment}: ${f.why}`);
  }
  const left=clips.filter(c=>c.ref.kind==='video'&&!speaking(c)&&!viewed(ws,c.ref.id)).map(c=>c.ref.id);
  if(left.length)out.push(`unchecked against frames (index text only): ${left.join(', ')}. Look with survey_clips before you choose`);
  return out.length?`\n\n${out.join('\n')}`:'';
}
