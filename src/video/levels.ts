// Speech level per kept segment, so a take recorded quieter (further from the
// mic, a later session) plays as loud as its neighbours. Measured by code from
// the sound; the gain lands on the a-roll item, where the creator can change it.

/** Seconds per measuring frame. */
const FRAME=0.04;
/** Frames this far under the loudest count as pause, not speech. */
const GATE_DB=20;
/** Most a segment is turned up or down. Further off than this is a recording fault, not a level. */
export const LEVEL_MAX_DB=6;
/** Differences under this are left: nobody hears them, and every gain is one more thing to trust. */
export const LEVEL_MIN_DB=1;
/** Quieter than this is no speech at all (a silent clip, a failed read). */
const FLOOR_DB=-70;

/** Level of the speech in mono samples, dB re full scale; pauses left out. Undefined when there is no sound. */
export function speechLevel(samples:Float32Array,rate:number):number|undefined {
  const n=Math.max(1,Math.round(FRAME*rate));
  const frames:number[]=[];
  for(let a=0;a+n<=samples.length;a+=n) {
    let e=0;
    for(let i=a;i<a+n;i++)e+=samples[i]!*samples[i]!;
    frames.push(e/n);
  }
  const peak=Math.max(0,...frames);
  if(peak<=0||10*Math.log10(peak)<FLOOR_DB)return undefined;
  const gate=peak*10**(-GATE_DB/10);
  const loud=frames.filter(p=>p>=gate);
  return Math.round(10*Math.log10(loud.reduce((s,p)=>s+p,0)/loud.length)*10)/10;
}

/**
 * Gain per segment, dB, toward the middle level of the cut (the median, so
 * one odd take does not move the rest). Unmeasured segments get 0.
 */
export function levelGains(levels:(number|undefined)[]):number[] {
  const known=levels.filter((x):x is number=>x!==undefined).sort((a,b)=>a-b);
  if(known.length<2)return levels.map(()=>0);
  const mid=known.length%2?known[(known.length-1)/2]!:(known[known.length/2-1]!+known[known.length/2]!)/2;
  return levels.map(l=>{
    if(l===undefined)return 0;
    const g=Math.max(-LEVEL_MAX_DB,Math.min(LEVEL_MAX_DB,mid-l));
    return Math.abs(g)<LEVEL_MIN_DB?0:Math.round(g*2)/2;
  });
}
