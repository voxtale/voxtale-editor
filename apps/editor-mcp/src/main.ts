// VoxTale editor MCP server on this machine. All the logic is in core
// (voxtale-editor/mcp); this file picks the transport and points it at the fonts.
//
//   bun apps/editor-mcp/src/main.ts --http [--port 7820]   loopback URL http://127.0.0.1:7820/mcp
//   bun apps/editor-mcp/src/main.ts --stdio                 for clients that start the server themselves
//
// With neither flag: HTTP when run in a terminal, stdio when a client starts it
// with pipes (so `claude mcp add … -- bun main.ts` keeps working).
// Env: VOXTALE_EDITOR_TRANSPORT=http|stdio, VOXTALE_EDITOR_PORT, VOXTALE_EDITOR_TOKEN.
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {runLocalEditor} from 'voxtale-editor/mcp';

const {values}=parseArgs({options:{http:{type:'boolean'},stdio:{type:'boolean'},port:{type:'string'}},strict:true});
const env=process.env.VOXTALE_EDITOR_TRANSPORT?.trim().toLowerCase();
if(values.http&&values.stdio)throw new Error('pick one: --http or --stdio');
const http=values.http||values.port!==undefined?true:values.stdio?false:env==='http'?true:env==='stdio'?false:!!process.stdin.isTTY;
const raw=values.port??process.env.VOXTALE_EDITOR_PORT;
const port=raw===undefined?undefined:Number(raw);
if(port!==undefined&&!(Number.isInteger(port)&&port>=0&&port<65536))throw new Error(`bad port: ${raw}`);

await runLocalEditor({fontsDir:join(import.meta.dir,'..','fonts'),...(http?{http:port!==undefined?{port}:{}}:{})});
