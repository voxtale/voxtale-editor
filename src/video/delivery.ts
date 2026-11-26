// How a line was said, measured by code from its sound: how loud, how fast,
// how high, how much the voice moves, how it ends. Numbers for comparing
// takes of one line; they describe the delivery, they do not judge it.

import {voiceFrames,type VoiceFrame} from '@voxtale/frames';
export {voiceFrames};

export interface Delivery {
  seconds:number;
  /** Syllables per second of the words, pauses included. */
  rate:number;
  /** Mean level of the voiced parts, dBFS. */
  loudDb:number;
  /** Median pitch of the voice, Hz; undefined when too little of it is voiced. */
  pitchHz?:number;
  /** How far the pitch moves, in semitones (10th to 90th percentile): low is flat, high is lively. */
  rangeSt?:number;
  /** Pitch of the last voiced stretch against the rest, semitones: below zero falls (sounds finished), above rises. */
  endSt?:number;
  /** Longest silence between two words, seconds. */
  longestPause:number;
}

/** Frames this far under the loudest are silence. */
const GATE_DB=30;

/** Rough syllable count of a word: its vowel groups, a silent final e dropped. */
export function syllables(word:string):number {
  const w=word.toLowerCase().replace(/[^a-z]/g,'');
  if(!w)return /\d/.test(word)?1:0;
  const groups=w.replace(/e$/,'').match(/[aeiouy]+/g)?.length??0;
  return Math.max(1,groups);
}

const median=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]!;};
const semitones=(a:number,b:number)=>12*Math.log2(a/b);

/** Delivery of a line. `samples`: its sound from the first word's start; `words`: their times in the clip. */
export function deliveryOf(samples:Float32Array,rate:number,words:{text:string;start:number;end:number}[]):Delivery {
  return deliveryOfVoice(voiceFrames(samples,rate),words,samples.length/rate);
}

/** Delivery of a line from its voice frames (the steps between its first word's start and its last word's end). */
export function deliveryOfVoice(frames:VoiceFrame[],words:{text:string;start:number;end:number}[],span=frames.length*0.02):Delivery {
  const seconds=words.length?words.at(-1)!.end-words[0]!.start:span;
  const peak=frames.reduce((m,f)=>Math.max(m,f.db),-120);
  const loud=frames.filter(f=>f.db>=peak-GATE_DB);
  const loudDb=loud.length?10*Math.log10(loud.reduce((s,f)=>s+10**(f.db/10),0)/loud.length):-120;
  const voiced=loud.filter(f=>f.f0>0).map(f=>f.f0);
  let longestPause=0;
  for(let k=1;k<words.length;k++)longestPause=Math.max(longestPause,words[k]!.start-words[k-1]!.end);
  const r1=(x:number)=>Math.round(x*10)/10;
  const out:Delivery={seconds:r1(seconds),rate:r1(words.reduce((s,w)=>s+syllables(w.text),0)/Math.max(0.2,seconds)),loudDb:r1(loudDb),longestPause:Math.round(longestPause*100)/100};
  if(voiced.length>=10) {
    const s=[...voiced].sort((a,b)=>a-b),mid=median(voiced);
    out.pitchHz=Math.round(mid);
    out.rangeSt=r1(semitones(s[Math.floor(s.length*0.9)]!,s[Math.floor(s.length*0.1)]!));
    const tail=voiced.slice(-Math.max(5,Math.floor(voiced.length/5))),head=voiced.slice(0,voiced.length-tail.length);
    if(head.length>=5)out.endSt=r1(semitones(median(tail),median(head)));
  }
  return out;
}

/** One line per take, with each number set against the mean of the takes compared. */
export function deliveryTable(takes:{label:string;text:string;d:Delivery}[]):string {
  const mean=(f:(d:Delivery)=>number|undefined)=>{const xs=takes.map(t=>f(t.d)).filter((x):x is number=>x!==undefined);return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:undefined;};
  const loud=mean(d=>d.loudDb)!;
  const sign=(x:number)=>`${x>=0?'+':''}${x.toFixed(1)}`;
  return takes.map(({label,text,d})=>[
    `${label} "${text.length>70?`${text.slice(0,67)}…`:text}"`,
    `  ${d.seconds}s, ${d.rate} syllables/s, level ${d.loudDb} dB${takes.length>1?` (${sign(d.loudDb-loud)} vs the others)`:''}, longest pause ${d.longestPause}s`,
    d.pitchHz===undefined?'  pitch: too little voiced sound to measure'
      :`  pitch ${d.pitchHz} Hz, moves ${d.rangeSt} semitones${d.endSt===undefined?'':`, ends ${d.endSt<=-1?'falling':d.endSt>=1?'rising':'level'} (${sign(d.endSt)})`}`,
  ].join('\n')).join('\n');
}
