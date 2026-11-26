// What the sound says beyond the words, by code from a clip's voice track
// (level and pitch every 20 ms): which words the speaker stresses, where a
// line was said again and how each take sounds, and what a viewer hears
// across a join. Describes; the editor decides.
import {VOICE_STEP,unpackVoice} from '@voxtale/frames';
import {deliveryOfVoice,syllables,type Delivery} from './delivery';

export interface Voice {db:Float32Array;f0:Float32Array}
export interface VoiceWord {id:number;text:string;start:number;end:number}

export function voiceOf(bytes:Uint8Array):Voice {
  const fs=unpackVoice(bytes);
  return {db:Float32Array.from(fs,f=>f.db),f0:Float32Array.from(fs,f=>f.f0)};
}

const at=(t:number)=>Math.max(0,Math.round(t/VOICE_STEP));
const pct=(xs:number[],p:number)=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(s.length*p))]!;};
const semis=(a:number,b:number)=>12*Math.log2(a/b);
const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9']/g,'');

function span(v:Voice,start:number,end:number):{db:number[];f0:number[]} {
  const a=at(start),b=Math.min(v.db.length,Math.max(a+1,at(end)));
  const db:number[]=[],f0:number[]=[];
  for(let k=a;k<b;k++){db.push(v.db[k]!);if(v.f0[k]!>0)f0.push(v.f0[k]!);}
  return {db,f0};
}

/** Stress counts from this score: about one word in eight on plain talk. */
const STRESS_MIN=1.6;
/** Words either side a word is measured against. */
const STRESS_NEAR=5;

/**
 * Words the speaker leans on: louder, higher and longer than the words around
 * them. Scored against neighbours, so a loud speaker and a quiet one both get
 * their own stresses. Returns word ids.
 */
export function stressedWords(v:Voice,words:VoiceWord[]):Set<number> {
  const m=words.map(w=>{
    const s=span(v,w.start,w.end);
    return {lvl:s.db.length?pct(s.db,0.85):-120,pitch:s.f0.length>=2?pct(s.f0,0.85):0,per:(w.end-w.start)/syllables(w.text||'a')};
  });
  const score=m.map((x,i)=>{
    if(x.lvl<-70||words[i]!.end-words[i]!.start<0.08)return 0;
    const near=m.filter((_,j)=>j!==i&&Math.abs(j-i)<=STRESS_NEAR&&Math.abs(words[j]!.start-words[i]!.start)<5&&m[j]!.lvl>-70);
    if(near.length<3)return 0;
    const lvl=pct(near.map(n=>n.lvl),0.5),per=pct(near.map(n=>n.per),0.5);
    const pitches=near.map(n=>n.pitch).filter(p=>p>0);
    const up=x.pitch>0&&pitches.length>=2?semis(x.pitch,pct(pitches,0.5)):0;
    return (x.lvl-lvl)/4+Math.max(-1,Math.min(2,up/3))+Math.max(-1,Math.min(1,Math.log2(x.per/Math.max(0.03,per))));
  });
  const out=new Set<number>();
  score.forEach((s,i)=>{
    // Short words (to, of, my) are rarely the point: they need a clearer lead.
    const need=norm(words[i]!.text).length<=3?STRESS_MIN+1:STRESS_MIN;
    if(s>=need&&s>=(score[i-1]??0)&&s>=(score[i+1]??0))out.add(words[i]!.id);
  });
  return out;
}

export interface Take {from:number;to:number;start:number;end:number;text:string;delivery?:Delivery}
export interface Retake {opening:string;takes:Take[]}

/** A line said again starts with the same words this close behind the first try. */
const RETAKE_WORDS=45,RETAKE_SECONDS=75;

/**
 * Lines the speaker said more than once: the same opening words again, soon
 * after. Each take runs to where the next begins; the last to the end of its
 * sentence. With a voice track each take carries its delivery.
 */
export function findRetakes(words:VoiceWord[],v?:Voice):Retake[] {
  const t=words.map(w=>norm(w.text));
  const same=(i:number,j:number)=>{let n=0;while(j+n<t.length&&i+n<j&&t[i+n]&&t[i+n]===t[j+n])n++;return n;};
  const pause=(j:number)=>j>0?words[j]!.start-words[j-1]!.end:9;
  // For each start, the nearest later start that opens the same way.
  const next=new Map<number,number>();
  let skip=-1;
  for(let i=0;i<t.length;i++) {
    if(i<skip)continue;
    for(let j=i+2;j<t.length&&j-i<=RETAKE_WORDS&&words[j]!.start-words[i]!.start<=RETAKE_SECONDS;j++) {
      const n=same(i,j);
      // Four words alike, or three close behind a stop: fewer, or further off, is how people talk.
      if(n>=4||(n>=3&&j-i<=12&&pause(j)>=0.5)||(n>=2&&n===j-i&&pause(j)>=0.3)){next.set(i,j);skip=i+n;break;}
    }
  }
  const groups:Retake[]=[],used=new Set<number>();
  for(const first of [...next.keys()].sort((a,b)=>a-b)) {
    if(used.has(first))continue;
    const starts=[first];
    while(next.has(starts.at(-1)!)){const j=next.get(starts.at(-1)!)!;starts.push(j);used.add(j);}
    const longest=Math.max(...starts.slice(1).map((s,k)=>s-starts[k]!));
    // The last take: to the end of its sentence, at least as long as the longest try before it.
    let end=starts.at(-1)!;
    while(end+1<words.length&&end-starts.at(-1)!<60&&!(end-starts.at(-1)!+1>=Math.min(longest,6)&&/[.?!]$/.test(words[end]!.text))&&pause(end+1)<1.5)end++;
    const takes=starts.map((s,k)=>{
      const e=k+1<starts.length?starts[k+1]!-1:end,ws=words.slice(s,e+1);
      const take:Take={from:ws[0]!.id,to:ws.at(-1)!.id,start:ws[0]!.start,end:ws.at(-1)!.end,text:ws.map(w=>w.text).join(' ')};
      if(v&&at(take.start)<v.db.length) {
        const a=at(take.start),b=Math.min(v.db.length,at(take.end));
        take.delivery=deliveryOfVoice(Array.from({length:Math.max(0,b-a)},(_,k)=>({db:v.db[a+k]!,f0:v.f0[a+k]!})),ws);
      }
      return take;
    });
    groups.push({opening:words.slice(first,first+Math.min(5,starts[1]!-first)).map(w=>w.text).join(' '),takes});
  }
  return groups;
}

const short=(s:string,n:number)=>s.length>n?`${s.slice(0,n-1)}…`:s;

/** Longest run of words checked for being said again straight after itself. */
const DOUBLE_WORDS=3;
/**
 * One to three words said again straight after themselves ("that that", "you
 * need to you need to"): a stutter or a restart, the first of the pair
 * usually cut. findRetakes misses these when they come with no pause, or are
 * one word long. On three of our talking-head transcripts all 16 such pairs
 * were stutters or restarts. Lines of text with word ids.
 */
export function saidTwice(words:VoiceWord[]):string[] {
  const t=words.map(w=>norm(w.text)),out:string[]=[];
  for(let i=0;i<t.length;i++)for(let n=1;n<=DOUBLE_WORDS&&i+2*n<=t.length;n++) {
    let same=true;
    for(let k=0;k<n&&same;k++)same=!!t[i+k]&&t[i+k]===t[i+n+k];
    if(!same)continue;
    const a=words[i]!,b=words[i+2*n-1]!;
    out.push(`[${a.id}-${b.id} ${a.start.toFixed(1)}s] "${words.slice(i,i+2*n).map(w=>w.text).join(' ')}"`);
    break;
  }
  return out;
}

/** Retake groups as text: one line per take, word ids to cut by. */
export function retakeText(groups:Retake[]):string {
  if(!groups.length)return '';
  return groups.map(g=>[`"${short(g.opening,50)}" said ${g.takes.length} times:`,...g.takes.map((t,k)=>{
    const d=t.delivery;
    const how=d?`${d.seconds}s, ${d.rate} syl/s, ${d.loudDb} dB${d.rangeSt===undefined?'':`, pitch moves ${d.rangeSt} st`}${d.endSt===undefined?'':`, ends ${d.endSt<=-1?'falling':d.endSt>=1?'rising':'level'}`}`:`${(t.end-t.start).toFixed(1)}s`;
    return `  take ${k+1} [${t.from}-${t.to} ${t.start.toFixed(1)}s] ${how}: ${short(t.text,90)}`;
  })].join('\n')).join('\n');
}

/** A word's sound reaches this far over the room before the transcript says it starts, or after it says it ends. */
const EDGE_DB=20;
/**
 * ...but the line sits no further under the voice than this. Denoised audio
 * has a near-silent room, and room + 20 dB there lets breaths count as words.
 * On our talking-head clips (90-days, asking-good-questions, ownpod-costs)
 * room + 20 sat 18-22 dB under the voice, so on plain audio this never acts.
 */
const EDGE_UNDER=26;
/**
 * Unvoiced sound (no pitch) counts as a word's own only this close to the
 * voice. Breaths on those clips are unvoiced runs 22-33 dB under it; the hiss
 * of an s or sh at a word's edge sits closer, and voiced sound always counts.
 */
const BREATH_DB=20;
/**
 * Quiet this long at the start or end of a word's transcript span is breath or
 * pause the transcript gave the word. 3-4% of word starts and 8-12% of word
 * ends on those clips have 0.1s or more; shorter quiet is a stop closure or a
 * soft edge the pads cover.
 */
const QUIET_EDGE=0.12;
/**
 * Inside a word's own span, sound this far over the room is part of the word
 * unless a gap cuts it off. Lower than EDGE_DB on purpose: the "ts" of
 * "markets" in the S1 footage is unvoiced and 26 dB under the voice, under the
 * outer line, yet runs straight on from the vowel.
 */
const INSIDE_DB=10;
/**
 * Sound inside a word's span, after a gap this long and this far under the
 * word's peak, is a noise in the pause the transcript stretched the word over.
 */
const RUN_GAP=0.2,RUN_DB=18;
/**
 * An unvoiced run at a word's start, quieter than BREATH_DB under the voice,
 * at least BREATH_MIN long and BREATH_GAP clear of what follows, is an
 * in-breath. A soft s before a stop ("spending" in S1: 0.04s, 30 dB under the
 * voice, 0.1s before the p) is shorter; an in-breath runs 0.2s and more.
 */
const BREATH_MIN=0.12,BREATH_GAP=0.06;
/**
 * A dip shorter than this, with voice on its far side, is a stop or a glottal
 * catch inside the word, not the start of it. In S1 the transcript starts "I"
 * at 84.45s; the voice starts at 84.36, dips for 0.06s, then goes on. Only
 * walking back: past a word's end, voice after a dip is the next word's
 * start, which transcripts put late.
 */
const CATCH_MAX=0.08;
/** Furthest a word edge moves out from the transcript's time, seconds. */
const EDGE_MAX=0.3;

/** The voice's own level around `t`: the loud twentieth of the 12 seconds about it. */
function voiceAt(v:Voice,t:number):number {const s=span(v,Math.max(0,t-6),t+6).db.filter(d=>d>-100);return s.length?pct(s,0.95):-120;}

interface Lines {voice:number;outer:number;inner:number}
function linesAt(v:Voice,t:number):Lines {
  const voice=voiceAt(v,t),floor=floorAt(v,t);
  return {voice,outer:Math.max(floor+EDGE_DB,voice-EDGE_UNDER),inner:Math.max(floor+INSIDE_DB,voice-EDGE_UNDER-INSIDE_DB)};
}

/** Which voice steps around `t` sound like a word outside its span: over the edge line, and pitched or close to the voice. */
function wordSound(v:Voice,t:number):(k:number)=>boolean {
  const {voice,outer}=linesAt(v,t);
  return k=>{const d=v.db[k];return d!==undefined&&d>outer&&(v.f0[k]!>0||d>=voice-BREATH_DB);};
}

/**
 * Where a word's sound really starts ('in') or ends ('out'). Transcript times
 * sit inside the sound: on real recordings a word is heard a median 0.08s
 * before its start time. Walks out from `t` while it sounds like a word, no
 * further than `limit` (the neighbouring word); breath and room tone stop it.
 *
 * `other`, the word's other end, lets the edge move inward too: an in-breath
 * or pause the transcript put at the start of the word's span is trimmed off,
 * and so are quiet noises at its end, after a gap, that the transcript
 * stretched the word over.
 */
export function wordEdge(v:Voice,t:number,side:'in'|'out',limit:number,other?:number):number {
  const heard=wordSound(v,t);
  let k=at(t);
  if(other!==undefined&&(side==='in'?other>t:other<t)) {
    const [a,b]=side==='in'?[k,Math.min(v.db.length,at(other))]:[at(other),Math.min(v.db.length,k)];
    const r=ownRuns(v,linesAt(v,t),a,b);
    if(side==='in'&&r&&(r.from-a)*VOICE_STEP>=QUIET_EDGE)return r.from*VOICE_STEP;
    if(side==='out'&&r&&(b-r.to)*VOICE_STEP>=QUIET_EDGE)return Math.max(other,r.to*VOICE_STEP);
  }
  const loud=over(v,t);
  if(side==='in') {
    const stop=Math.max(0,at(Math.max(limit,t-EDGE_MAX)));
    for(;;) {
      while(k>stop&&heard(k-1))k--;
      // A short unvoiced run touching the word is its onset (an s, f, h); a long one is breath.
      let j=k;
      while(j>stop&&loud(j-1)&&!heard(j-1))j--;
      if(j===k) {
        // Or a catch: a dip this short with voice before it is still the word.
        while(j>stop&&!loud(j-1)&&(k-j)*VOICE_STEP<CATCH_MAX)j--;
        if(j>stop&&j<k&&heard(j-1)&&v.f0[j-1]!>0){k=j;continue;}
        break;
      }
      if((k-j)*VOICE_STEP>=BREATH_MIN-1e-9||j===stop)break;
      k=j;
    }
    return Math.min(t,Math.max(limit,k*VOICE_STEP));
  }
  const stop=Math.min(v.db.length,at(Math.min(limit,t+EDGE_MAX)));
  for(;;) {
    while(k<stop&&heard(k))k++;
    let j=k;
    while(j<stop&&loud(j)&&!heard(j))j++;
    if(j===k||(j-k)*VOICE_STEP>=BREATH_MIN-1e-9||j===stop)break;
    k=j;
  }
  return Math.max(t,Math.min(limit,k*VOICE_STEP));
}

/** Steps over the outer edge line around `t`, voiced or not: anything a listener hears over the room. */
function over(v:Voice,t:number):(k:number)=>boolean {
  const {outer}=linesAt(v,t);
  return k=>{const d=v.db[k];return d!==undefined&&d>outer;};
}

/**
 * How far out from a word's heard edge the source stays quiet: the room only,
 * no breath, click or other sound: where the first such sound is, or `limit`
 * when there is none before it. A pad that stops here
 * never starts or ends a piece on half a noise.
 */
export function quietTo(v:Voice,t:number,side:'in'|'out',limit:number):number {
  const loud=over(v,t);
  let k=at(t);
  if(side==='in') {
    const stop=Math.max(0,at(limit));
    while(k>stop&&!loud(k-1))k--;
    return k>stop?Math.min(t,k*VOICE_STEP):limit;
  }
  const stop=Math.min(v.db.length,at(limit));
  while(k<stop&&!loud(k))k++;
  return k<stop?Math.max(t,k*VOICE_STEP):limit;
}

/**
 * Steps a..b of a word's span that are the word: from its first real sound
 * (past an in-breath) to the end of its last (before noises a gap cuts off).
 */
function ownRuns(v:Voice,l:Lines,a:number,b:number):{from:number;to:number}|undefined {
  const runs:{from:number;to:number;peak:number;voiced:boolean}[]=[];
  for(let k=a;k<b;k++) {
    const d=v.db[k]!;
    if(!(d>l.inner))continue;
    const r=runs.at(-1);
    if(r&&r.to===k){r.to=k+1;r.peak=Math.max(r.peak,d);r.voiced||=v.f0[k]!>0;}
    else runs.push({from:k,to:k+1,peak:d,voiced:v.f0[k]!>0});
  }
  // In-breath: unvoiced, well under the voice, clear of the sound after it.
  while(runs.length>1&&!runs[0]!.voiced&&runs[0]!.peak<l.voice-BREATH_DB&&(runs[0]!.to-runs[0]!.from)*VOICE_STEP>=BREATH_MIN-1e-9&&(runs[1]!.from-runs[0]!.to)*VOICE_STEP>=BREATH_GAP)runs.shift();
  // Merge across short gaps, then drop noises far under the word at either end.
  const merged:typeof runs=[];
  for(const r of runs) {
    const m=merged.at(-1);
    if(m&&(r.from-m.to)*VOICE_STEP<RUN_GAP){m.to=r.to;m.peak=Math.max(m.peak,r.peak);}
    else merged.push({...r});
  }
  if(!merged.length)return undefined;
  const peak=Math.max(...merged.map(r=>r.peak));
  while(merged.length>1&&merged.at(-1)!.peak<peak-RUN_DB)merged.pop();
  while(merged.length>1&&merged[0]!.peak<peak-RUN_DB)merged.shift();
  return {from:merged[0]!.from,to:merged.at(-1)!.to};
}

/** Seconds of source a..b that sound like speech, by the same test word edges use. */
export function speechIn(v:Voice,a:number,b:number):number {
  const heard=wordSound(v,(a+b)/2);
  let n=0;
  for(let k=at(a);k<Math.min(v.db.length,at(b));k++)if(heard(k))n++;
  return n*VOICE_STEP;
}

export interface JoinSide {
  /** Voice track of the clip, when measured. */
  voice?:Voice;
  /** Source second of the cut edge: the outgoing piece's out, the incoming piece's in. */
  t:number;
  /** Whether the outgoing piece ends its sentence there (outgoing side only). */
  ends?:boolean;
}

/**
 * A cut edge this far over the room's own noise lands inside a word. On real
 * talking-head sound pauses sit 0-13 dB over the room and breaths and word
 * tails up to about 20; the middle of a word sits 25-48 over.
 */
const CLIP_DB=28;
/** A step in room noise a viewer hears. */
const ROOM_DB=7;
/** A step in the voice's pitch mid-sentence that sounds spliced. */
const PITCH_ST=5;
/** A step in level that the level match at finish cannot close. */
const LEVEL_DB=8;

/** The room's own noise around `t`: the quiet tenth of the 12 seconds about it. */
function floorAt(v:Voice,t:number):number {const s=span(v,Math.max(0,t-6),t+6).db.filter(d=>d>-100);return s.length?pct(s,0.1):-120;}
const speechAt=(v:Voice,a:number,b:number)=>{
  const s=span(v,Math.max(0,a),b),peak=Math.max(-120,...s.db),loud=s.db.filter(d=>d>=peak-20);
  return {db:loud.length?10*Math.log10(loud.reduce((n,d)=>n+10**(d/10),0)/loud.length):-120,f0:s.f0.length>=5?pct(s.f0,0.5):0};
};

/** What a viewer hears go wrong across one join; empty when it sounds clean. */
export function joinSound(out:JoinSide,inc:JoinSide):string[] {
  const a=out.voice,b=inc.voice,notes:string[]=[];
  if(!a||!b)return notes;
  const fa=floorAt(a,out.t),fb=floorAt(b,inc.t);
  const edge=(v:Voice,t0:number,t1:number)=>{const s=span(v,Math.max(0,t0),t1).db;return s.length?Math.max(...s):-120;};
  const tail=edge(a,out.t-0.04,out.t),head=edge(b,inc.t,inc.t+0.04);
  if(tail>fa+CLIP_DB)notes.push(`cuts off sound at the end of the outgoing piece (${Math.round(tail-fa)} dB over the room): the last word is clipped`);
  if(head>fb+CLIP_DB)notes.push(`starts inside sound (${Math.round(head-fb)} dB over the room): the first word is clipped`);
  if(Math.abs(fa-fb)>=ROOM_DB)notes.push(`room noise steps ${fb>fa?'up':'down'} ${Math.round(Math.abs(fa-fb))} dB`);
  const sa=speechAt(a,out.t-1.5,out.t),sb=speechAt(b,inc.t,inc.t+1.5);
  if(sa.db>-70&&sb.db>-70&&Math.abs(sa.db-sb.db)>=LEVEL_DB)notes.push(`voice ${sb.db>sa.db?'louder':'quieter'} by ${Math.round(Math.abs(sa.db-sb.db))} dB`);
  if(!out.ends&&sa.f0&&sb.f0&&Math.abs(semis(sb.f0,sa.f0))>=PITCH_ST)notes.push(`mid-sentence, the voice jumps ${semis(sb.f0,sa.f0)>0?'up':'down'} ${Math.abs(semis(sb.f0,sa.f0)).toFixed(0)} semitones`);
  return notes;
}
