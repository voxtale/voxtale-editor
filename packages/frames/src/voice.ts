// The voice track of a clip: level and pitch every 20 ms, measured by code
// where the file is. Two bytes a step, so a whole clip's voice crosses the
// relay as a small file; the sound itself stays put.

/** Seconds between voice steps; each looks at the 40 ms from its start. */
export const VOICE_STEP=0.02;
const FRAME=0.04;
const F0_MIN=75,F0_MAX=400;
/** A frame is voiced when it matches itself one pitch period later at least this well. */
const VOICED=0.5;

export interface VoiceFrame {
  /** Level, dBFS. */
  db:number;
  /** Pitch, Hz; 0 when unvoiced. */
  f0:number;
}

/** Level and pitch of each 20 ms step. */
export function voiceFrames(samples:Float32Array,rate:number):VoiceFrame[] {
  const n=Math.round(FRAME*rate),hop=Math.round(VOICE_STEP*rate);
  const lagMin=Math.floor(rate/F0_MAX),lagMax=Math.min(n-1,Math.ceil(rate/F0_MIN));
  const out:VoiceFrame[]=[];
  for(let a=0;a+n<=samples.length;a+=hop) {
    let energy=0;
    for(let i=a;i<a+n;i++)energy+=samples[i]!*samples[i]!;
    const db=energy>0?10*Math.log10(energy/n):-120;
    let best=0,bestLag=0;
    if(db>-70)for(let lag=lagMin;lag<=lagMax;lag++) {
      let xy=0,xx=0,yy=0;
      for(let i=a;i<a+n-lag;i++){const x=samples[i]!,y=samples[i+lag]!;xy+=x*y;xx+=x*x;yy+=y*y;}
      const r=xx>0&&yy>0?xy/Math.sqrt(xx*yy):0;
      // The shortest lag that matches: a longer one is the same pitch an octave down.
      if(r>best+0.03){best=r;bestLag=lag;}
    }
    out.push({db,f0:best>=VOICED?rate/bestLag:0});
  }
  return out;
}

const DB_FLOOR=-110,PITCH_BASE=60,PITCH_STEPS=48;

/** Two bytes a step: level to half a dB, pitch to a quarter semitone (0 = unvoiced). */
export function packVoice(frames:VoiceFrame[]):Uint8Array {
  const out=new Uint8Array(frames.length*2);
  frames.forEach((f,k)=>{
    out[k*2]=Math.max(0,Math.min(255,Math.round((f.db-DB_FLOOR)*2)));
    out[k*2+1]=f.f0>0?Math.max(1,Math.min(255,Math.round(PITCH_STEPS*Math.log2(f.f0/PITCH_BASE)))):0;
  });
  return out;
}

export function unpackVoice(bytes:Uint8Array):VoiceFrame[] {
  const out:VoiceFrame[]=[];
  for(let k=0;k+1<bytes.length;k+=2)out.push({db:bytes[k]!/2+DB_FLOOR,f0:bytes[k+1]?PITCH_BASE*2**(bytes[k+1]!/PITCH_STEPS):0});
  return out;
}
