// Audio stage (plan §4 stage 8): music beds and sound effects from the
// creator's own files, placed by code. No model: none can hear the tracks, and
// file names say little, so music follows file order and chapters, effects
// follow graphics, chapters and (when punchy) text and b-roll. Ducking and the
// final loudness are applied where the edit plays, from `mix` and each clip's
// measured loudness.
import {frameToSeconds,toFrame,type ClipRef,type EditDoc,type MixSettings,type MusicItem,type SfxItem} from '@voxtale/editdoc';

/** Longest sound effect, seconds. */
export const SFX_MAX=1.5;
/** Effects land this far before what they announce. */
export const SFX_LEAD=0.1;
const SFX_GAP={subtle:4,punchy:2} as const;
const SFX_GAIN={subtle:-20,punchy:-14} as const;
const LOOP_FADE=0.5,FIRST_FADE=1,LAST_FADE=2,MIN_BED=1;
/** Fade out of, and back into, a stretch the music leaves bare. */
const DROP_FADE=0.4;
/** An effect this short is a tick (pop, click); longer ones sweep (whoosh, riser). */
const TICK_MAX=0.6;

/** Where the music plays, on the output timeline. Absent: under the whole video. */
export interface MusicCues {
  /** Music comes in here (after the hook, say) instead of at the start. */
  from?:number;
  /** Stretches with no music: a line that should land in silence. */
  drops?:{start:number;end:number}[];
  /** Seconds into the first track where it starts playing (its lively part); default 0. */
  in?:number;
}

/**
 * A sound effect the agent placed: `peak` (seconds into the file of its
 * loudest moment) lands on `at`, the gesture's output time. Never tied to the
 * item it marks: a creator who moves the item keeps the hit where it was.
 */
export interface SfxHit {id:string;clipId:string;at:number;peak:number;gainDb:number;reason:string}

/** What an effect file sounds like, from its name, else its length: a tick marks things that appear, a sweep carries a change of scene. */
export function sfxKind(c:Pick<ClipRef,'name'|'duration'>):'tick'|'sweep' {
  if(/whoosh|swoosh|swish|sweep|riser|rise|transition|wind/i.test(c.name))return 'sweep';
  if(/pop|click|tick|ding|blip|tap|snap|bubble|beep/i.test(c.name))return 'tick';
  return c.duration<=TICK_MAX?'tick':'sweep';
}
/** Typical loudness of a mastered track, for music files not yet measured. */
const MUSIC_LUFS=-14;

/**
 * Music gain in the gaps between speech. Under speech the player ducks it by
 * `mix.duckingDb`, which lands the track `musicLevelDb` below the speech target.
 */
export function musicGainDb(doc:EditDoc,clip:ClipRef):number {
  const under=doc.styleRef.snapshot.audio.loudnessLufs+doc.styleRef.snapshot.audio.musicLevelDb;
  const db=under-doc.mix.duckingDb-(clip.loudness?.lufs??MUSIC_LUFS);
  return Math.round(Math.max(-60,Math.min(6,db))*10)/10;
}

export interface AudioPlan {music:MusicItem[];sfx:SfxItem[];mix:Partial<MixSettings>;notes:string[]}

const live=<T extends {status:string}>(xs:T[])=>xs.filter(x=>x.status!=='suggested');

/** Energy mean of the a-roll clips' loudness, weighted by time on screen. */
export function speechLoudness(doc:EditDoc):number|undefined {
  const clips=new Map(doc.clips.map(c=>[c.id,c]));
  let energy=0,seconds=0;
  for(const i of live(doc.tracks['a-roll'])) {
    const l=clips.get(i.clipId)?.loudness;
    if(!l||!Number.isFinite(l.lufs)||l.lufs<-60)continue;
    energy+=(i.end-i.start)*10**(l.lufs/10);seconds+=i.end-i.start;
  }
  return seconds>0?10*Math.log10(energy/seconds):undefined;
}

export function planAudio(doc:EditDoc,cues:MusicCues={},hits?:SfxHit[]):AudioPlan {
  const style=doc.styleRef.snapshot.audio;
  const fps=doc.fps;
  const snap=(t:number)=>frameToSeconds(toFrame(t,fps),fps);
  const floorSnap=(t:number)=>frameToSeconds(Math.floor(t*fps.num/fps.den+1e-6),fps);
  const total=snap(Math.max(0,...live(doc.tracks['a-roll']).map(i=>i.end),...live(doc.tracks.voiceover).map(i=>i.end)));
  const notes:string[]=[];
  const usable=(c:ClipRef)=>c.hasAudio&&c.kind!=='image';
  const musicClips=doc.clips.filter(c=>c.role==='music'&&usable(c));
  const sfxClips=doc.clips.filter(c=>c.role==='sfx'&&usable(c));

  // Music: one bed per chapter, cycling through the creator's tracks in order; a short track loops.
  let music:MusicItem[]=[];
  const from=snap(Math.max(0,Math.min(cues.from??0,total)));
  if(musicClips.length&&total-from>=MIN_BED) {
    const chapters=musicClips.length>1?doc.markers.filter(m=>m.kind==='chapter'&&m.status!=='suggested'&&m.time>from+MIN_BED&&m.time<total-MIN_BED).map(m=>snap(m.time)).sort((a,b)=>a-b):[];
    const bounds=[from,...new Set(chapters),total];
    for(let s=0;s<bounds.length-1;s++) {
      const clip=musicClips[s%musicClips.length]!;
      // The first bed starts at the in-point (the lively part), when the track has that much past it.
      const first=s===0?Math.max(0,Math.min(cues.in??0,clip.duration-MIN_BED)):0;
      let t=bounds[s]!,off=first,loop=0;
      while(bounds[s+1]!-t>=MIN_BED) {
        const len=floorSnap(Math.min(clip.duration-off,bounds[s+1]!-t));
        if(len<MIN_BED)break;
        music.push({id:`music-${s}-${loop}`,clipId:clip.id,in:off,out:off+len,start:t,end:t+len,owner:'agent',stage:'audio',status:'applied',
          gainDb:musicGainDb(doc,clip),fadeIn:LOOP_FADE,fadeOut:LOOP_FADE,duck:true,
          reason:bounds.length>2?`${clip.name} under this chapter.`:`${clip.name} under the video.`});
        t+=len;off=0;loop++;
      }
    }
    // Drops: the bed fades out before each one and comes back after, still in time with itself.
    const drops=(cues.drops??[]).map(d=>({start:snap(d.start),end:snap(d.end)})).filter(d=>d.end>d.start).sort((a,b)=>a.start-b.start);
    if(drops.length)music=music.flatMap(m=>{
      const pieces:MusicItem[]=[];
      let a=m.start;
      const piece=(z:number,cutAfter:boolean)=>{
        if(z-a>=MIN_BED)pieces.push({...m,id:`${m.id}-${pieces.length}`,in:m.in+(a-m.start),out:m.in+(z-m.start),start:a,end:z,
          fadeIn:a>m.start?DROP_FADE:m.fadeIn,fadeOut:cutAfter?DROP_FADE:m.fadeOut});
      };
      for(const d of drops) {
        if(d.end<=a||d.start>=m.end)continue;
        piece(Math.min(m.end,d.start),true);
        a=Math.min(m.end,d.end);
      }
      if(a===m.start)return [m];
      piece(m.end,false);
      return pieces;
    });
    const first=music[0],last=music.at(-1);
    if(first)first.fadeIn=Math.min(FIRST_FADE,(first.end-first.start)/2);
    if(last)last.fadeOut=Math.min(LAST_FADE,(last.end-last.start)/2);
    for(const m of music){m.fadeIn=Math.min(m.fadeIn,(m.end-m.start)/2);m.fadeOut=Math.min(m.fadeOut,(m.end-m.start)/2);}
  }

  // Effects: on what appears, never closer together than the style allows.
  const sfx:SfxItem[]=[];
  if(hits) {
    // The agent's hits: each peaks on its gesture. A hit whose file starts before 0 starts part way in.
    const clips=new Map(doc.clips.map(c=>[c.id,c]));
    for(const h of [...hits].sort((a,b)=>a.at-b.at)) {
      const clip=clips.get(h.clipId);
      if(!clip||h.at>=total)continue;
      const raw=h.at-h.peak,start=snap(Math.max(0,raw)),from=Math.max(0,start-raw);
      const length=floorSnap(Math.min(clip.duration-from,SFX_MAX,total-start));
      if(length<=0)continue;
      sfx.push({id:`sfx-${h.id}`,clipId:clip.id,in:from,out:from+length,start,end:start+length,owner:'agent',stage:'agent',status:'applied',
        gainDb:Math.round(Math.max(-60,Math.min(6,h.gainDb))*10)/10,reason:h.reason.slice(0,300)});
    }
  } else if(style.sfx!=='off'&&sfxClips.length) {
    type Cue={t:number;tiedTo?:string;id:string;what:string};
    const cues:Cue[]=[
      ...live(doc.tracks.graphics).map(g=>({t:g.start,tiedTo:g.id,id:g.id,what:'graphic'})),
      ...doc.markers.filter(m=>m.kind==='chapter'&&m.status!=='suggested'&&m.time>0.5).map(m=>({t:m.time,id:m.id,what:'chapter'})),
      ...(style.sfx==='punchy'?[
        ...live(doc.tracks.text).map(x=>({t:x.start,tiedTo:x.id,id:x.id,what:'text'})),
        ...live(doc.tracks['b-roll']).map(b=>({t:b.start,tiedTo:b.id,id:b.id,what:'b-roll'})),
      ]:[]),
    ].sort((a,b)=>a.t-b.t);
    let lastAt=-Infinity;
    const used={tick:0,sweep:0};
    for(const c of cues) {
      if(c.t-lastAt<SFX_GAP[style.sfx]||c.t>=total-0.2)continue;
      // A tick for what appears, a sweep for a change of scene; any file when the creator gave only one kind.
      const kind=c.what==='chapter'||c.what==='b-roll'?'sweep':'tick';
      const fitting=sfxClips.filter(x=>sfxKind(x)===kind),pool=fitting.length?fitting:sfxClips;
      const clip=pool[used[kind]%pool.length]!;
      const start=snap(Math.max(0,c.t-SFX_LEAD));
      const len=floorSnap(Math.min(clip.duration,SFX_MAX,total-start));
      if(len<=0)continue;
      sfx.push({id:`sfx-${c.id}`,clipId:clip.id,in:0,out:len,start,end:start+len,owner:'agent',stage:'audio',status:'applied',
        gainDb:SFX_GAIN[style.sfx],...(c.tiedTo?{tiedTo:c.tiedTo}:{}),reason:`${clip.name} on the ${c.what}.`});
      lastAt=c.t;used[kind]++;
    }
  }
  if(!hits&&style.sfx!=='off'&&!sfxClips.length&&(live(doc.tracks.graphics).length||doc.markers.some(m=>m.kind==='chapter')))
    notes.push('No sound effect files were chosen, so the edit has none. Add clips marked sfx to get them.');

  // Loudness: lift or lower speech to the target; music sits below it by its own level.
  const mix:Partial<MixSettings>={loudnessLufs:style.loudnessLufs};
  const speech=speechLoudness(doc);
  if(speech!==undefined)mix.speechGainDb=Math.round(Math.max(-24,Math.min(24,style.loudnessLufs-speech))*10)/10;
  return {music,sfx,mix,notes};
}
