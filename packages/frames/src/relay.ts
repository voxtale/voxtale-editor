// Frame calls across machines. A cloud agent run posts a call; the creator's
// desktop, where the full files are, answers it from its own FrameHost; files
// travel by blob key. So the agent sees frames and renders graphics without a
// full file ever leaving the creator's computer.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AUDIO_MAX_SECONDS,type FrameHost,type FramePoint,type GraphicJob} from './frames';
import {MAX_FILES,MAX_REPORT} from './limits';

export type FrameCall=
  |{op:'filmstrip';clip:string;start:number;end:number}
  |{op:'joins';pairs:{a:FramePoint;b:FramePoint}[]}
  |{op:'frames';clip:string;times:number[];width:number}
  |{op:'graphic';job:GraphicJob}
  |{op:'sample';clip:string;every:number;width:number;height:number}
  |{op:'audio';clip:string;start:number;end:number}
  |{op:'voice';clip:string}
  |{op:'levels';clip:string};

export type FrameOp=FrameCall['op'];

/** The desktop's answer, before upload: files by name. */
export interface FrameAnswer {ok:boolean;error?:string;report?:string;files:Record<string,{bytes:Uint8Array;type:string}>}
/** The answer as the worker reads it: files by blob key. */
export interface FrameReply {ok:boolean;error?:string;report?:string;files:Record<string,string>}


const HASH=/^[0-9a-f]{64}$/;
const GRAPHIC_ID=/^[A-Za-z0-9_-]{1,64}$/;
const num=(x:unknown,lo:number,hi:number)=>typeof x==='number'&&Number.isFinite(x)&&x>=lo&&x<=hi;
const point=(p:unknown)=>!!p&&typeof p==='object'&&HASH.test(String((p as FramePoint).clip))&&num((p as FramePoint).t,0,86_400);

/** Why a call is not one this side will run; null when it is fine. */
export function badFrameCall(c:unknown):string|null {
  if(!c||typeof c!=='object')return 'not an object';
  const call=c as FrameCall;
  switch(call.op) {
    case 'filmstrip':
      return HASH.test(String(call.clip))&&num(call.start,0,86_400)&&num(call.end,0,86_400)?null:'bad filmstrip range';
    case 'joins':
      return Array.isArray(call.pairs)&&call.pairs.length<=60&&call.pairs.every(p=>point(p?.a)&&point(p?.b))?null:'bad joins';
    case 'frames':
      return HASH.test(String(call.clip))&&Array.isArray(call.times)&&call.times.length>=1&&call.times.length<=MAX_FILES&&
        call.times.every(t=>num(t,0,86_400))&&num(call.width,16,1920)?null:'bad frames';
    case 'graphic': {
      const j=call.job;
      return j&&GRAPHIC_ID.test(String(j.id))&&typeof j.html==='string'&&j.html.length<=200_000&&typeof j.kitCss==='string'&&j.kitCss.length<=50_000&&
        num(j.width,16,3840)&&num(j.height,16,3840)&&num(j.seconds,0.1,30)&&Array.isArray(j.stills)&&j.stills.length<=6&&
        j.stills.every(t=>num(t,0,30))&&point(j.backdrop)&&j.files===undefined?null:'bad graphic';  // files: local paths, never from a remote caller
    }
    case 'sample':
      return HASH.test(String(call.clip))&&num(call.every,0.25,60)&&num(call.width,8,256)&&num(call.height,8,256)&&Number.isInteger(call.width)&&Number.isInteger(call.height)?null:'bad sample';
    case 'audio':
      return HASH.test(String(call.clip))&&num(call.start,0,86_400)&&num(call.end,0,86_400)&&call.end>call.start&&call.end-call.start<=AUDIO_MAX_SECONDS?null:'bad audio range';
    case 'voice':
      return HASH.test(String(call.clip))?null:'bad voice';
    case 'levels':
      return HASH.test(String(call.clip))?null:'bad levels';
    default:
      return 'unknown op';
  }
}

const msg=(e:unknown)=>(e instanceof Error?e.message:String(e)).slice(0,600);

/** Runs one call on this machine's host. Never throws: a failure is {ok:false,error}. */
export async function answerFrameCall(host:FrameHost,call:FrameCall):Promise<FrameAnswer> {
  const bad=badFrameCall(call);
  if(bad)return {ok:false,error:`refused: ${bad}`,files:{}};
  try {
    switch(call.op) {
      case 'filmstrip':return {ok:true,files:{image:{bytes:await host.filmstrip(call.clip,call.start,call.end),type:'image/png'}}};
      case 'joins':return {ok:true,files:{image:{bytes:await host.joins(call.pairs),type:'image/jpeg'}}};
      case 'frames': {
        const frames=await host.frames(call.clip,call.times,call.width);
        const files:FrameAnswer['files']={};
        frames.forEach((f,k)=>{if(f)files[`f${k}`]={bytes:f,type:'image/jpeg'};});
        return {ok:true,files};
      }
      case 'sample': {
        if(!host.sample)return {ok:false,error:'this computer cannot sample clips',files:{}};
        return {ok:true,files:{pixels:{bytes:await host.sample(call.clip,call.every,call.width,call.height),type:'application/octet-stream'}}};
      }
      case 'audio': {
        if(!host.audio)return {ok:false,error:'this computer cannot read clip sound',files:{}};
        return {ok:true,files:{samples:{bytes:await host.audio(call.clip,call.start,call.end),type:'application/octet-stream'}}};
      }
      case 'voice': {
        if(!host.voice)return {ok:false,error:'this computer cannot read clip sound',files:{}};
        return {ok:true,files:{voice:{bytes:await host.voice(call.clip),type:'application/octet-stream'}}};
      }
      case 'levels': {
        if(!host.levels)return {ok:false,error:'this computer cannot read clip sound',files:{}};
        return {ok:true,files:{levels:{bytes:await host.levels(call.clip),type:'application/octet-stream'}}};
      }
      case 'graphic': {
        const r=await host.graphic(call.job);
        const report=r.report.slice(-MAX_REPORT);
        if(!r.ok||!r.webm)return {ok:false,report,files:{}};
        return {ok:true,report,files:{
          webm:{bytes:new Uint8Array(await readFile(r.webm)),type:'video/webm'},
          ...(r.sheet?{sheet:{bytes:r.sheet,type:'image/jpeg'}}:{}),
        }};
      }
    }
  } catch(e) {
    return {ok:false,error:msg(e),files:{}};
  }
}

export type FrameCallStatus='pending'|'running'|'done'|'failed';

export interface RelayPort {
  /** Posts a call for the creator's desktop; it lapses at `deadline` (epoch ms). Returns its id. */
  post(call:FrameCall,deadline:number):Promise<string>;
  /** The call's state; `reply` once answered. */
  state(id:string):Promise<{status:FrameCallStatus;reply?:FrameReply}|null>;
  bytes(key:string):Promise<Uint8Array>;
}

export interface RelayOptions {
  port:RelayPort;
  /** Where this machine keeps the graphics it gets back. */
  dir:string;
  /** How long the desktop gets to pick a call up. */
  pickupMs?:number;
  /** How long a picked-up call may take; graphics get `graphicMs`. */
  answerMs?:number;
  graphicMs?:number;
  pollMs?:number;
  now?:()=>number;
  sleep?:(ms:number)=>Promise<void>;
}

export const OFFLINE='VoxTale is not open on the creator\'s computer, so its frames cannot be read. Work from the transcript and index.';

/** A FrameHost that asks the creator's desktop. */
export function relayFrames(o:RelayOptions):FrameHost {
  const now=o.now??Date.now,sleep=o.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
  const pickupMs=o.pickupMs??45_000,answerMs=o.answerMs??90_000,graphicMs=o.graphicMs??240_000,pollMs=o.pollMs??500;
  // After one call goes unanswered, later ones wait less before giving up.
  let offline=false;
  const ask=async(call:FrameCall):Promise<FrameReply>=>{
    const pickup=offline?Math.min(15_000,pickupMs):pickupMs;
    const start=now(),total=pickup+(call.op==='graphic'?graphicMs:answerMs);
    const id=await o.port.post(call,start+total);
    for(;;) {
      const s=await o.port.state(id);
      if(!s)throw new Error('the frame call vanished');
      if(s.status==='done'||s.status==='failed') {
        offline=false;
        if(!s.reply)throw new Error('the frame call ended with no answer');
        return s.reply;
      }
      const t=now()-start;
      if(s.status==='pending'&&t>pickup) {offline=true;throw new Error(OFFLINE);}
      if(t>total)throw new Error(`the creator's computer took longer than ${Math.round(total/1000)}s to answer`);
      await sleep(pollMs);
    }
  };
  const one=async(call:FrameCall,name:string)=>{
    const r=await ask(call);
    if(!r.ok||!r.files[name])throw new Error(r.error??r.report??'the creator\'s computer could not read these frames');
    return o.port.bytes(r.files[name]!);
  };
  return {
    filmstrip:(clip,start,end)=>one({op:'filmstrip',clip,start,end},'image'),
    joins:pairs=>one({op:'joins',pairs},'image'),
    async frames(clip,times,width) {
      const r=await ask({op:'frames',clip,times,width});
      if(!r.ok)throw new Error(r.error??'the creator\'s computer could not read these frames');
      return Promise.all(times.map((_,k)=>r.files[`f${k}`]?o.port.bytes(r.files[`f${k}`]!).catch(()=>null):null));
    },
    sample:(clip,every,width,height)=>one({op:'sample',clip,every,width,height},'pixels'),
    audio:(clip,start,end)=>one({op:'audio',clip,start,end},'samples'),
    voice:clip=>one({op:'voice',clip},'voice'),
    levels:clip=>one({op:'levels',clip},'levels'),
    async graphic(job) {
      let r:FrameReply;
      try {r=await ask({op:'graphic',job});} catch(e) {return {ok:false,report:`render failed: ${msg(e)}`};}
      const report=r.report??(r.error?`render failed: ${r.error}`:'');
      if(!r.ok||!r.files.webm)return {ok:false,report:report||'render failed'};
      const dir=join(o.dir,'graphics',job.id);
      await mkdir(dir,{recursive:true});
      const webm=join(dir,'graphic.webm');
      await writeFile(webm,await o.port.bytes(r.files.webm));
      return {ok:true,report,webm,...(r.files.sheet?{sheet:await o.port.bytes(r.files.sheet)}:{})};
    },
  };
}
