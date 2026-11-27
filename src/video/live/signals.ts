// Cheap local signals over a whole livestream, before any model reads it:
// loud moments, chat spikes, the streamer's markers, laughter (in speech and
// in chat), YouTube's "most replayed". Each is a clue, never a filter: the
// scan still reads every window. Parsers are pure; only `loudness` runs ffmpeg.
import {ffmpegPath} from '../ffmpeg-path';
import {run} from '../media';
import type {LiveWord} from './transcribe';

export type SignalKind='sound'|'chat'|'marker'|'laugh'|'replays'|'image';
/** One clue at live second `t`; `weight` 0-1 within its kind. */
export interface Signal {t:number;kind:SignalKind;weight:number;note:string}
export interface ChatMessage {t:number;author?:string;text:string}

/** "1:23:40" (or "23:40") ↔ seconds. */
export const hms=(s:number)=>{
  const t=Math.max(0,Math.round(s)),h=Math.floor(t/3600),m=Math.floor((t%3600)/60),x=t%60;
  return `${h}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`;
};
export const seconds=(s:string)=>s.trim().split(':').reduce((a,p)=>a*60+Number(p),0);

const median=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]!:0;};
const quantile=(xs:number[],q:number)=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s[Math.min(s.length-1,Math.floor(q*s.length))]!:0;};

// ---- sound -------------------------------------------------------------------

/** RMS level (dB) per 2 s of the live's sound: 8 kHz, 16000 samples per frame. */
export async function loudness(source:string):Promise<number[]> {
  const out=await run(ffmpegPath(),['-v','error','-nostdin','-i',source,'-vn','-af',
    'aresample=8000,asetnsamples=n=16000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-']);
  return parseLoudness(out);
}
export function parseLoudness(text:string):number[] {
  const out:number[]=[];
  for(const m of text.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/g))out.push(m[1]==='-inf'?-120:Number(m[1]));
  return out;
}
/**
 * Loud moments: frames over max(median+4 dB, the 99.5th percentile), one per
 * 20 s at most. `step` = seconds per level.
 */
export function soundPeaks(levels:number[],step=2):Signal[] {
  if(levels.length<10)return [];
  const med=median(levels),bar=Math.max(med+4,quantile(levels,0.995)),top=Math.max(...levels);
  const out:Signal[]=[];
  levels.forEach((db,i)=>{
    const t=i*step;
    if(db<bar)return;
    const last=out.at(-1);
    if(last&&t-last.t<20){if(db>Number(last.note.match(/(-?[\d.]+) dB/)![1]))Object.assign(last,{t,weight:w(db),note:note(db)});return;}
    out.push({t,kind:'sound',weight:w(db),note:note(db)});
  });
  function w(db:number){return top>bar?Math.min(1,0.5+0.5*(db-bar)/(top-bar)):1;}
  function note(db:number){return `loud sound (${db.toFixed(1)} dB, typical ${med.toFixed(1)} dB)`;}
  return out;
}

// ---- chat --------------------------------------------------------------------

/**
 * Chat replay in any of the shapes we meet: YouTube `live_chat.json` (yt-dlp,
 * one action per line), Twitch (TwitchDownloader JSON `comments`), a
 * chat-downloader JSON array, or plain lines "[h:mm:ss] name: message".
 */
export function parseChat(text:string):ChatMessage[] {
  const trimmed=text.trimStart();
  if(trimmed.startsWith('{')&&!trimmed.includes('\n{')) {
    try {
      const d=JSON.parse(trimmed);
      if(Array.isArray(d.comments))return d.comments.map((c:any)=>({t:Number(c.content_offset_seconds??0),author:c.commenter?.display_name??c.commenter?.name,
        text:String(c.message?.body??c.message?.fragments?.map((f:any)=>f.text).join('')??'')})).filter((m:ChatMessage)=>m.text);
    } catch {/* not one object: try lines */}
  }
  if(trimmed.startsWith('[')) {
    try {
      const d=JSON.parse(trimmed);
      if(Array.isArray(d))return d.map((m:any)=>({t:Number(m.time_in_seconds??m.offset??m.t??0),author:m.author?.name??m.author,text:String(m.message??m.text??'')}))
        .filter((m:ChatMessage)=>m.text&&Number.isFinite(m.t));
    } catch {/* plain lines */}
  }
  const out:ChatMessage[]=[];
  for(const line of text.split('\n')) {
    if(!line.trim())continue;
    if(line.trimStart().startsWith('{')) {
      let d:any;try{d=JSON.parse(line);}catch{continue;}
      const a=d.replayChatItemAction,t=Number(a?.videoOffsetTimeMsec??0)/1000;
      for(const act of a?.actions??[]) {
        const r=act.addChatItemAction?.item?.liveChatTextMessageRenderer;
        if(r)out.push({t,author:r.authorName?.simpleText,text:(r.message?.runs??[]).map((x:any)=>x.text??x.emoji?.shortcuts?.[0]??'').join('')});
      }
      continue;
    }
    const m=line.match(/^\s*\[?(\d{1,2}(?::\d{2}){1,2})\]?\s+([^:]{1,40}):\s?(.*)$/);
    if(m)out.push({t:seconds(m[1]!),author:m[2]!.trim(),text:m[3]!});
  }
  return out.sort((a,b)=>a.t-b.t);
}

/** Messages per minute. */
export function perMinute(chat:ChatMessage[]):number[] {
  const per:number[]=[];
  for(const m of chat){const i=Math.floor(m.t/60);per[i]=(per[i]??0)+1;}
  return Array.from(per,n=>n??0);
}
/** Minutes where chat runs hot: at least 2.5× the median and 10 messages. */
export function chatPeaks(per:number[]):Signal[] {
  const med=median(per)||1,top=Math.max(1,...per);
  return per.flatMap((n,m)=>n>=Math.max(10,2.5*med)?[{t:m*60,kind:'chat' as const,weight:Math.min(1,n/top),note:`chat ×${(n/med).toFixed(1)} (${n} messages that minute)`}]:[]);
}

// ---- laughter ----------------------------------------------------------------

const CHAT_LAUGH=/\b(kekw|lul|lulw|omegalul|lmao+|lmfao|lol+|rofl|ha(ha)+|xd+|icant|pepelaugh)\b|😂|🤣|💀/i;
const SPEECH_LAUGH=/^\(?(laugh(s|ing|ter)?|ha(ha)+|haha\w*)\)?[.!?,]*$/i;

/** Laughter: the streamer (transcript tokens) and chat (emotes, "lol", 😂) per minute, peaks only. */
export function laughPeaks(words:LiveWord[],chat:ChatMessage[]=[]):Signal[] {
  const speech=new Map<number,number>(),room=new Map<number,number>();
  for(const w of words)if(SPEECH_LAUGH.test(w.text.trim())){const k=Math.floor(w.start/30)*30;speech.set(k,(speech.get(k)??0)+1);}
  for(const m of chat)if(CHAT_LAUGH.test(m.text)){const k=Math.floor(m.t/30)*30;room.set(k,(room.get(k)??0)+1);}
  const chatMed=median([...room.values()])||1;
  const out:Signal[]=[];
  for(const [t,n] of speech)if(n>=2)out.push({t,kind:'laugh',weight:Math.min(1,n/5),note:`streamer laughs (${n}× in 30 s)`});
  for(const [t,n] of room)if(n>=Math.max(5,3*chatMed))out.push({t,kind:'laugh',weight:Math.min(1,n/(6*chatMed)),note:`chat laughs (${n} in 30 s)`});
  return out.sort((a,b)=>a.t-b.t);
}

// ---- markers -----------------------------------------------------------------

/**
 * The streamer's markers: Twitch's stream markers export (CSV
 * "h:mm:ss,…,description"), a chapters JSON ([{start_time,title}] from
 * yt-dlp), or plain lines "h:mm:ss note".
 */
export function parseMarkers(text:string):Signal[] {
  const s=text.trim();
  if(s.startsWith('[')||s.startsWith('{')) {
    try {
      const d=JSON.parse(s),list=Array.isArray(d)?d:d.chapters??d.markers??[];
      return list.map((m:any)=>({t:Number(m.start_time??m.t??m.time??(typeof m.start==='string'?seconds(m.start):m.start)??0),kind:'marker' as const,weight:1,note:String(m.title??m.description??m.note??'marker')}))
        .filter((m:Signal)=>Number.isFinite(m.t));
    } catch {/* lines */}
  }
  return s.split('\n').flatMap(line=>{
    const m=line.match(/^\s*(\d{1,2}(?::\d{2}){1,2})\s*[,;\t ]\s*(.*)$/);
    return m?[{t:seconds(m[1]!),kind:'marker' as const,weight:1,note:(m[2]!.split(',').filter(Boolean).at(-1)??'marker').trim()||'marker'}]:[];
  });
}

// ---- replays -----------------------------------------------------------------

/** YouTube "most replayed" (yt-dlp `heatmap`): slices at 0.6 or more, the first skipped (always high). */
export function replayPeaks(heatmap:{start_time:number;end_time:number;value:number}[]):Signal[] {
  return heatmap.filter((h,i)=>i>0&&h.value>=0.6).map(h=>({t:h.start_time,kind:'replays' as const,weight:h.value,note:`most replayed part (${Math.round(h.value*100)}%) until ${hms(h.end_time)}`}));
}

/** Lines of "▲ kind: note" hints for the scan text. */
export function hintLines(signals:Signal[]):{t:number;text:string}[] {
  return signals.map(s=>({t:s.t,text:`▲ ${s.kind}: ${s.note}`}));
}
