// Footage index (plan §2, cloud side). The desktop cut the clip into segments
// and grabbed stills; here a vision model labels each segment by ID. Our
// segments own time: unknown IDs are dropped, missing IDs retried once.
import {clipIndexSchema,SHOT_TYPES,CLIP_ROLES,type ClipIndex,type ClipIngest,type IndexSegment} from '@voxtale/editdoc';
import {promptText,promptStamp} from '../services/prompts';
import {INDEX_PROMPT_ID} from './prompts';

export type VisionPart={type:'text';text:string}|{type:'image';jpeg:Uint8Array};
/** One multimodal call returning parsed JSON. */
export type VisionModel=(system:string,parts:VisionPart[])=>Promise<{json:unknown;model:string;costUsd?:number}>;
export interface IndexWord {text:string;start:number;end:number}
export interface IndexClipInput {
  ingest:ClipIngest;
  words:IndexWord[];
  /** JPEG bytes of a segment's still (index into segment.stills). */
  still(segmentId:string,index:number):Promise<Uint8Array>;
  transcriptRef?:string;
}
export interface IndexOptions {batchSize?:number;concurrency?:number;progress?:(message:string)=>void}

export const INDEX_BATCH=40;

export function indexPromptVersion():string {
  const p=promptStamp()[INDEX_PROMPT_ID];
  return p?`${INDEX_PROMPT_ID}@${p.version}:${p.hash.slice(0,8)}`:INDEX_PROMPT_ID;
}

function spoken(words:IndexWord[],start:number,end:number) {
  return words.filter(w=>w.start>=start&&w.start<end).map(w=>w.text).join(' ').slice(0,4000);
}
const str=(x:unknown,max:number)=>typeof x==='string'?x.trim().slice(0,max):'';
const strs=(x:unknown,n:number,max:number)=>Array.isArray(x)?x.filter((v):v is string=>typeof v==='string'&&v.trim()!=='').slice(0,n).map(v=>v.trim().slice(0,max)):[];
const oneOf=<T extends string>(x:unknown,all:readonly T[],d:T):T=>all.includes(x as T)?x as T:d;

/** Lenient read of one model segment onto our segment. */
export function labelSegment(seg:{id:string;start:number;end:number},raw:any,words:string):IndexSegment {
  const q=raw?.quality??{};
  const must=str(raw?.mustShow,300);
  return {id:seg.id,start:seg.start,end:seg.end,description:str(raw?.description,1000),subjects:strs(raw?.subjects,20,120),
    action:str(raw?.action,300),setting:str(raw?.setting,300),shotType:oneOf(raw?.shotType,SHOT_TYPES,'other'),
    onScreenText:strs(raw?.onScreenText,10,200),
    quality:{blur:q.blur===true,exposure:oneOf(q.exposure,['ok','dark','blown'] as const,'ok'),shaky:q.shaky===true},
    usable:typeof raw?.usable==='boolean'?raw.usable:null,...(must?{mustShow:must}:{}),...(words?{words}:{})};
}
function unlabelled(seg:{id:string;start:number;end:number},words:string):IndexSegment {
  return {id:seg.id,start:seg.start,end:seg.end,description:'',subjects:[],action:'',setting:'',shotType:'other',onScreenText:[],
    quality:{blur:false,exposure:'ok',shaky:false},usable:null,...(words?{words}:{})};
}

async function pool<T,R>(items:T[],n:number,fn:(x:T)=>Promise<R>):Promise<R[]> {
  const out:R[]=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i]!);}}));
  return out;
}

/** Label every segment of one clip. Audio-only clips need no model call. */
export async function indexClip(input:IndexClipInput,model:VisionModel,o:IndexOptions={}):Promise<ClipIndex> {
  const {ingest,words}=input;
  const said=new Map(ingest.segments.map(s=>[s.id,spoken(words,s.start,s.end)]));
  const base={clipHash:ingest.hash,promptVersion:indexPromptVersion(),...(input.transcriptRef?{transcriptRef:input.transcriptRef}:{})};
  if(ingest.kind==='audio') {
    const text=words.map(w=>w.text).join(' ');
    return clipIndexSchema.parse({...base,model:'none',summary:text?text.slice(0,300):'Audio without speech.',roleGuess:ingest.role??(text?'voiceover':'music'),
      segments:ingest.segments.map(s=>({...unlabelled(s,said.get(s.id)!),usable:true})),missing:[],costUsd:0});
  }
  const system=promptText(INDEX_PROMPT_ID);
  let cost=0,used='';
  const summaries:string[]=[],roles:string[]=[];
  const labels=new Map<string,any>();
  async function call(segs:ClipIngest['segments']) {
    const parts:VisionPart[]=[];
    for(const s of segs) {
      parts.push({type:'text',text:`${s.id} [${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] words: ${said.get(s.id)||'(silence)'}`});
      for(let i=0;i<s.stills.length;i++)parts.push({type:'image',jpeg:await input.still(s.id,i)});
    }
    const r=await model(system,parts);
    cost+=r.costUsd??0;used=r.model;
    const j=r.json as any;
    if(typeof j?.summary==='string'&&j.summary.trim())summaries.push(j.summary.trim());
    if(typeof j?.roleGuess==='string')roles.push(j.roleGuess);
    const ids=new Set(segs.map(s=>s.id));
    for(const x of Array.isArray(j?.segments)?j.segments:[])if(typeof x?.id==='string'&&ids.has(x.id)&&!labels.has(x.id))labels.set(x.id,x);
  }
  const size=o.batchSize??INDEX_BATCH;
  const batches:ClipIngest['segments'][]=[];
  for(let i=0;i<ingest.segments.length;i+=size)batches.push(ingest.segments.slice(i,i+size));
  let done=0;
  await pool(batches,o.concurrency??3,async b=>{
    try{await call(b);}catch(e){o.progress?.(`Index batch failed: ${e instanceof Error?e.message:e}`);}
    o.progress?.(`Labelled ${done+=b.length}/${ingest.segments.length} segments`);
  });
  const retry=ingest.segments.filter(s=>!labels.has(s.id));
  if(retry.length) {
    o.progress?.(`Retrying ${retry.length} unlabelled segments`);
    await pool(Array.from({length:Math.ceil(retry.length/size)},(_,i)=>retry.slice(i*size,(i+1)*size)),o.concurrency??3,
      async b=>{try{await call(b);}catch(e){o.progress?.(`Index retry failed: ${e instanceof Error?e.message:e}`);}});
  }
  const segments=ingest.segments.map(s=>labels.has(s.id)?labelSegment(s,labels.get(s.id),said.get(s.id)!):unlabelled(s,said.get(s.id)!));
  const missing=segments.filter(s=>!labels.has(s.id)).map(s=>s.id);
  if(missing.length===segments.length&&segments.length)throw new Error('The model labelled no segments');
  const vote=new Map<string,number>();for(const r of roles)vote.set(r,(vote.get(r)??0)+1);
  const top=[...vote].sort((a,b)=>b[1]-a[1])[0]?.[0];
  return clipIndexSchema.parse({...base,model:used,summary:summaries.join(' ').slice(0,2000),
    roleGuess:ingest.role??oneOf(top,CLIP_ROLES,'other'),segments,missing,costUsd:Math.round(cost*1e6)/1e6});
}

export type FaceBox={x:number;y:number;w:number;h:number;eyes?:{x:number;y:number}};
/** Largest face per JPEG, or null; one call for many stills. */
export type FaceFinder=(jpegs:Uint8Array[])=>Promise<(FaceBox|null)[]>;
const FACE_BATCH=100;

/** Adds the largest face in each video segment's first still, so zooms can centre on the speaker. */
export async function locateFaces(index:ClipIndex,input:Pick<IndexClipInput,'ingest'|'still'>,find:FaceFinder):Promise<ClipIndex> {
  if(input.ingest.kind!=='video')return index;
  const faces=new Map<string,FaceBox>();
  const segs=index.segments;
  for(let i=0;i<segs.length;i+=FACE_BATCH) {
    const batch=segs.slice(i,i+FACE_BATCH);
    const found=await find(await Promise.all(batch.map(s=>input.still(s.id,0))));
    // The index keeps the box only (its schema is strict and shipped to the desktop).
    batch.forEach((s,k)=>{const f=found[k];if(f)faces.set(s.id,{x:f.x,y:f.y,w:f.w,h:f.h});});
  }
  return {...index,segments:segs.map(s=>faces.has(s.id)?{...s,face:faces.get(s.id)!}:s)};
}
