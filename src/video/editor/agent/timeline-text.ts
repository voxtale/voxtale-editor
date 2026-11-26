// The edit as text: one line per item per track (`timeline`), and where words
// are heard in the output (`find_words`). timeline_view looks at source
// footage; these read the cut itself, so the agent need not read edit.json
// whole on every touch-up or convert source times by hand.
import {docDuration,soundSpans,TRACK_KINDS,type EditDoc,type Item,type TrackKind} from '@voxtale/editdoc';
import type {Job} from './cut';

const s=(t:number)=>(Math.round(t*100)/100).toFixed(2);
const db=(g:number)=>`${g>0?'+':''}${g.toFixed(1)} dB`;
const quote=(t:string,n=60)=>`"${t.length>n?`${t.slice(0,n-1)}…`:t}"`;
const live=(i:{status?:string})=>i.status!=='suggested';

/** Words a clip item plays, in source order, that sit inside [from,to) of the source. */
function wordsIn(job:Job,clipId:string,from:number,to:number) {
  return job.clips.find(c=>c.ref.id===clipId)?.words.filter(w=>{const m=(w.start+w.end)/2;return m>=from&&m<to;})??[];
}

/** Source seconds per output second of a clip item (b-roll may run fast). */
const speedOf=(i:Item)=>('speed' in i&&i.speed)||1;

/** What one item shows and the settings that matter, on one line. */
export function itemLine(kind:TrackKind,i:Item,job:Job):string {
  const any=i as Record<string,any>;
  const name=(id:string)=>job.clips.find(c=>c.ref.id===id)?.ref.name;
  let what:string;
  if('clipId' in i) {
    const n=name(i.clipId);
    what=`${i.clipId}${n?` ${quote(n,40)}`:''}`;
    if(kind==='a-roll'||kind==='voiceover') {
      const w=wordsIn(job,i.clipId,i.in,i.out);
      if(w.length)what+=` ${quote(w.map(x=>x.text).join(' '),50)} (words ${w[0]!.id}-${w.at(-1)!.id})`;
    }
  } else if(kind==='captions'||kind==='text')what=`${kind==='text'?`${any.template} `:''}${quote(String(any.text))}`;
  else if(kind==='graphics')what=`graphic ${any.assetId} ${any.placement}`;
  else if(kind==='zoom')what=`zoom ${any.scale}x ${any.target}`;
  else what=kind;
  const extra=[
    'clipId' in i&&`in ${s(i.in)}`,
    speedOf(i)!==1&&`speed ${Math.round(speedOf(i)*100)}%`,
    any.layout&&any.layout!=='camera'&&`layout ${any.layout}`,
    any.angle&&`angle ${any.angle}`,any.mic&&`mic ${any.mic}`,
    any.companions?.length&&`with ${any.companions.map((c:{clipId:string})=>c.clipId).join(', ')}`,
    any.pip&&`speaker ${any.pip}`,any.pipCorner&&`pip ${any.pipCorner}`,
    any.crop&&`crop ${['x','y','w','h'].map(k=>any.crop[k].toFixed(2)).join(' ')}`,
    any.fit==='contain'&&'contain',
    kind==='b-roll'&&any.muted===false&&'sound on',
    any.opacity!==undefined&&any.opacity<1&&`opacity ${any.opacity}`,
    any.gainDb!==undefined&&any.gainDb!==0&&(kind==='a-roll'||kind==='voiceover')&&`gain ${db(any.gainDb)}`,
    any.gainDb!==undefined&&(kind==='music'||kind==='sfx')&&db(any.gainDb),
    any.duck===false&&'no duck',
    any.transition&&`${any.transition.kind} in`,
    any.audioLead&&`J ${any.audioLead}s`,any.audioLag&&`L ${any.audioLag}s`,
    (any.fadeIn||any.fadeOut)&&kind!=='music'&&`fade ${any.fadeIn??0}/${any.fadeOut??0}s`,
    any.behindSubject&&'behind speaker',
    any.variants?.length&&`${any.variants.length+1} variants`,
    any.alternatives?.length&&`${any.alternatives.length} other shots`,
    any.tiedTo&&`tied to ${any.tiedTo}`,
    any.owner==='creator'&&'CREATOR',
    !live(any)&&'suggested',
  ].filter(Boolean);
  return `${i.id}  ${what}  ${s(i.start)} → ${s(i.end)}${extra.length?`  · ${extra.join(', ')}`:''}`;
}

/** Tracks top to bottom as the render stacks them, then sound. */
const ORDER:TrackKind[]=['captions','text','graphics','zoom','b-roll','a-roll','voiceover','music','sfx'];

/**
 * The whole edit, one line per item: canvas, length, locks, then each track
 * and its items in time order. `at`: only what sits under that output
 * second, with the source second it plays.
 */
export function timelineText(doc:EditDoc,job:Job,o:{at?:number;tracks?:TrackKind[]}={}):string {
  const {at}=o,want=new Set(o.tracks??TRACK_KINDS);
  const out=[`${doc.canvas.width}x${doc.canvas.height}, ${+(doc.fps.num/doc.fps.den).toFixed(3)} fps, ${s(docDuration(doc))} s, mix ${doc.mix.loudnessLufs} LUFS`];
  const locked=Object.entries(doc.policy).filter(([,v])=>v==='locked'||v==='off').map(([k,v])=>`${k} ${v}`);
  if(locked.length)out.push(`creator locks: ${locked.join(', ')}`);
  if(at!==undefined)out.push(`under ${s(at)} s:`);
  const empty:TrackKind[]=[];
  for(const kind of ORDER.filter(k=>want.has(k))) {
    const items=(doc.tracks[kind] as Item[]).filter(i=>at===undefined||(i.start<=at&&at<i.end)).sort((a,b)=>a.start-b.start);
    if(!items.length){if(at===undefined)empty.push(kind);continue;}
    out.push(`${kind} (${items.length})`);
    for(const i of items) {
      const src=at!==undefined&&'clipId' in i?`  · at ${s(at)}: ${s(i.in+(at-i.start)*speedOf(i))} in ${i.clipId}`:'';
      out.push(`  ${itemLine(kind,i,job)}${src}`);
    }
  }
  if(empty.length)out.push(`empty: ${empty.join(', ')}`);
  const marks=doc.markers.filter(m=>at===undefined||Math.abs(m.time-at)<0.5);
  if(marks.length&&want.size===TRACK_KINDS.length)out.push('markers',...marks.map(m=>`  ${s(m.time)} ${m.kind} ${quote(m.title)}`));
  return out.join('\n');
}

/** A word heard in the output: its output span and where it sits in the source. */
export interface HeardWord {clipId:string;id:number;text:string;start:number;end:number;at:number;itemId:string}

/**
 * Every word heard in the cut, in output order: a-roll through its J/L sound
 * spans, voiceover items, and b-roll with its sound on (through its speed).
 * A word counts where its middle plays. A word in a range used twice is
 * heard twice.
 */
export function heardWords(doc:EditDoc,job:Job):HeardWord[] {
  const spans=[
    ...soundSpans(doc.tracks['a-roll'],doc.fps).map(x=>({clipId:x.item.clipId,itemId:x.item.id,start:x.start,end:x.end,in:x.in,speed:1})),
    ...doc.tracks.voiceover.filter(live).map(i=>({clipId:i.clipId,itemId:i.id,start:i.start,end:i.end,in:i.in,speed:1})),
    ...doc.tracks['b-roll'].filter(i=>live(i)&&i.muted===false).map(i=>({clipId:i.clipId,itemId:i.id,start:i.start,end:i.end,in:i.in,speed:i.speed??1})),
  ];
  const out:HeardWord[]=[];
  for(const x of spans) {
    const toOut=(src:number)=>x.start+(src-x.in)/x.speed;
    for(const w of wordsIn(job,x.clipId,x.in,x.in+(x.end-x.start)*x.speed))
      out.push({clipId:x.clipId,id:w.id,text:w.text,start:Math.max(x.start,toOut(w.start)),end:Math.min(x.end,toOut(w.end)),at:w.start,itemId:x.itemId});
  }
  return out.sort((a,b)=>a.start-b.start);
}

/** Comparable word: lower case, no accents or punctuation ("AI," = "ai"). */
const norm=(t:string)=>t.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}']+/gu,' ').trim();

/** Each place the words of `phrase` are heard in a row. One transcript word may carry several ("AI-video"). */
export function findPhrase(words:HeardWord[],phrase:string):{from:HeardWord;to:HeardWord}[] {
  const want=norm(phrase).split(' ').filter(Boolean);
  const tokens=words.flatMap((w,i)=>norm(w.text).split(' ').filter(Boolean).map(t=>({t,i})));
  const out:{from:HeardWord;to:HeardWord}[]=[];
  for(let k=0;want.length&&k+want.length<=tokens.length;k++)
    if(want.every((t,j)=>tokens[k+j]!.t===t))out.push({from:words[tokens[k]!.i]!,to:words[tokens[k+want.length-1]!.i]!});
  return out;
}

/** One line per place each phrase is heard: output span, then clip, word ids and source second. */
export function findWordsText(doc:EditDoc,job:Job,phrases:string[]):string {
  const words=heardWords(doc,job);
  return phrases.flatMap(p=>{
    const hits=findPhrase(words,p);
    if(!hits.length) {
      const inSource=job.clips.some(c=>findPhrase(c.words.map(w=>({...w,clipId:c.ref.id,at:w.start,itemId:''})),p).length);
      return [`"${p}": not heard in this cut (${inSource?'said in the source, but cut':'not in any transcript as written'})`];
    }
    return hits.map(({from,to})=>`"${p}": ${s(from.start)} → ${s(to.end)} s output · ${from.clipId} ${from.id===to.id?`word ${from.id}`:`words ${from.id}-${to.id}`} @${s(from.at)} in the source · ${from.itemId}`);
  }).join('\n');
}
