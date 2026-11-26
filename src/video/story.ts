// Multi-clip story edit, pure parts (plan §3-4, P3): speech split into
// passages, the structure stage's plan and its checks, and assembly of the
// plan into a-roll items, brief and chapter markers. No model calls here.
import {z} from 'zod';
import {
  BEAT_ROLES,packSequence,snap,
  type ARollItem,type BriefBeat,type Fps,type Marker,type StoryBrief,storyBriefSchema,
} from '@voxtale/editdoc';

export interface SpeechWord {
  clipId:string;
  id:number;                 // transcript word id
  text:string;
  start:number;              // source seconds
  end:number;
  /** Reason when the take stage suggests cutting this word (kept, flagged for review). */
  flag?:string;
}
export interface Passage {id:string;clipId:string;words:SpeechWord[]}

const endsSentence=(w:SpeechWord)=>/[.!?]["')\]]?$/.test(w.text);

/** Kept speech of each clip split into short passages at sentence ends and pauses. */
export function buildPassages(clips:{clipId:string;words:SpeechWord[]}[],o={maxWords:40,minWords:8,pause:0.7}):Passage[] {
  const out:Passage[]=[];
  for(const c of clips) {
    let cur:SpeechWord[]=[];
    const flush=()=>{if(cur.length)out.push({id:`P${String(out.length+1).padStart(3,'0')}`,clipId:c.clipId,words:cur});cur=[];};
    for(const w of [...c.words].sort((a,b)=>a.id-b.id)) {
      const prev=cur.at(-1);
      if(prev&&(cur.length>=o.maxWords||(w.start-prev.end>o.pause&&cur.length>=3)||(endsSentence(prev)&&cur.length>=o.minWords)))flush();
      cur.push(w);
    }
    flush();
  }
  return out;
}
export const passageText=(p:Passage)=>p.words.map(w=>w.text).join(' ');
/** Spoken seconds, first word to last. */
export const passageSeconds=(p:Passage)=>Math.round((p.words.at(-1)!.end-p.words[0]!.start)*10)/10;

const pid=z.string().max(20);
export const DROP_KINDS=['retake','false-start','off-topic','setup','length'] as const;
export const structurePlanSchema=z.object({
  beats:z.array(z.object({id:z.string().trim().min(1).max(80),role:z.enum(BEAT_ROLES),title:z.string().trim().min(1).max(100),
    content:z.string().trim().min(1).max(1500),passages:z.array(pid).max(3000)}).strict()).min(1).max(40),
  dropped:z.array(z.object({passage:pid,kind:z.enum(DROP_KINDS),replacedBy:pid.nullable(),confidence:z.number().min(0).max(1),
    reason:z.string().trim().min(1).max(300)}).strict()).max(3000),
  summary:z.string().max(2000),
}).strict();
export type StructurePlan=z.infer<typeof structurePlanSchema>;
const str={type:'string'},obj=(properties:object,required:string[])=>({type:'object',properties,required,additionalProperties:false});
export const STRUCTURE_JSON=obj({
  beats:{type:'array',items:obj({id:str,role:{type:'string',enum:[...BEAT_ROLES]},title:str,content:str,passages:{type:'array',items:str}},['id','role','title','content','passages'])},
  dropped:{type:'array',items:obj({passage:str,kind:{type:'string',enum:[...DROP_KINDS]},replacedBy:{type:['string','null']},confidence:{type:'number'},reason:str},
    ['passage','kind','replacedBy','confidence','reason'])},
  summary:str,
},['beats','dropped','summary']);

/** Throws the first reason the plan cannot be assembled. */
export function checkStructure(raw:unknown,passages:Passage[]):StructurePlan {
  const plan=structurePlanSchema.parse(raw);
  const known=new Set(passages.map(p=>p.id)),used=new Set<string>(),beatIds=new Set<string>();
  for(const b of plan.beats) {
    if(beatIds.has(b.id))throw new Error(`Beat id ${b.id} is used twice`);
    beatIds.add(b.id);
    for(const p of b.passages) {
      if(!known.has(p))throw new Error(`Beat ${b.id} names unknown passage ${p}`);
      if(used.has(p))throw new Error(`Passage ${p} is used twice`);
      used.add(p);
    }
  }
  if(!used.size)throw new Error('The plan keeps no speech');
  const dropped=new Map<string,string|null>();
  for(const d of plan.dropped) {
    if(!known.has(d.passage))throw new Error(`Dropped passage ${d.passage} is unknown`);
    if(used.has(d.passage))throw new Error(`Passage ${d.passage} is both kept and dropped`);
    if(dropped.has(d.passage))throw new Error(`Passage ${d.passage} is dropped twice`);
    dropped.set(d.passage,d.replacedBy);
  }
  // A drop may point at another dropped take (P1 → P2 → P3): follow the chain
  // to the take a beat keeps. If none is kept, it is a plain drop — the model
  // slipped on a cross-reference, not on the story, so no reason to fail.
  const keeper=(id:string|null):string|null=>{
    const seen=new Set<string>();
    while(id!==null&&!used.has(id)&&!seen.has(id)){seen.add(id);id=dropped.get(id)??null;}
    return id!==null&&used.has(id)?id:null;
  };
  return {...plan,dropped:plan.dropped.map(d=>({...d,replacedBy:keeper(d.replacedBy)}))};
}

type Entry={passage:Passage;beat:number;drop?:StructurePlan['dropped'][number]};

/**
 * Viewing order: beats in order; unsure drops stay in, placed just before the
 * passage that replaces them, else after the previous passage of their clip.
 * Passages the plan forgot go back after the previous passage of their clip.
 * With a target length, "length" drops are cut whatever their confidence:
 * the creator asked for the length, and the brief lists them to restore.
 */
export function storyOrder(plan:StructurePlan,passages:Passage[],threshold:number,cutLength=false):{entries:Entry[];cut:StructurePlan['dropped'];restored:string[]} {
  const byId=new Map(passages.map(p=>[p.id,p]));
  const order=new Map(passages.map((p,i)=>[p.id,i]));
  const sure=(d:StructurePlan['dropped'][number])=>d.confidence>=threshold||(cutLength&&d.kind==='length');
  const unsure=plan.dropped.filter(d=>!sure(d));
  const cut=plan.dropped.filter(sure);
  const entries:Entry[]=[];
  plan.beats.forEach((b,beat)=>{
    for(const id of b.passages) {
      for(const d of unsure.filter(d=>d.replacedBy===id))entries.push({passage:byId.get(d.passage)!,beat,drop:d});
      entries.push({passage:byId.get(id)!,beat});
    }
  });
  const placed=()=>new Set(entries.map(e=>e.passage.id));
  const insertNatural=(p:Passage,drop?:Entry['drop'])=>{
    const i=order.get(p.id)!;
    const has=placed();
    const before=passages.slice(0,i).reverse().find(q=>q.clipId===p.clipId&&has.has(q.id));
    const after=passages.slice(i+1).find(q=>q.clipId===p.clipId&&has.has(q.id));
    const at=before?entries.findIndex(e=>e.passage.id===before.id)+1:after?entries.findIndex(e=>e.passage.id===after.id):entries.length;
    const beat=before?entries[at-1]!.beat:after?entries[at]!.beat:Math.max(0,plan.beats.length-1);
    entries.splice(at,0,{passage:p,beat,...(drop?{drop}:{})});
  };
  for(const d of unsure.filter(d=>d.replacedBy===null))insertNatural(byId.get(d.passage)!,d);
  const accounted=new Set([...placed(),...cut.map(d=>d.passage)]);
  const restored=passages.filter(p=>!accounted.has(p.id));
  for(const p of restored)insertNatural(p);
  return {entries,cut,restored:restored.map(p=>p.id)};
}

export interface ClipSpeech {duration:number;words:{id:number;start:number;end:number}[]}
export interface AssembleOptions {
  fps:Fps;
  clips:Map<string,ClipSpeech>;
  maxPause:number;               // style.pace.maxPauseSeconds
  threshold:number;
  instruction?:string;
  targetDuration?:number;
  outline?:{ref?:{sessionId:string;version:number};beats:Array<Partial<BriefBeat>&{id:string}>};
}
export interface Assembly {items:ARollItem[];brief:StoryBrief;markers:Marker[];restored:string[]}

const CUT_PAD=0.06;              // lead/tail next to cut speech: short, so the cut word stays gone
const PAUSE_PAD=0.25;            // most breath kept either side of a shortened pause

type Run={clipId:string;words:SpeechWord[];beat:number;flag?:string;confidence?:number};

/** Plan → a-roll items (packed end to end), brief and chapter markers. */
export function assembleStory(plan:StructurePlan,passages:Passage[],o:AssembleOptions):Assembly {
  const {entries,cut,restored}=storyOrder(plan,passages,o.threshold,Boolean(o.targetDuration));
  // One run per stretch of contiguous source words sharing clip, beat and flag, with no long pause.
  const runs:Run[]=[];
  let run:Run|undefined;
  for(const e of entries) for(const w of e.passage.words) {
    const flag=e.drop?`${e.drop.kind}: ${e.drop.reason}`:w.flag;
    const prev=run?.words.at(-1);
    const joins=run&&prev&&run.clipId===e.passage.clipId&&run.beat===e.beat&&run.flag===flag&&w.id===prev.id+1&&w.start-prev.end<=o.maxPause;
    if(!joins){run={clipId:e.passage.clipId,words:[],beat:e.beat,...(flag?{flag}:{}),...(e.drop?{confidence:e.drop.confidence}:{})};runs.push(run);}
    run!.words.push(w);
  }
  const frame=1/(o.fps.num/o.fps.den);
  const raw:ARollItem[]=[];
  const beatOf=new Map<string,number>();
  runs.forEach((r,i)=>{
    const speech=o.clips.get(r.clipId);
    if(!speech)throw new Error(`No transcript for clip ${r.clipId}`);
    const first=r.words[0]!,last=r.words.at(-1)!;
    const idx=new Map(speech.words.map((w,k)=>[w.id,k]));
    const before=speech.words[idx.get(first.id)!-1],after=speech.words[idx.get(last.id)!+1];
    // Next to the neighbouring run's own word (a flag or beat change), split the gap evenly.
    const touches=(other:Run|undefined,id:number)=>other?.clipId===r.clipId&&other.words.some(w=>w.id===id);
    const pad=(gap:number,neighbour:boolean)=>neighbour&&gap<=o.maxPause?gap/2:Math.max(0,Math.min(gap<=o.maxPause?CUT_PAD:Math.min(PAUSE_PAD,o.maxPause/2),gap/2));
    const lead=before?pad(Math.max(0,first.start-before.end),touches(runs[i-1],before.id)):Math.min(PAUSE_PAD,first.start);
    const tail=after?pad(Math.max(0,after.start-last.end),touches(runs[i+1],after.id)):Math.min(PAUSE_PAD,speech.duration-last.end);
    const inS=Math.max(0,first.start-lead),outS=Math.min(speech.duration,last.end+tail);
    if(outS-inS<frame)return;
    const beat=plan.beats[r.beat]!;
    const id=`a-${r.clipId}-${first.id}-${last.id}`;
    beatOf.set(id,r.beat);
    raw.push({
      id,clipId:r.clipId,in:inS,out:outS,start:0,end:0,owner:'agent',stage:'assembly',
      status:r.flag?'remove-suggested':'applied',gainDb:0,
      reason:(r.flag??`Beat: ${beat.title}`).slice(0,300),
      evidence:[{kind:'beat',ref:beat.id.slice(0,200)},{kind:'word',ref:`${r.clipId}:${first.id}`},{kind:'word',ref:`${r.clipId}:${last.id}`}],
      ...(r.confidence!==undefined?{confidence:r.confidence}:{}),
    });
  });
  if(!raw.length)throw new Error('Assembly kept no speech');
  const items=packSequence(raw,o.fps);

  const outline=new Map((o.outline?.beats??[]).map(b=>[b.id,b]));
  const beats=plan.beats.map((b,i)=>{
    const mine=items.filter(it=>beatOf.get(it.id)===i);
    const base=outline.get(b.id)??{};
    return {...base,id:b.id,role:b.role,title:b.title,content:b.content,
      durationSeconds:Math.round(mine.reduce((n,it)=>n+(it.end-it.start),0)),
      footage:mine.slice(0,40).map(it=>({clipId:it.clipId,in:it.in,out:it.out}))};
  });
  const planned=new Set(plan.beats.map(b=>b.id));
  const coverage=[...beats.filter(b=>!b.footage.length),...[...outline.values()].filter(b=>!planned.has(b.id))]
    .map(b=>({beatId:b.id.slice(0,80),kind:'no-footage' as const,note:`Nothing recorded for "${b.title??b.id}".`.slice(0,300)}));
  const byId=new Map(passages.map(p=>[p.id,p]));
  const beatOfPassage=new Map(plan.beats.flatMap(b=>b.passages.map(p=>[p,b.id] as const)));
  const dropped=cut.map(d=>{
    const p=byId.get(d.passage)!;
    return {clipId:p.clipId,in:p.words[0]!.start,out:p.words.at(-1)!.end,text:passageText(p).slice(0,400),reason:d.reason,kind:d.kind,
      ...(d.replacedBy?{replacedBy:beatOfPassage.get(d.replacedBy)!.slice(0,80)}:{})};
  });
  const fromOutline=plan.beats.some(b=>outline.has(b.id)),inferred=plan.beats.some(b=>!outline.has(b.id));
  const brief:StoryBrief=storyBriefSchema.parse({
    source:o.outline?(inferred?(fromOutline?'outline+inferred':'inferred'):'outline'):'inferred',
    ...(o.outline?.ref?{outlineRef:o.outline.ref}:{}),
    ...(o.instruction?{instruction:o.instruction.slice(0,2000)}:{}),
    ...(o.targetDuration?{targetDuration:o.targetDuration}:{}),
    beats,coverage,dropped,
  });
  // Chapters at beat starts; a beat under 10 s folds into the chapter before it.
  const chapters:Marker[]=[];
  plan.beats.forEach((b,i)=>{
    const first=items.find(it=>beatOf.get(it.id)===i);
    if(!first)return;
    const t=chapters.length?first.start:0;
    if(chapters.length&&t-chapters.at(-1)!.time<10)return;
    chapters.push({id:`ch-${b.id.replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,100)}`,time:snap(t,o.fps),kind:'chapter',title:b.title,owner:'agent',stage:'structure',status:'applied'});
  });
  const total=items.at(-1)!.end;
  while(chapters.length>1&&total-chapters.at(-1)!.time<10)chapters.pop();
  return {items,brief,markers:chapters.length>=3?chapters:[],restored};
}
