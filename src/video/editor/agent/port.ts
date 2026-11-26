// The seam between the editor and any agent harness. Tools, craft and state are
// ours; a harness only runs the loop. Swapping harness = one new adapter file.
import type {z} from 'zod/v4';
/** The zod tool inputs use (v4: JSON Schema export), for callers outside this package. */
export {z} from 'zod/v4';

/** What a tool hands back: text the model reads, plus optional images it looks at. */
export interface ToolResult {
  text:string;
  images?:{data:Uint8Array;mime:'image/png'|'image/jpeg'}[];
  isError?:boolean;
}

/** A tool in no harness's format. Adapters translate it (MCP, AI SDK, Pi …). */
export interface ToolDef<S extends z.ZodRawShape=z.ZodRawShape> {
  name:string;
  description:string;
  input:S;
  run:(args:z.infer<z.ZodObject<S>>)=>Promise<ToolResult>;
}

export interface AgentTask {
  /** Craft rules (the skill), loaded as system prompt so every harness sees the same text. */
  instructions:string;
  prompt:string;
  tools:ToolDef<any>[];
  /** Per-job folder; the only place the harness may keep files. */
  workspace:string;
  model:string;
  maxTurns:number;
  maxBudgetUsd:number;
  log?:(line:string)=>void;
  /** The agent's own words between calls, whole (log lines are cut short). */
  said?:(text:string)=>void;
  signal?:AbortSignal;
  /** The same tools as an MCP endpoint, for harnesses that run out of process (see ./mcp-http). */
  server?:{url:string;headers:Record<string,string>};
}

export interface AgentRun {
  /** Why the loop stopped, in the harness's words ("success", "error_max_turns" …). */
  stop:string;
  turns:number;
  costUsd:number|null;
  toolCalls:{name:string;ms:number;isError:boolean}[];
  finalText:string;
}

export interface AgentRunner {
  name:string;
  run(task:AgentTask):Promise<AgentRun>;
}

/** Wraps tool defs so every adapter gets the same timing and error log. */
/** `after` sees every call and its result (the debug trace's steps). */
export function instrument(tools:ToolDef<any>[],calls:AgentRun['toolCalls'],log?:(l:string)=>void,
  after?:(name:string,args:unknown,r:ToolResult,ms:number)=>Promise<void>):ToolDef<any>[] {
  return tools.map(t=>({...t,run:async(args:any)=>{
    const t0=Date.now();
    let r:ToolResult;
    try {r=await t.run(args);}
    catch(e) {r={text:`Error: ${e instanceof Error?e.message:String(e)}`,isError:true};}
    calls.push({name:t.name,ms:Date.now()-t0,isError:!!r.isError});
    log?.(`tool ${t.name} ${r.isError?'ERROR ':''}${Date.now()-t0}ms ${r.text.slice(0,160).replace(/\s+/g,' ')}`);
    await after?.(t.name,args,r,Date.now()-t0).catch(e=>log?.(`step record failed: ${String(e).slice(0,200)}`));
    return r;
  }}));
}

/** Keeps each tool's arg types when tools of different shapes share one array. */
export const defineTool=<S extends z.ZodRawShape>(t:ToolDef<S>):ToolDef<any>=>t;
