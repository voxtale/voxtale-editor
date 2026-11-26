// Harness-mode footage labels (vision-mode.ts): the agent is the vision model.
// label_footage computes a clip's moments (every visible change, timed by
// code, as the vision path does) and shows the next undescribed ones as one
// contact sheet with the words heard; save_labels keeps what the agent saw in
// .edit/moments/, where find_footage and screen_activity read it.
import {existsSync} from 'node:fs';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {z} from '../agent/port';
import type {McpTool} from '../agent/mcp-protocol';
import type {Workspace} from '../agent/tools';
import type {Job} from '../agent/cut';
import {ff} from '../agent/look';
import {understandClips} from '../agent/session';
import {clipMomentsSchema,momentSpans,sampleEvery,type ClipMoments,type MomentWord} from '../../moments';
import {LABEL_MOMENTS_TEXT} from './label-text';

/** promptVersion of moments the agent described. */
export const AGENT_LABELS='agent-labels@1';
/** Moments per sheet by default, and at most. */
const BATCH=6,BATCH_MAX=12;
/** Frame width on the sheet: two columns stay legible once the client shrinks it. */
const TILE_W=780;

export const momentsFile=(dir:string,hash:string)=>join(dir,'moments',`${hash.slice(0,16)}.json`);

/** Moments saved for this clip (any provider), or undefined. */
export async function savedMoments(dir:string,hash:string):Promise<ClipMoments|undefined> {
  const f=momentsFile(dir,hash);
  if(!existsSync(f))return undefined;
  let raw:unknown=null;
  try {raw=JSON.parse(await readFile(f,'utf8'));} catch {return undefined;}
  const m=clipMomentsSchema.safeParse(raw);
  return m.success&&m.data.clipHash===hash?m.data:undefined;
}

/** Only the described moments: what find_footage and screen_activity read. */
export function described(m:ClipMoments):ClipMoments|undefined {
  const ms=m.moments.filter(x=>x.description);
  return ms.length?{...m,moments:ms}:undefined;
}

/** Saved labels onto the job's footage clips (harness open). Returns how many clips have some. */
export async function attachLabels(dir:string,job:Job):Promise<{labelled:number;total:number}> {
  const todo=understandClips(job);
  let labelled=0;
  for(const u of todo) {
    const m=await savedMoments(dir,u.hash),d=m&&described(m);
    const clip=job.clips.find(c=>c.ref.id===u.id)!;
    if(d){clip.moments=d;labelled++;}
  }
  return {labelled,total:todo.length};
}

const said=(words:MomentWord[],a:number,b:number)=>words.filter(w=>w.start>=a&&w.start<b).map(w=>w.text).join(' ').slice(0,400);
const write=async(f:string,m:ClipMoments)=>{await mkdir(dirname(f),{recursive:true});await writeFile(f,JSON.stringify(m));};

export interface LabelToolsHost {
  /** The open edit: its .edit/ folder, workspace, and how to keep the job. */
  current():{dir:string;ws:Workspace;keep():Promise<void>}|undefined;
  /** The tool list changed (find_footage and screen_activity appear with the first labels). */
  changed():void;
}

export function labelTools(h:LabelToolsHost):McpTool[] {
  const open=()=>{const c=h.current();if(!c)throw new Error('no project open: call open or resume first');return c;};

  /** The clip's moments, computed and saved on first use (no labels yet). */
  async function momentsOf(dir:string,ws:Workspace,u:ReturnType<typeof understandClips>[number]):Promise<ClipMoments> {
    const saved=await savedMoments(dir,u.hash);
    if(saved)return saved;
    const t0=Date.now();
    const spans=await momentSpans({hash:u.hash,duration:u.duration,frames:ws.frames});
    const m=clipMomentsSchema.parse({clipHash:u.hash,provider:'agent',model:'agent',promptVersion:AGENT_LABELS,every:sampleEvery(u.duration),
      moments:spans.map((s,k)=>({id:`M${String(k+1).padStart(3,'0')}`,start:s.start,end:s.end,frame:s.frame,description:'',changed:'',onScreenText:[],subjects:[]})),
      costUsd:0,ms:Date.now()-t0});
    await write(momentsFile(dir,u.hash),m);
    return m;
  }

  return [
    {name:'label_footage',description:'Show footage to label (this server runs no vision model: you are it). Picks the next b-roll or screen clip with unlabelled moments (or the clip you name): each moment is a visible change in its picture, timed by code. Returns one contact sheet of the moments\' frames, left to right then down, with each moment\'s id, times and the words heard. Describe them and call save_labels. find_footage and screen_activity search only labelled moments.',
      input:{clip:z.string().optional().describe('clip id; default the next one with unlabelled moments'),
        count:z.number().int().min(1).max(BATCH_MAX).optional().describe(`moments on the sheet (default ${BATCH})`),
        from:z.string().regex(/^M\d{3,5}$/).optional().describe('start at this moment id, labelled or not (to relabel)')},
      run:async({clip,count,from})=>{
        const {dir,ws}=open();
        const todo=understandClips(ws.job);
        if(!todo.length)return {text:'No b-roll or screen clips in this edit: nothing to label.'};
        let u=clip?todo.find(x=>x.id===clip):undefined,m:ClipMoments|undefined;
        if(clip&&!u)return {text:`${clip} is not a b-roll or screen clip. Footage to label: ${todo.map(x=>x.id).join(', ')}`,isError:true};
        if(u)m=await momentsOf(dir,ws,u);
        else for(const x of todo) {
          const got=await momentsOf(dir,ws,x);
          if(got.moments.some(y=>!y.description)){u=x;m=got;break;}
        }
        if(!u||!m)return {text:'Every footage clip is labelled. Name a clip (and from) to relabel.'};
        const start=from?m.moments.findIndex(x=>x.id===from):-1;
        if(from&&start<0)return {text:`${u.id} has no moment ${from} (it has M001-${m.moments.at(-1)?.id}).`,isError:true};
        const pick=(start>=0?m.moments.slice(start):m.moments.filter(x=>!x.description)).slice(0,count??BATCH);
        if(!pick.length)return {text:`${u.id}: every moment is labelled.`};
        const jpegs=await ws.frames.frames(u.hash,pick.map(x=>x.frame),TILE_W).catch(()=>pick.map(()=>null));
        const shown=pick.map((x,k)=>({x,jpeg:jpegs[k]??null}));
        const sheetDir=join(dir,'looks','labels');
        await rm(sheetDir,{recursive:true,force:true});
        await mkdir(sheetDir,{recursive:true});
        const have=shown.filter(s=>s.jpeg);
        for(const [k,s] of have.entries())await writeFile(join(sheetDir,`f-${k}.jpg`),s.jpeg!);
        const cols=have.length<=1?1:have.length<=6?2:3,rows=Math.max(1,Math.ceil(have.length/cols));
        const sheet=join(sheetDir,'sheet.jpg');
        if(have.length)await ff(['-start_number','0','-i',join(sheetDir,'f-%d.jpg'),'-vf',`tile=${cols}x${rows}:padding=4:color=white`,'-frames:v','1',sheet]);
        const name=ws.job.clips.find(c=>c.ref.id===u!.id)?.ref.name??u.id;
        const left=m.moments.filter(x=>!x.description).length;
        let n=0;
        const lines=shown.map(s=>`${s.jpeg?`${++n}.`:'-'} ${s.x.id} [${s.x.start.toFixed(1)}s-${s.x.end.toFixed(1)}s] words: ${said(u!.words,s.x.start,s.x.end)||'(none)'}${s.jpeg?'':' (no frame: label from the words or skip)'}`);
        return {text:[`${u.id} "${name}": ${m.moments.length} moments, ${left} unlabelled. Sheet: ${pick[0]!.id}-${pick.at(-1)!.id}.`,LABEL_MOMENTS_TEXT,...lines].join('\n'),
          ...(have.length?{images:[{data:new Uint8Array(await readFile(sheet)),mime:'image/jpeg' as const}]}:{})};
      }},

    {name:'save_labels',description:'Keep your labels for moments label_footage showed: one entry per moment id. Relabelling a moment replaces its label. find_footage and screen_activity read them.',
      input:{clip:z.string(),
        labels:z.array(z.object({id:z.string().regex(/^M\d{3,5}$/),description:z.string().min(1).max(1000),changed:z.string().max(300).optional(),
          onScreenText:z.array(z.string().max(200)).max(8).optional(),subjects:z.array(z.string().max(120)).max(12).optional()})).min(1).max(50)},
      run:async({clip,labels})=>{
        const {dir,ws,keep}=open();
        const u=understandClips(ws.job).find(x=>x.id===clip);
        if(!u)return {text:`${clip} is not a b-roll or screen clip.`,isError:true};
        const m=await savedMoments(dir,u.hash);
        if(!m)return {text:`No moments for ${clip} yet: call label_footage first.`,isError:true};
        const had=ws.job.clips.some(c=>c.moments?.moments.length);
        const byId=new Map(m.moments.map(x=>[x.id,x]));
        const unknown:string[]=[];
        for(const l of labels as {id:string;description:string;changed?:string;onScreenText?:string[];subjects?:string[]}[]) {
          const x=byId.get(l.id);
          if(!x){unknown.push(l.id);continue;}
          Object.assign(x,{description:l.description.trim(),changed:(l.changed??'').trim(),onScreenText:l.onScreenText??[],subjects:l.subjects??[]});
        }
        // Any provider's file can take the agent's labels; a file now holding them says so.
        const out=clipMomentsSchema.parse({...m,provider:'agent',model:'agent',promptVersion:AGENT_LABELS});
        await write(momentsFile(dir,u.hash),out);
        const c=ws.job.clips.find(x=>x.ref.id===clip)!;
        const d=described(out);
        if(d)c.moments=d;else delete c.moments;
        await keep();
        if(!had&&d)h.changed();
        const left=out.moments.filter(x=>!x.description).length;
        return {text:`${clip}: saved ${labels.length-unknown.length}; ${out.moments.length-left}/${out.moments.length} moments labelled.${unknown.length?` Unknown ids (not saved): ${unknown.join(', ')}.`:''}${left?' Next: label_footage.':''}`,
          ...(unknown.length===labels.length?{isError:true}:{})};
      }},
  ];
}
