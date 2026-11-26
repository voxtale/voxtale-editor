// MCP over JSON-RPC, one handler for every transport: the loopback HTTP
// endpoint the agent planner hands its harness (./mcp-http) and the local
// editor's stdio server (../local-mcp). A later cloud MCP (VoxTale login)
// puts its own transport and auth in front of the same handler.
import type {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';
import {z} from 'zod/v4';
import type {ToolResult} from './port';

export interface Rpc {jsonrpc:'2.0';id?:string|number|null;method:string;params?:any}

/** What a tool may do while it runs: report progress (sent only when the client asked for it). */
export interface CallCtx {progress(done:number,total?:number,message?:string):void}

export interface McpTool {name:string;description:string;input:z.ZodRawShape;run(args:any,ctx:CallCtx):Promise<ToolResult>}
export interface McpResource {uri:string;name:string;description:string;mimeType:string;read():string|Promise<string>}
export interface McpPrompt {name:string;description:string;text():string}

export interface McpServer {
  name:string;
  version:string;
  instructions?:string;
  /** The tools right now; a server whose list changes says so with listChanged and sends tools/list_changed. */
  tools():McpTool[];
  listChanged?:boolean;
  resources?:McpResource[];
  prompts?:McpPrompt[];
  /** One tool call at a time (tools that share one workspace and its files). */
  serial?:boolean;
}

export type Notify=(method:string,params:object)=>void;

export function toMcp(r:ToolResult) {
  return {
    content:[
      {type:'text' as const,text:r.text},
      ...(r.images??[]).map(i=>({type:'image' as const,data:Buffer.from(i.data).toString('base64'),mimeType:i.mime})),
    ],
    ...(r.isError?{isError:true}:{}),
  };
}

const schemaOf=(input:z.ZodRawShape)=>{
  const {$schema:_,...s}=z.toJSONSchema(z.object(input),{io:'input',unrepresentable:'any'}) as Record<string,unknown>;
  return s;
};

const message=(e:unknown)=>e instanceof z.ZodError?z.prettifyError(e):e instanceof Error?e.message:String(e);

/** Answers one request; null for a notification. `notify` carries progress back to the client. */
export function mcpHandler(s:McpServer,notify:Notify=()=>{}):(m:Rpc)=>Promise<object|null> {
  let queue:Promise<unknown>=Promise.resolve();
  const capabilities={tools:s.listChanged?{listChanged:true}:{},...(s.prompts?{prompts:{}}:{}),...(s.resources?{resources:{}}:{})};

  async function call(m:Rpc):Promise<ToolResult|undefined> {
    const t=s.tools().find(x=>x.name===m.params?.name);
    if(!t)return undefined;
    const args=z.object(t.input).safeParse(m.params?.arguments??{});
    if(!args.success)return {text:`Bad arguments: ${z.prettifyError(args.error)}`,isError:true};
    const token=m.params?._meta?.progressToken;
    const ctx:CallCtx={progress:(progress,total,text)=>{
      if(token!==undefined)notify('notifications/progress',{progressToken:token,progress,...(total!==undefined?{total}:{}),...(text?{message:text}:{})});
    }};
    try {return await t.run(args.data,ctx);}
    catch(e) {return {text:`Error: ${message(e)}`,isError:true};}
  }

  return async m=>{
    const ok=(result:unknown)=>({jsonrpc:'2.0',id:m.id,result});
    const fail=(code:number,text:string)=>({jsonrpc:'2.0',id:m.id,error:{code,message:text}});
    if(m.id===undefined||m.id===null)return null;  // notifications: initialized, cancelled
    switch(m.method) {
      case 'initialize':
        return ok({protocolVersion:m.params?.protocolVersion??'2025-06-18',capabilities,serverInfo:{name:s.name,version:s.version},
          ...(s.instructions?{instructions:s.instructions}:{})});
      case 'ping':return ok({});
      case 'tools/list':return ok({tools:s.tools().map(t=>({name:t.name,description:t.description,inputSchema:schemaOf(t.input)}))});
      case 'tools/call': {
        const run=s.serial?queue.then(()=>call(m)):call(m);
        if(s.serial)queue=run.catch(()=>{});
        const r=await run;
        return r?ok(toMcp(r)):fail(-32602,`no tool ${m.params?.name}`);
      }
      case 'prompts/list':
        if(!s.prompts)break;
        return ok({prompts:s.prompts.map(({name,description})=>({name,description}))});
      case 'prompts/get': {
        if(!s.prompts)break;
        const p=s.prompts.find(x=>x.name===m.params?.name);
        if(!p)return fail(-32602,`no prompt ${m.params?.name}`);
        return ok({description:p.description,messages:[{role:'user',content:{type:'text',text:p.text()}}]});
      }
      case 'resources/list':
        if(!s.resources)break;
        return ok({resources:s.resources.map(({uri,name,description,mimeType})=>({uri,name,description,mimeType}))});
      case 'resources/templates/list':
        if(!s.resources)break;
        return ok({resourceTemplates:[]});
      case 'resources/read': {
        if(!s.resources)break;
        const uri=String(m.params?.uri??''),r=s.resources.find(x=>x.uri===uri);
        if(!r)return fail(-32002,`no resource ${uri}`);
        try {return ok({contents:[{uri,mimeType:r.mimeType,text:await r.read()}]});}
        catch(e) {return fail(-32002,message(e));}
      }
    }
    return fail(-32601,`no method ${m.method}`);
  };
}

/**
 * Serve over stdio: one JSON message per line. stdout carries protocol
 * messages only, so console.log goes to stderr from here on. Exits when
 * stdin closes and the calls in flight are done.
 */
export function serveStdio(s:McpServer):{notify:Notify} {
  console.log=console.error;
  const send=(m:object)=>process.stdout.write(`${JSON.stringify(m)}\n`);
  const notify:Notify=(method,params)=>send({jsonrpc:'2.0',method,params});
  const answer=mcpHandler(s,notify);
  const pending=new Set<Promise<unknown>>();
  // Core's node types leave readline's Interface without its EventEmitter
  // methods (adapters/cli.ts casts the same way).
  const rl=createInterface({input:process.stdin,crlfDelay:Infinity}) as unknown as EventEmitter;
  rl.on('line',(line:string)=>{
    if(!line.trim())return;
    let m:Rpc;
    try {m=JSON.parse(line);}
    catch {send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'parse error'}});return;}
    const job=answer(m).then(r=>{if(r)send(r);},e=>send({jsonrpc:'2.0',id:m.id??null,error:{code:-32603,message:message(e)}}));
    pending.add(job);
    void job.finally(()=>pending.delete(job));
  });
  rl.on('close',async()=>{await Promise.allSettled([...pending]);process.exit(0);});
  return {notify};
}
