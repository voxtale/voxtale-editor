// The local editor over MCP Streamable HTTP on loopback, for clients that
// connect to a URL (Claude Code, Codex, Cursor). Same handler as stdio
// (../agent/mcp-protocol). One server, one open project, shared by every
// client that connects.
//
// Guards, so a web page in the creator's browser cannot drive it:
// - binds 127.0.0.1 (or ::1) only; any other host is refused at start;
// - Host must name loopback (stops DNS rebinding);
// - an Origin header, when sent, must be this server's own loopback origin
//   (browsers send one on every cross-site POST; CLI clients send none);
// - every request carries `Authorization: Bearer <token>`.
// No CORS headers, so a browser cannot even read an error back.
//
// POST answers with JSON, or with a short SSE stream when the client accepts
// text/event-stream: that stream carries the call's progress, then its
// answer. GET opens an SSE stream for tools/list_changed.
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mcpHandler,type McpServer,type Notify,type Rpc} from '../agent/mcp-protocol';

export const DEFAULT_PORT=7820;
const LOOPBACK=new Set(['127.0.0.1','::1','localhost']);
const MAX_BODY=16*1024*1024;

export interface HttpOptions {
  /** 0 picks a free port. Default DEFAULT_PORT. */
  port?:number;
  /** Loopback only: 127.0.0.1 (default), ::1 or localhost. */
  host?:string;
  /** Bearer token every request must carry. */
  token:string;
}

export interface HttpEndpoint {url:string;port:number;notify:Notify;close():Promise<void>}

const same=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};

/** Host header without the port; [::1] → ::1. */
export function hostName(h:string|undefined):string {
  if(!h)return '';
  const m=/^\[([^\]]+)\](?::\d+)?$/.exec(h);
  return m?m[1]!:h.replace(/:\d+$/,'');
}

/** Why a request is refused (status and text), or null when it may pass. */
export function refuse(req:{headers:IncomingMessage['headers']},port:number,token:string):[number,string]|null {
  if(!LOOPBACK.has(hostName(req.headers.host).toLowerCase()))return [403,'host not allowed'];
  const origin=req.headers.origin;
  if(origin!==undefined) {
    let ok=false;
    try {const u=new URL(origin);ok=LOOPBACK.has(hostName(u.host).toLowerCase())&&Number(u.port||(u.protocol==='https:'?443:80))===port;}
    catch {ok=false;}
    if(!ok)return [403,'origin not allowed'];
  }
  const auth=req.headers.authorization??'';
  if(!auth.startsWith('Bearer ')||!same(auth.slice(7).trim(),token))return [401,'missing or wrong bearer token'];
  return null;
}

async function body(req:IncomingMessage):Promise<string|null> {
  const chunks:Buffer[]=[];let size=0;
  for await (const c of req) {
    size+=(c as Buffer).length;
    if(size>MAX_BODY)return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const sse=(res:ServerResponse,m:object)=>res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
const accepts=(req:IncomingMessage,type:string)=>(req.headers.accept??'').includes(type);

export async function serveHttp(s:McpServer,o:HttpOptions):Promise<HttpEndpoint> {
  const host=o.host??'127.0.0.1';
  if(!LOOPBACK.has(host))throw new Error(`the editor serves loopback only (127.0.0.1, ::1, localhost), not ${host}`);
  if(!o.token)throw new Error('a bearer token is required');
  const session=randomBytes(16).toString('hex');
  /** GET streams: server notifications (tools/list_changed). */
  const listeners=new Set<ServerResponse>();
  /** Progress token → the POST stream of the call that asked for it. */
  const progress=new Map<string|number,ServerResponse>();
  const notify:Notify=(method,params)=>{
    const m={jsonrpc:'2.0',method,params};
    const token=(params as {progressToken?:string|number}).progressToken;
    if(method==='notifications/progress'&&token!==undefined) {
      const res=progress.get(token);
      if(res)sse(res,m);
      return;
    }
    for(const res of listeners)sse(res,m);
  };
  const answer=mcpHandler(s,notify);
  let port=o.port??DEFAULT_PORT;

  const server=createServer(async(req,res)=>{
    const path=(req.url??'/').split('?')[0];
    if(path!=='/mcp'){res.writeHead(404).end();return;}
    const no=refuse(req,port,o.token);
    if(no) {
      res.writeHead(no[0],{'content-type':'text/plain',...(no[0]===401?{'www-authenticate':'Bearer'}:{})}).end(no[1]);
      return;
    }
    if(req.method==='DELETE'){res.writeHead(200).end();return;}
    if(req.method==='GET') {
      if(!accepts(req,'text/event-stream')){res.writeHead(405,{allow:'GET, POST, DELETE'}).end();return;}
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive','mcp-session-id':session});
      res.write(': open\n\n');
      listeners.add(res);
      const beat=setInterval(()=>res.write(': ping\n\n'),25_000);
      req.on('close',()=>{clearInterval(beat);listeners.delete(res);});
      return;
    }
    if(req.method!=='POST'){res.writeHead(405,{allow:'GET, POST, DELETE'}).end();return;}
    const text=await body(req);
    if(text===null){res.writeHead(413).end();return;}
    let msg:Rpc|Rpc[];
    try {msg=JSON.parse(text);}
    catch {res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'parse error'}}));return;}
    const batch=Array.isArray(msg)?msg:[msg];
    // Requests have a method and an id; notifications and client responses get 202.
    const requests=batch.filter(m=>m&&typeof m.method==='string'&&m.id!==undefined&&m.id!==null);
    if(!requests.length){await Promise.all(batch.filter(m=>m&&typeof m.method==='string').map(answer));res.writeHead(202).end();return;}
    const headers={'mcp-session-id':session};
    if(accepts(req,'text/event-stream')) {
      res.writeHead(200,{...headers,'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'});
      const tokens=requests.map(m=>m.params?._meta?.progressToken).filter((t):t is string|number=>t!==undefined);
      for(const t of tokens)progress.set(t,res);
      try {
        await Promise.all(batch.map(async m=>{
          const r=await answer(m).catch(e=>({jsonrpc:'2.0',id:m.id??null,error:{code:-32603,message:e instanceof Error?e.message:String(e)}}));
          if(r)sse(res,r);
        }));
      }
      finally {for(const t of tokens)progress.delete(t);res.end();}
      return;
    }
    const out=(await Promise.all(batch.map(m=>answer(m).catch(e=>({jsonrpc:'2.0',id:m.id??null,error:{code:-32603,message:e instanceof Error?e.message:String(e)}}))))).filter(Boolean);
    res.writeHead(200,{...headers,'content-type':'application/json'}).end(JSON.stringify(Array.isArray(msg)?out:out[0]));
  });
  // Renders and transcription run for minutes.
  server.requestTimeout=0;server.headersTimeout=0;server.keepAliveTimeout=0;
  await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(port,host,()=>{server.off('error',fail);ok();});});
  port=(server.address() as AddressInfo).port;
  const shown=host==='::1'?'[::1]':host;
  return {url:`http://${shown}:${port}/mcp`,port,notify,
    close:()=>new Promise(r=>{for(const l of listeners)l.end();server.closeAllConnections();server.close(()=>r());})};
}
