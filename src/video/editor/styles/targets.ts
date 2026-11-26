// Measured targets: the analyser's reports (one per reference video) folded
// into [min,max] ranges a style keeps, five summary lines, and the pace and
// loudness the edit's EditStyle takes from them. Pure.
import type {EditStyle} from '@voxtale/editdoc';

export type Range=[number,number];
export type Targets=Partial<Record<TargetKey,Range>>;

/** One analyser report (voxtale_native/analyse.py), plus the beat check done in TS. */
export interface Report {
  video:string;duration_s?:number;minutes_analysed?:number;
  speech?:{words?:number;words_per_min?:number;pause_after_sentence_s?:{median?:number|null};hesitations_per_min?:number};
  shots?:{cuts_per_min?:number;shot_s?:{median?:number|null;max?:number|null};first_cut_s?:number|null;
    zoom_in_per_min?:number;zoom_out_per_min?:number;zoom_scale_median?:number|null;flashes_per_min?:number;
    progressive_changes_per_min?:number;still_shots_per_min?:number;same_framing_per_min?:number;
    cuts_on_beat?:number|null;beat_confidence?:number|null;bpm?:number|null};
  captions_on_image?:{lead_s?:number|null;words_per_change?:number|null}|null;
  look?:{brightness?:number;contrast?:number;saturation?:number;warmth?:number};
  sound?:{lufs?:number|null;bed_under_voice_db?:number|null;sound_events_per_min?:number|null};
}

const num=(x:unknown):number|undefined=>typeof x==='number'&&Number.isFinite(x)?x:undefined;
const sum=(...xs:(number|undefined)[])=>xs.every(x=>x===undefined)?undefined:xs.reduce<number>((a,x)=>a+(x??0),0);

/** Each target and where it reads from a report. */
export const TARGET_KEYS={
  cuts_per_min:(r:Report)=>num(r.shots?.cuts_per_min),
  shot_s:(r:Report)=>num(r.shots?.shot_s?.median),
  shot_max_s:(r:Report)=>num(r.shots?.shot_s?.max),
  first_cut_s:(r:Report)=>num(r.shots?.first_cut_s),
  zoom_scale:(r:Report)=>num(r.shots?.zoom_scale_median),
  zooms_per_min:(r:Report)=>sum(num(r.shots?.zoom_in_per_min),num(r.shots?.zoom_out_per_min)),
  jump_cuts_per_min:(r:Report)=>num(r.shots?.same_framing_per_min),
  flashes_per_min:(r:Report)=>num(r.shots?.flashes_per_min),
  still_shots_per_min:(r:Report)=>num(r.shots?.still_shots_per_min),
  words_per_min:(r:Report)=>r.speech?.words?num(r.speech.words_per_min):undefined,
  pause_after_sentence_s:(r:Report)=>num(r.speech?.pause_after_sentence_s?.median),
  hesitations_per_min:(r:Report)=>r.speech?.words?num(r.speech.hesitations_per_min):undefined,
  music_under_voice_db:(r:Report)=>num(r.sound?.bed_under_voice_db),
  sfx_per_min:(r:Report)=>num(r.sound?.sound_events_per_min),
  lufs:(r:Report)=>num(r.sound?.lufs),
  look_brightness:(r:Report)=>num(r.look?.brightness),
  look_contrast:(r:Report)=>num(r.look?.contrast),
  look_saturation:(r:Report)=>num(r.look?.saturation),
  look_warmth:(r:Report)=>num(r.look?.warmth),
  captions_lead_s:(r:Report)=>num(r.captions_on_image?.lead_s),
  captions_words_per_change:(r:Report)=>num(r.captions_on_image?.words_per_change),
  cuts_on_beat:(r:Report)=>num(r.shots?.cuts_on_beat),
} as const;
export type TargetKey=keyof typeof TARGET_KEYS;

const round=(x:number)=>Math.abs(x)>=10?Math.round(x):Math.round(x*100)/100;

/** One range per key from the videos that measured it. One video: its value ±15%, as a guess to check. */
export function targetsOf(reports:Report[]):Targets {
  const out:Targets={};
  for(const [k,read] of Object.entries(TARGET_KEYS) as [TargetKey,(r:Report)=>number|undefined][]) {
    const xs=reports.map(read).filter((x):x is number=>x!==undefined);
    if(!xs.length)continue;
    const lo=Math.min(...xs),hi=Math.max(...xs),pad=xs.length===1?Math.abs(lo)*0.15:0;
    out[k]=[round(lo-pad),round(hi+pad)];
  }
  return out;
}

const fmt=(r:Range|undefined,unit='')=>r?(r[0]===r[1]?`${r[0]}${unit}`:`${r[0]}–${r[1]}${unit}`):undefined;

/** Five lines a person reads: pace, zooms, speech, sound, look and captions. */
export function summaryOf(t:Targets,videos:number):string[] {
  const one=videos===1?' (seen in one video)':'';
  const parts=(xs:(string|undefined|false)[])=>xs.filter(Boolean).join(', ');
  return [
    `Pace${one}: ${parts([fmt(t.cuts_per_min)&&`${fmt(t.cuts_per_min)} cuts/min`,fmt(t.shot_s)&&`shots ${fmt(t.shot_s,'s')} (median)`,fmt(t.shot_max_s)&&`longest ${fmt(t.shot_max_s,'s')}`,fmt(t.first_cut_s)&&`first cut at ${fmt(t.first_cut_s,'s')}`])||'not measured'}.`,
    `Framing: ${parts([fmt(t.zooms_per_min)&&`${fmt(t.zooms_per_min)} punch-in/out zooms/min`,fmt(t.zoom_scale)&&`at x${fmt(t.zoom_scale)}`,fmt(t.jump_cuts_per_min)&&`${fmt(t.jump_cuts_per_min)} jump cuts/min`,fmt(t.flashes_per_min)&&`${fmt(t.flashes_per_min)} flashes/min`,fmt(t.still_shots_per_min)&&`${fmt(t.still_shots_per_min)} still inserts/min`,fmt(t.cuts_on_beat)&&`${fmt(t.cuts_on_beat)} of cuts on the beat`])||'not measured'}.`,
    `Speech: ${parts([fmt(t.words_per_min)&&`${fmt(t.words_per_min)} words/min`,fmt(t.pause_after_sentence_s)&&`pause after a sentence ${fmt(t.pause_after_sentence_s,'s')}`,fmt(t.hesitations_per_min)&&`${fmt(t.hesitations_per_min)} ums/min left in`])||'no transcript given'}.`,
    `Sound: ${parts([fmt(t.lufs)&&`${fmt(t.lufs,' LUFS')}`,fmt(t.music_under_voice_db)&&`bed ${fmt(t.music_under_voice_db,' dB')} under the voice`,fmt(t.sfx_per_min)&&`${fmt(t.sfx_per_min)} sound hits/min`])||'not measured'}.`,
    `Look and captions: ${parts([fmt(t.look_brightness)&&`brightness ${fmt(t.look_brightness)}`,fmt(t.look_contrast)&&`contrast ${fmt(t.look_contrast)}`,fmt(t.look_saturation)&&`saturation ${fmt(t.look_saturation)}`,fmt(t.look_warmth)&&`warmth ${fmt(t.look_warmth)}`,fmt(t.captions_lead_s)&&`captions change ${fmt(t.captions_lead_s,'s')} from the word`,fmt(t.captions_words_per_change)&&`${fmt(t.captions_words_per_change)} words per caption`])||'not measured'}.`,
  ];
}

const mid=(r:Range)=>(r[0]+r[1])/2;
const clamp=(x:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,x));
const r1=(x:number)=>Math.round(x*10)/10;

/** The EditStyle the measured targets give: pace, zooms and loudness from the references, the rest from the base. */
export function withTargets(style:EditStyle,t:Targets):EditStyle {
  const pace={...style.pace},audio={...style.audio};
  if(t.cuts_per_min)pace.targetCutsPerMinute=r1(clamp(mid(t.cuts_per_min),0,120));
  // The tightest median shot is the floor: half of it, so a quick beat still fits.
  if(t.shot_s)pace.minShotSeconds=r1(clamp(t.shot_s[0]/2,0.2,30));
  // Sentences end on a pause this long at most; longer ones are trimmed.
  if(t.pause_after_sentence_s)pace.maxPauseSeconds=r1(clamp(t.pause_after_sentence_s[1],0.1,10));
  if(t.zooms_per_min){const z=mid(t.zooms_per_min);pace.zoomFrequency=z<0.2?'none':z<1?'low':z<3?'medium':'high';}
  if(t.lufs)audio.loudnessLufs=r1(clamp(mid(t.lufs),-30,-8));
  if(t.music_under_voice_db)audio.musicLevelDb=r1(clamp(mid(t.music_under_voice_db),-60,0));
  if(t.sfx_per_min){const s=mid(t.sfx_per_min);audio.sfx=s<0.3?'off':s<2?'subtle':'punchy';}
  return {...style,pace,audio};
}

/** Lines for rules.md's measured section. */
export function measuredLines(t:Targets,videos:string[]):string[] {
  const one=videos.length===1?' (seen in one video)':'';
  return [`From ${videos.length} reference(s): ${videos.join(', ')}. Ranges${one}; check them on the contact sheets in references/.`,'',
    ...Object.entries(t).map(([k,r])=>`- ${k}: ${fmt(r as Range)}`)];
}

const ROWS:[string,(r:Report)=>unknown][]=[
  ['Length (s)',r=>r.duration_s],['Minutes analysed',r=>r.minutes_analysed],
  ['Cuts / min',r=>r.shots?.cuts_per_min],['Median shot (s)',r=>r.shots?.shot_s?.median],['Longest shot (s)',r=>r.shots?.shot_s?.max],
  ['First cut (s)',r=>r.shots?.first_cut_s],['Zoom in / min',r=>r.shots?.zoom_in_per_min],['Zoom out / min',r=>r.shots?.zoom_out_per_min],
  ['Zoom ratio',r=>r.shots?.zoom_scale_median],['Jump cuts / min',r=>r.shots?.same_framing_per_min],['Flashes / min',r=>r.shots?.flashes_per_min],
  ['Slow changes / min',r=>r.shots?.progressive_changes_per_min],['Still inserts / min',r=>r.shots?.still_shots_per_min],
  ['Cuts on beat',r=>r.shots?.cuts_on_beat],['Beat (bpm)',r=>r.shots?.bpm],
  ['Words / min',r=>r.speech?.words_per_min],['Pause after sentence (s)',r=>r.speech?.pause_after_sentence_s?.median],['Ums / min',r=>r.speech?.hesitations_per_min],
  ['Captions lead (s)',r=>r.captions_on_image?.lead_s],['Words per caption',r=>r.captions_on_image?.words_per_change],
  ['Loudness (LUFS)',r=>r.sound?.lufs],['Bed under voice (dB)',r=>r.sound?.bed_under_voice_db],['Sound hits / min',r=>r.sound?.sound_events_per_min],
  ['Brightness',r=>r.look?.brightness],['Contrast',r=>r.look?.contrast],['Saturation',r=>r.look?.saturation],['Warmth',r=>r.look?.warmth],
];

export function reportMarkdown(usage:string,reports:Report[],t:Targets):string {
  const cell=(x:unknown)=>x===undefined||x===null?'–':String(x);
  return [`# Measured: ${usage}`,'',...summaryOf(t,reports.length).map(l=>`- ${l}`),'',
    `| Measure | ${reports.map(r=>r.video.replace(/\|/g,'/')).join(' | ')} |`,`|---|${reports.map(()=>'---').join('|')}|`,
    ...ROWS.map(([label,read])=>`| ${label} | ${reports.map(r=>cell(read(r))).join(' | ')} |`),'',
    'Orders of magnitude, measured on this machine without a model. Check them on the contact sheets (sheets/).',''].join('\n');
}

/** Share of cuts within `tol` s of a beat on the grid first + k·60/bpm. */
export function cutsOnBeat(cuts:number[],beats:{bpm:number;first:number;confidence?:number}|undefined,tol=0.12,minConfidence=0.4):number|undefined {
  if(!beats||!cuts.length||!(beats.bpm>0)||(beats.confidence??1)<minConfidence)return undefined;
  const p=60/beats.bpm;
  const on=cuts.filter(t=>{const d=((t-beats.first)%p+p)%p;return Math.min(d,p-d)<=tol;}).length;
  return Math.round(on/cuts.length*100)/100;
}
