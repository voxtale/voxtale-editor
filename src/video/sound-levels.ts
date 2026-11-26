// Cutting by sound level: the clip's level every 10 ms (FrameHost.levels)
// places cuts in quiet spots, and "clean by level" shortens pauses and drops
// hesitations with each cut set on the real sound. No model.
// Word times are rough (the end often takes in the pause after it): the level says where the sound is.
import {LEVEL_STEP,unpackLevels} from '@voxtale/frames';

type Word={text:string;start:number;end:number};
type ClipLike={source:string;in:number;out:number};

/** A clip's level in dB, one value every `step` seconds. */
export type Levels={step:number;db:number[]};
export const levelsOf=(bytes:Uint8Array):Levels=>({step:LEVEL_STEP,db:unpackLevels(bytes)});

export type CleanOptions={
  /** Pause kept between phrases, seconds. */
  pause:number;
  /** Drop hesitations (um, uh, erm). */
  fillers:boolean;
  /** Extra words to drop (retakes, false starts), by index in the clip's words. */
  drop?:(source:string,word:number)=>boolean;
  /** Only the chosen words: other pauses stay as they are. */
  only?:boolean;
};
/** tight: no silence there, the cut sits in the sound's trough. */
export type Cut={source:string;a:number;b:number;reason:'pause'|'hesitation'|'chosen';tight?:boolean};

const PAD_IN=0.03; // before the first sound: a "p" or "t" starts soft
const PAD_OUT=0.015; // after the last sound
const MIN_CUT=0.06; // shorter cuts are not worth the join
const LOOK=0.15; // how far to look for a word's real start or end
const GAP=0.1; // a real silence between words (longer than a consonant going quiet inside a word)
const LONG=0.3; // a silence inside a word: the transcript stretched the word over a pause
const VOICE_DB=20; // a part of this word this far under its voice: a breath, a mouth noise
// Outside the word (past EDGE before its start or after its end), a sound BREATH_DB or more under the clip's voice is a breath or
// room noise, not the word's end or start: the pause that holds it gets shorter.
const BREATH_DB=25;
const EDGE=0.05;

/** Hesitations: um, uh, erm, hmm, mm, euh, heu (repeated letters too). Not "ah" or "well": often meant. */
export const isFiller=(text:string)=>
  /^(h?e+u+h*|h+u+m+|h+m+|m+h*|u+m+|u+h+|e+r+m*)$/.test(text.toLowerCase().replace(/[^\p{L}]/gu,''));

const spans=new WeakMap<number[],{floor:number;voice:number}>();
/** Room noise and voice of a clip (10th and 95th percentiles, dB), measured once per clip. */
export function span(db:number[]) {
  let s=spans.get(db);
  if(!s) {
    const sorted=[...db].sort((x,y)=>x-y);
    const q=(p:number)=>sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]??-100;
    spans.set(db,(s={floor:q(0.1),voice:q(0.95)}));
  }
  return s;
}

/**
 * Line between silence and sound: a quarter of the way from room noise to voice, at least 6 dB over the noise, and never more than
 * 40 dB under the voice (on denoised sound the line fell 52 dB under the voice and every breath counted as speech).
 */
export function threshold(db:number[]):number {
  const {floor,voice}=span(db);
  return Math.max(floor+Math.max(6,(voice-floor)*0.25),voice-40);
}

/** The quietest point in [a,b]: where to cut two words that run together with no silence between. */
export function quietest(lv:Levels,a:number,b:number):number {
  const idx=(t:number)=>Math.round(t/lv.step);
  let best=idx(a);
  for(let i=idx(a);i<=idx(b);i++)if((lv.db[i]??0)<(lv.db[best]??0))best=i;
  return best*lv.step;
}

/** The cuts to make in these clips. Nothing is cut inside a kept word. */
export function findCuts(clips:ClipLike[],words:Record<string,Word[]>,levels:Record<string,Levels>,opts:CleanOptions):Cut[] {
  const cuts:Cut[]=[];
  const thr:Record<string,number>={},voiceDb:Record<string,number>={};
  for(const c of clips) {
    if(!words[c.source]?.length)continue; // a clip with no transcript (silent, cutaway): left alone, instead of cut whole
    const lv=levels[c.source];
    thr[c.source]??=lv?threshold(lv.db):0;
    voiceDb[c.source]??=lv?span(lv.db).voice:0;
    // Search by whole indices (a repeated sum of 0.01 drifts).
    const step=lv?.step??0.01;
    const idx=(t:number)=>Math.round(t/step);
    const loudAt=(i:number)=>!lv||(lv.db[i]??-100)>thr[c.source]!;
    const speechAt=(i:number)=>loudAt(i)&&(!lv||(lv.db[i]??-100)>voiceDb[c.source]!-BREATH_DB);
    /**
     * A word's real start or end: within EDGE of its own time any sound counts, past that only voice. A voice still on at the search
     * edge carries the word on until it fades (up to `limit`, the next word): the transcript sometimes ends a word 0.3 s early.
     */
    const wordStart=(w:Word,lo:number,limit:number)=>{
      for(let i=idx(lo);i<idx(w.end);i++) {
        if(!(i*step>=w.start-EDGE?loudAt(i):speechAt(i)))continue;
        if(i===idx(lo))while(i>idx(limit)&&speechAt(i-1))i--;
        return i*step;
      }
      return null;
    };
    const wordEnd=(w:Word,hi:number,limit:number)=>{
      for(let i=idx(hi)-1;i>=idx(w.start);i--) {
        if(!((i+1)*step<=w.end+EDGE?loudAt(i):speechAt(i)))continue;
        if(i===idx(hi)-1)while(i+1<idx(limit)&&speechAt(i+1))i++;
        return (i+1)*step;
      }
      return null;
    };
    const firstLoud=(a:number,b:number)=>{for(let i=idx(a);i<idx(b);i++)if(loudAt(i))return i*step;return null;};
    const lastLoud=(a:number,b:number)=>{for(let i=idx(b)-1;i>=idx(a);i--)if(loudAt(i))return (i+1)*step;return null;};
    const trough=(a:number,b:number)=>lv?quietest(lv,a,b):idx(a)*step;
    /** The last (or first) silence of at least GAP between a and b, with sound on both sides: [start,end]. */
    const gapIn=(a:number,b:number,last:boolean):[number,number]|null=>{
      if(!lv)return null;
      let found:[number,number]|null=null,from:number|null=null;
      for(let i=idx(a);i<idx(b);i++) {
        if(!loudAt(i)){from??=i;continue;}
        if(from!==null&&from>idx(a)&&(i-from)*step>=GAP){found=[from*step,i*step];if(!last)return found;}
        from=null;
      }
      return found;
    };
    /**
     * The sound of a kept word between a and b, without the long silences the transcript leaves in it (it often stretches a
     * sentence's last word over the whole pause after it). Each run of sound split by a silence of LONG or more counts apart.
     */
    const voiced=(a:number,b:number,w:Word,tightA:boolean,tightB:boolean):[number,number][]=>{
      // Only the word: after its end the sound is the next word's.
      const lim=Math.min(b,Math.max(a,w.end));
      const runs:[number,number][]=[];
      for(let i=idx(a);i<idx(lim)&&lv;i++) {
        if(!loudAt(i))continue;
        const r=runs.at(-1);
        if(r&&i*step-r[1]<LONG)r[1]=(i+1)*step;
        else runs.push([i*step,(i+1)*step]);
      }
      // A breath or mouth noise in the pause (VOICE_DB or more under the word's voice) is not speech.
      const peak=([x,y]:[number,number])=>Math.max(...lv!.db.slice(idx(x),idx(y)));
      // Part of a word begun before this clip: its voice is not here, so compare with the clip's voice.
      const started=w.start<c.in-LOOK;
      const voice=Math.max(...runs.map(peak),started?voiceDb[c.source]!:-Infinity);
      const kept=runs.filter(r=>r[1]-r[0]>=0.08&&peak(r)>=voice-VOICE_DB);
      // Nothing in the word's window comes near the clip's voice (30 dB under), or it is such a part: the word is said elsewhere.
      if(!kept.length){if(lv&&(started||!(peak([a,b])>=voiceDb[c.source]!-30)))return [];kept.push([a,b]);}
      if(kept.at(-1)![1]>=lim-LONG)kept.at(-1)![1]=b; // the last run goes to the end of the sound
      // A breath just before the voice (sound from silence, GAP or more apart from the voice, VOICE_DB under) is not speech: the
      // transcript often dates the word on that breath.
      const from=(i:number)=>{while(loudAt(i-1))i--;return i*step;};
      const breath=(g:[number,number]|null)=>!tightA&&!!g&&peak([from(idx(kept[0]![0])),g[0]])<peak(kept[0]!)-VOICE_DB;
      for(let g=gapIn(kept[0]![0],kept[0]![1],false);breath(g);g=gapIn(kept[0]![0],kept[0]![1],false))kept[0]![0]=g![1];
      // A word dated a little after its voice stays heard where the transcript puts it (captions): a few hundredths more air.
      kept.at(-1)![1]=Math.max(kept.at(-1)![1],Math.min(b,w.start+Math.min(0.16,(w.end-w.start)/2+0.01)));
      if(tightA)kept[0]![0]=a; // a border in the sound's trough, next to a dropped word: it stays
      if(tightB)kept.at(-1)![1]=b;
      return kept;
    };

    // What is said in the clip, set on the sound: kept words (and, when hesitations stay, any sound with no word).
    // A word across the clip's edge belongs to it: the part heard can be dropped.
    const inClip=(words[c.source]??[]).map((w,i)=>({...w,i})).filter(w=>w.end>c.in&&w.start<c.out);
    const chosen=(w:{i:number})=>!!opts.drop?.(c.source,w.i);
    const removed=(w:(typeof inClip)[number])=>(opts.fillers&&isFiller(w.text))||chosen(w);
    const units:{a:number;b:number;tightA?:boolean;tightB?:boolean}[]=[];
    inClip.forEach((w,k)=>{
      if(removed(w))return;
      // The real start and end are looked for around the word, never into a dropped neighbour: its sound is not this word's.
      const before=inClip[k-1],after=inClip[k+1];
      const lo=Math.max(c.in,w.start-LOOK,before&&removed(before)?Math.min(before.end,w.start):-Infinity);
      const hi=Math.min(c.out,w.end+LOOK,after&&removed(after)?Math.max(after.start,w.end):Infinity);
      // No silence between the dropped word and this one: the border is the trough between them, no pad.
      // A silence shorter than the pads counts as none: else the pad kept before the word came off the dropped word's end.
      const SHORT=PAD_IN+PAD_OUT;
      const shortBefore=()=>{const on=firstLoud(lo,w.end),end=on===null?null:lastLoud(Math.max(c.in,before!.start),on);return on!==null&&end!==null&&on-end<SHORT;};
      const shortAfter=()=>{const off=lastLoud(w.start,hi),next=off===null?null:firstLoud(off,Math.min(c.out,after!.end));return off!==null&&next!==null&&next-off<SHORT;};
      let tightA=!!before&&removed(before)&&lo>c.in&&lo<w.start+0.05&&(loudAt(idx(lo))||shortBefore());
      let tightB=!!after&&removed(after)&&hi<c.out&&hi>w.end-0.05&&(loudAt(idx(hi)-1)||shortAfter());
      // The transcript often glues two words (one's end = the other's start) when a silence splits them earlier: the kept word
      // stops at that silence. Same at the clip's edge, on an edit already cut.
      const edgeA=!before&&w.start<c.in+0.05&&loudAt(idx(c.in));
      const edgeB=!after&&w.end>c.out-0.05&&loudAt(idx(c.out)-1);
      const mid=(w.start+w.end)/2;
      const gA=tightA||edgeA?gapIn(lo,w.end,false):null,gB=tightB||edgeB?gapIn(w.start,hi,true):null;
      const gapA=gA&&gA[0]<=mid?gA:null,gapB=gB&&gB[1]>=mid?gB:null; // in the half of the word next to the dropped one
      if(gapA)tightA=false;
      if(gapB)tightB=false;
      const a=Math.max(c.in,gapA?gapA[1]:tightA?trough(lo,w.start+0.05):wordStart(w,lo,before&&!removed(before)?Math.max(lo-1,before.end):lo)??w.start);
      const b=Math.min(c.out,gapB?gapB[0]:tightB?trough(Math.max(a,w.end-0.05),hi):wordEnd(w,hi,after&&!removed(after)?Math.min(hi+1,after.start):!after?Math.min(c.out,hi+1):hi)??w.end);
      const parts=voiced(a,Math.max(a,b),w,tightA,tightB);
      parts.forEach(([x,y],k)=>units.push({a:x,b:y,tightA:k===0&&tightA,tightB:k===parts.length-1&&tightB}));
    });
    if(!opts.fillers&&lv) {
      // A sound with no transcribed word (often an "um" the transcript leaves out): kept like speech.
      let start:number|null=null;
      for(let i=idx(c.in);i<=idx(c.out);i++) {
        const t=i*step;
        const on=i<idx(c.out)&&loudAt(i);
        if(on&&start===null)start=t;
        if(!on&&start!==null) {
          const overlaps=(a:number,b:number)=>a<t&&start!<b;
          if(t-start>=0.08&&!units.some(u=>overlaps(u.a,u.b))&&!inClip.some(w=>chosen(w)&&overlaps(w.start,w.end)))units.push({a:start,b:t});
          start=null;
        }
      }
    }
    units.sort((x,y)=>x.a-y.a);

    // Each silence between two bits of speech (and at the clip's start and end) comes down to the pause wanted.
    const keepAfter=Math.max(PAD_OUT,opts.pause*0.4);
    const keepBefore=Math.max(PAD_IN,opts.pause*0.6); // a bit more air before speaking again: sounds natural
    let prev=c.in-keepAfter; // the clip's start counts as an end of speech (no extra air)
    let prevTight=false;
    const removedIn=(a:number,b:number,pick:(w:(typeof inClip)[number])=>boolean)=>inClip.some(w=>pick(w)&&w.start<b&&w.end>a);
    for(const u of [...units,{a:c.out+keepBefore,b:c.out+keepBefore}]) {
      if(u.a<=prev){prev=Math.max(prev,u.b);prevTight=!!u.tightB;continue;}
      let a=Math.max(c.in,prev+keepAfter),b=Math.min(c.out,u.a-keepBefore);
      const hasChosen=removedIn(prev,u.a,chosen);
      if(opts.only&&!hasChosen){prev=u.b;prevTight=!!u.tightB;continue;}
      const hasFiller=opts.fillers&&removedIn(prev,u.a,w=>isFiller(w.text));
      // Dropped words' sound goes whole: the air kept each side stops at their sound (smallest pads when needed).
      const gone=inClip.filter(w=>removed(w)&&w.start<u.a&&w.end>prev);
      if(gone.length) {
        const s0=Math.min(...gone.map(w=>firstLoud(Math.max(c.in,prev,w.start-LOOK),w.end)??w.start));
        const s1=Math.max(...gone.map(w=>lastLoud(w.start,Math.min(c.out,u.a,w.end+LOOK))??w.end));
        a=Math.max(c.in,prev+(prevTight?0:PAD_OUT),Math.min(a,s0-PAD_IN));
        b=Math.min(c.out,u.a-('tightA' in u&&u.tightA?0:PAD_IN),Math.max(b,s1+PAD_OUT));
      }
      const tight=!!gone.length&&(prevTight||('tightA' in u&&!!u.tightA));
      if(b-a>=MIN_CUT||(b>a&&gone.length))cuts.push({source:c.source,a:round(a),b:round(b),reason:hasChosen?'chosen':hasFiller?'hesitation':'pause',...(tight&&{tight})});
      prev=u.b;
      prevTight='tightB' in u&&!!u.tightB;
    }
  }
  return cuts;
}

const round=(t:number)=>Math.round(t*1000)/1000;

/** [a,b] minus the cuts: what plays. Pieces shorter than `min` go. */
export function keptSpans(a:number,b:number,cuts:{a:number;b:number}[],min=0.05):[number,number][] {
  let out:[number,number][]=[[a,b]];
  for(const c of cuts)out=out.flatMap(([x,y]):[number,number][]=>c.b<=x||c.a>=y?[[x,y]]:[...(c.a>x?[[x,c.a] as [number,number]]:[]),...(c.b<y?[[c.b,y] as [number,number]]:[])]);
  return out.filter(([x,y])=>y-x>=min);
}
