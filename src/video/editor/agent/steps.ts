// One record per tool call, for the desktop's step-by-step view: what the agent
// said before the call, the call, what came back, the images it looked at, and
// the cut as it stood after. Saved in the plan job's debug trace (../trace).
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {EditDoc} from '@voxtale/editdoc';
import {checkCut,type Job,type Segment} from './cut';
import {ff} from './look';
import type {ToolResult} from './port';

/** The cut after a step, in output seconds. */
export interface AgentStepCut {
  duration:number;
  aroll:{clipId:string;in:number;out:number;start:number;end:number;text:string}[];
  items:{kind:'b-roll'|'captions'|'text'|'graphics';id:string;start:number;end:number;label:string}[];
  problems:string[];
}

export interface AgentStep {
  n:number;
  /** ms from the run's start. */
  at:number;
  ms:number;
  tool:string;
  args:unknown;
  isError:boolean;
  /** What the agent wrote since its last call: its reasoning for this one. */
  said?:string;
  result:string;
  /** What the agent looked at, as JPEG data URLs. */
  images:string[];
  /** Set when this call changed the cut. */
  cut?:AgentStepCut;
}

export interface AgentTrace {
  runner:string;
  stop?:string;
  turns?:number;
  costUsd?:number|null;
  targetSeconds?:number;
  clips:{id:string;name:string;duration:number;role:string}[];
  steps:AgentStep[];
  finalText?:string;
}

const RESULT_MAX=8000;

export function cutOf(job:Job,doc:EditDoc,segments:Segment[]):AgentStepCut {
  const words=(clipId:string,a:number,b:number)=>(job.clips.find(c=>c.ref.id===clipId)?.words??[])
    .filter(w=>w.end>a&&w.start<b).map(w=>w.text).join(' ');
  const r=(t:number)=>Math.round(t*100)/100;
  const t=doc.tracks;
  return {
    duration:r(Math.max(0,...t['a-roll'].map(i=>i.end))),
    aroll:t['a-roll'].map(i=>({clipId:i.clipId,in:r(i.in),out:r(i.out),start:r(i.start),end:r(i.end),text:words(i.clipId,i.in,i.out).slice(0,240)})),
    items:[
      ...t.graphics.map(i=>({kind:'graphics' as const,id:i.assetId,start:r(i.start),end:r(i.end),label:i.assetId})),
      ...t.text.map(i=>({kind:'text' as const,id:i.id,start:r(i.start),end:r(i.end),label:i.text})),
      ...t['b-roll'].map(i=>({kind:'b-roll' as const,id:i.id,start:r(i.start),end:r(i.end),label:`${i.clipId} ${i.in.toFixed(1)}-${i.out.toFixed(1)}s`})),
      ...t.captions.map(i=>({kind:'captions' as const,id:i.id,start:r(i.start),end:r(i.end),label:i.text})),
    ],
    problems:checkCut(job,doc,segments,t.graphics.length).problems,
  };
}

/** Tool images as small JPEGs; a failed encode drops the image, never the step. */
async function shrink(dir:string,n:number,images:NonNullable<ToolResult['images']>):Promise<string[]> {
  const out:string[]=[];
  for(const [k,img] of images.entries()) {
    const src=join(dir,`step-${n}-${k}.${img.mime==='image/png'?'png':'jpg'}`),dst=join(dir,`step-${n}-${k}-small.jpg`);
    try {
      await writeFile(src,img.data);
      await ff(['-i',src,'-vf','scale=min(1200\\,iw):-2','-q:v','5',dst]);
      out.push(`data:image/jpeg;base64,${(await readFile(dst)).toString('base64')}`);
    } catch {/* the step keeps its text */}
  }
  return out;
}

/** Collects steps as tools run. `said` takes the agent's text as the harness streams it. */
export function stepRecorder(o:{dir:string;job:Job;doc:()=>{doc?:EditDoc;segments:Segment[]};steps:AgentStep[];now?:()=>number}) {
  const now=o.now??Date.now;
  const t0=now();
  let said:string[]=[];
  let last='',files=0;
  return {
    said(text:string){if(text.trim())said.push(text.trim());},
    async step(tool:string,args:unknown,r:ToolResult,ms:number):Promise<void> {
      const at=now()-t0-ms,text=said.join('\n\n');
      said=[];
      const {doc,segments}=o.doc();
      let cut:AgentStepCut|undefined;
      if(doc) {
        const c=cutOf(o.job,doc,segments);
        const key=JSON.stringify(c);
        if(key!==last){cut=c;last=key;}
      }
      const images=r.images?.length?await shrink(o.dir,++files,r.images):[];
      // Calls can run side by side; number them in the order they end.
      const step:AgentStep={n:o.steps.length+1,at,ms,tool,args,isError:!!r.isError,
        ...(text?{said:text}:{}),
        result:r.text.length>RESULT_MAX?`${r.text.slice(0,RESULT_MAX)}\n… (${r.text.length-RESULT_MAX} more characters)`:r.text,
        images,...(cut?{cut}:{})};
      o.steps.push(step);
    },
  };
}
