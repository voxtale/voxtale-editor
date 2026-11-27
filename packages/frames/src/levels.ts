// Sound level of a clip every 10 ms, measured where the file is. One byte a
// step (dB + 100), so an hour of sound crosses the relay as 360 KB.
// Mono 8 kHz, dB per 10 ms.

/** Seconds per level step. */
export const LEVEL_STEP=0.01;
/** Quietest level kept, dBFS: digital silence reads as this. */
export const LEVEL_FLOOR=-100;

/** dBFS of each 10 ms window. */
export function levelFrames(samples:Float32Array,rate:number):number[] {
  // max(-100, round(10*log10(mean square + 1e-12)))
  const per=Math.round(LEVEL_STEP*rate),out:number[]=[];
  for(let a=0;a+per<=samples.length;a+=per) {
    let sum=0;
    for(let i=a;i<a+per;i++)sum+=samples[i]!*samples[i]!;
    out.push(Math.max(LEVEL_FLOOR,Math.round(10*Math.log10(sum/per+1e-12))));
  }
  return out;
}

export const packLevels=(db:number[])=>Uint8Array.from(db,d=>Math.min(255,Math.max(0,Math.round(d-LEVEL_FLOOR))));
export const unpackLevels=(bytes:Uint8Array):number[]=>Array.from(bytes,b=>b+LEVEL_FLOOR);
