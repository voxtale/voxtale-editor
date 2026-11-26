// Delivery measures: numbers read from the sound of a line.
import {describe,expect,test} from 'bun:test';
import {AUDIO_RATE,answerFrameCall,badFrameCall,type FrameHost} from '@voxtale/frames';

import {deliveryOf,deliveryTable,syllables,voiceFrames} from '../src/video/delivery';

/** A voice-like tone: a fundamental with two overtones, gliding from f0 to f1. */
function tone(seconds:number,f0:number,f1:number,amp=0.3):Float32Array {
  const n=Math.round(seconds*AUDIO_RATE),out=new Float32Array(n);
  let ph=0;
  for(let i=0;i<n;i++) {
    ph+=2*Math.PI*(f0+(f1-f0)*i/n)/AUDIO_RATE;
    out[i]=amp*(Math.sin(ph)+0.5*Math.sin(2*ph)+0.25*Math.sin(3*ph))/1.75;
  }
  return out;
}
const words=(seconds:number)=>[{text:'this',start:0,end:seconds/2-0.1},{text:'matters',start:seconds/2,end:seconds}];

describe('delivery',()=>{
  test('syllables counts vowel groups',()=>{
    expect(['cat','matters','editor','make','the','2024'].map(syllables)).toEqual([1,2,3,1,1,1]);
  });
  test('pitch of a steady tone, and silence is unvoiced',()=>{
    const f=voiceFrames(tone(1,150,150),AUDIO_RATE);
    expect(Math.abs(f[10]!.f0-150)).toBeLessThan(4);
    expect(voiceFrames(new Float32Array(AUDIO_RATE),AUDIO_RATE).every(x=>x.f0===0)).toBe(true);
  });
  test('a falling line ends below zero, a rising one above; a flat one moves little',()=>{
    const d=(a:number,b:number)=>deliveryOf(tone(2,a,b),AUDIO_RATE,words(2));
    const fall=d(180,120),rise=d(120,180),flat=d(150,150);
    expect(fall.endSt!).toBeLessThan(-1);
    expect(rise.endSt!).toBeGreaterThan(1);
    expect(Math.abs(flat.endSt!)).toBeLessThan(0.5);
    expect(fall.rangeSt!).toBeGreaterThan(flat.rangeSt!+2);
  });
  test('level follows loudness; rate and pause come from the words',()=>{
    const loud=deliveryOf(tone(2,150,150,0.4),AUDIO_RATE,words(2)),soft=deliveryOf(tone(2,150,150,0.1),AUDIO_RATE,words(2));
    expect(loud.loudDb-soft.loudDb).toBeCloseTo(12,0);
    expect(loud.rate).toBe(1.5);
    expect(loud.longestPause).toBe(0.1);
  });
  test('no pitch from noise or near-silence; the table still reads',()=>{
    const noise=Float32Array.from({length:AUDIO_RATE},(_,i)=>Math.sin(i*i*0.37)*0.2);
    const d=deliveryOf(noise,AUDIO_RATE,words(1));
    const table=deliveryTable([{label:'take 1',text:'this matters',d},{label:'take 2',text:'this matters',d:deliveryOf(tone(2,180,120),AUDIO_RATE,words(2))}]);
    expect(table.split('\n')).toHaveLength(6);
    expect(table).toContain('take 2');
  });
});

describe('audio frame call',()=>{
  const clip='a'.repeat(64);
  test('range is checked before it runs',()=>{
    expect(badFrameCall({op:'audio',clip,start:1,end:5})).toBeNull();
    expect(badFrameCall({op:'audio',clip,start:5,end:1})).not.toBeNull();
    expect(badFrameCall({op:'audio',clip,start:0,end:5000})).not.toBeNull();
    expect(badFrameCall({op:'audio',clip:'x',start:0,end:5})).not.toBeNull();
  });
  test('a host answers with samples; one without says so',async()=>{
    const bytes=new Uint8Array(8),base={filmstrip:async()=>bytes,joins:async()=>bytes,frames:async()=>[],graphic:async()=>({ok:false,report:''})} as unknown as FrameHost;
    const got=await answerFrameCall({...base,audio:async()=>bytes},{op:'audio',clip,start:0,end:2});
    expect(got.files.samples?.bytes).toBe(bytes);
    expect((await answerFrameCall(base,{op:'audio',clip,start:0,end:2})).ok).toBe(false);
  });
  test('the voice track of a clip travels the same way',async()=>{
    const bytes=new Uint8Array(8),base={filmstrip:async()=>bytes,joins:async()=>bytes,frames:async()=>[],graphic:async()=>({ok:false,report:''})} as unknown as FrameHost;
    expect(badFrameCall({op:'voice',clip})).toBeNull();
    expect(badFrameCall({op:'voice',clip:'x'})).not.toBeNull();
    expect((await answerFrameCall({...base,voice:async()=>bytes},{op:'voice',clip})).files.voice?.bytes).toBe(bytes);
    expect((await answerFrameCall(base,{op:'voice',clip})).ok).toBe(false);
  });
});
