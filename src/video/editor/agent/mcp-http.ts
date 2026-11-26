// The editor tools as an MCP endpoint on loopback (Streamable HTTP, JSON
// replies, no server-sent events), for harnesses that run out of process
// (claude -p, codex exec). In-process and token-gated, so the desktop needs no
// second bundle or stdio child, and nothing else on the machine can call it.
// The protocol itself is ./mcp-protocol, shared with the stdio server.
import {randomBytes} from 'node:crypto';
import {createServer,type IncomingMessage} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mcpHandler,type Rpc} from './mcp-protocol';
import type {ToolDef} from './port';

export {toMcp} from './mcp-protocol';

export interface McpEndpoint {url:string;headers:Record<string,string>;close():Promise<void>}

async function body(req:IncomingMessage):Promise<string> {
  const chunks:Buffer[]=[];
  for await (const c of req)chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function serveTools(tools:ToolDef<any>[],name='editor'):Promise<McpEndpoint> {
  const token=randomBytes(24).toString('hex');
  const answer=mcpHandler({name,version:'1',tools:()=>tools});

  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end();return;}
    if(req.method==='DELETE'){res.writeHead(200).end();return;}
    if(req.method!=='POST'){res.writeHead(405,{allow:'POST'}).end();return;}
    let msg:Rpc|Rpc[];
    try {msg=JSON.parse(await body(req));}
    catch {res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'parse error'}}));return;}
    const out=(await Promise.all((Array.isArray(msg)?msg:[msg]).map(answer))).filter(Boolean);
    if(!out.length){res.writeHead(202).end();return;}
    res.writeHead(200,{'content-type':'application/json','mcp-session-id':token.slice(0,16)})
      .end(JSON.stringify(Array.isArray(msg)?out:out[0]));
  });
  // Tool calls (graphic renders) can run for minutes.
  server.requestTimeout=0;server.headersTimeout=0;
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const {port}=server.address() as AddressInfo;
  return {url:`http://127.0.0.1:${port}/mcp`,headers:{Authorization:`Bearer ${token}`},
    close:()=>new Promise(r=>{server.closeAllConnections();server.close(()=>r());})};
}
