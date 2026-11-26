// The local editor over loopback HTTP (guards, JSON and SSE replies, progress,
// list_changed), its token file, and the start-up check of the face finder,
// subject mask and pixel font. Loopback only: no network, no paid calls.
import {describe,expect,test} from 'bun:test';
import {mkdtemp,stat,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {checkNatives,FACE_MODEL,missingNote,PIXEL_FONT,SUBJECT_MODEL} from '../src/native/check';
import {venvPython} from '../src/native/bridge';
import type {McpServer} from '../src/video/editor/agent/mcp-protocol';
import {z} from '../src/video/editor/agent/port';
import {hostName,refuse,serveHttp} from '../src/video/editor/local-mcp/http';
import {editorToken} from '../src/video/editor/local-mcp/server';
import {fontFace} from '../src/video/editor/agent/sandbox/remotion/scenes/root';

const TOKEN='t0ken-for-tests';
const server:McpServer={name:'t',version:'1',tools:()=>[
  {name:'slow',description:'reports progress',input:{n:z.number()},run:async({n},ctx)=>{for(let i=1;i<=n;i++)ctx.progress(i,n,`step ${i}`);return {text:`done ${n}`};}},
]};

async function up() {
  const e=await serveHttp(server,{port:0,token:TOKEN});
  const post=(body:unknown,headers:Record<string,string>={})=>fetch(e.url,{method:'POST',body:JSON.stringify(body),
    headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${TOKEN}`,...headers}});
  return {e,post};
}

describe('loopback HTTP guards',()=>{
  test('host, origin and token',()=>{
    const h=(x:Record<string,string>)=>({headers:x});
    const ok={host:'127.0.0.1:7820',authorization:`Bearer ${TOKEN}`};
    expect(refuse(h(ok),7820,TOKEN)).toBeNull();
    expect(refuse(h({...ok,host:'localhost:7820'}),7820,TOKEN)).toBeNull();
    expect(refuse(h({...ok,host:'[::1]:7820'}),7820,TOKEN)).toBeNull();
    expect(refuse(h({...ok,origin:'http://127.0.0.1:7820'}),7820,TOKEN)).toBeNull();
    // DNS rebinding: a page on evil.test resolved to 127.0.0.1 still sends its own Host.
    expect(refuse(h({...ok,host:'evil.test:7820'}),7820,TOKEN)?.[0]).toBe(403);
    expect(refuse(h({...ok,origin:'https://evil.test'}),7820,TOKEN)?.[0]).toBe(403);
    expect(refuse(h({...ok,origin:'http://127.0.0.1:3000'}),7820,TOKEN)?.[0]).toBe(403);
    expect(refuse(h({...ok,origin:'null'}),7820,TOKEN)?.[0]).toBe(403);
    expect(refuse(h({host:ok.host}),7820,TOKEN)?.[0]).toBe(401);
    expect(refuse(h({...ok,authorization:'Bearer wrong'}),7820,TOKEN)?.[0]).toBe(401);
    expect(hostName('[::1]:80')).toBe('::1');
  });

  test('refuses a non-loopback bind and an empty token',async()=>{
    await expect(serveHttp(server,{port:0,host:'0.0.0.0',token:TOKEN})).rejects.toThrow('loopback only');
    await expect(serveHttp(server,{port:0,token:''})).rejects.toThrow('token');
  });

  test('over the wire: 401 without token, 403 with a foreign Origin, 404 off /mcp',async()=>{
    const {e,post}=await up();
    try {
      expect((await fetch(e.url,{method:'POST',body:'{}'})).status).toBe(401);
      expect((await post({jsonrpc:'2.0',id:1,method:'ping'},{origin:'https://evil.test'})).status).toBe(403);
      expect((await fetch(e.url.replace('/mcp','/x'),{headers:{authorization:`Bearer ${TOKEN}`}})).status).toBe(404);
    }
    finally {await e.close();}
  });
});

describe('Streamable HTTP',()=>{
  test('initialize and tools/list as JSON; notifications get 202',async()=>{
    const {e,post}=await up();
    try {
      const init=await post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{accept:'application/json'});
      expect(init.status).toBe(200);
      expect(init.headers.get('mcp-session-id')).toBeString();
      expect(((await init.json()) as any).result.serverInfo.name).toBe('t');
      expect((await post({jsonrpc:'2.0',method:'notifications/initialized'})).status).toBe(202);
      const list=await post({jsonrpc:'2.0',id:2,method:'tools/list'},{accept:'application/json'});
      expect(((await list.json()) as any).result.tools.map((t:{name:string})=>t.name)).toEqual(['slow']);
    }
    finally {await e.close();}
  });

  test('a call streams its progress, then its answer, over SSE',async()=>{
    const {e,post}=await up();
    try {
      const r=await post({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'slow',arguments:{n:2},_meta:{progressToken:'p1'}}});
      expect(r.headers.get('content-type')).toContain('text/event-stream');
      const msgs=(await r.text()).split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
      expect(msgs.map(m=>m.method??'result')).toEqual(['notifications/progress','notifications/progress','result']);
      expect(msgs[0].params).toMatchObject({progressToken:'p1',progress:1,total:2});
      expect(msgs[2]).toMatchObject({id:7,result:{content:[{type:'text',text:'done 2'}]}});
    }
    finally {await e.close();}
  });

  test('GET stream carries tools/list_changed',async()=>{
    const {e}=await up();
    try {
      const ac=new AbortController();
      const r=await fetch(e.url,{headers:{accept:'text/event-stream',authorization:`Bearer ${TOKEN}`},signal:ac.signal});
      expect(r.status).toBe(200);
      const reader=r.body!.getReader();
      await reader.read();  // ': open'
      e.notify('notifications/tools/list_changed',{});
      const {value}=await reader.read();
      expect(new TextDecoder().decode(value)).toContain('notifications/tools/list_changed');
      ac.abort();
    }
    finally {await e.close();}
  });
});

describe('token',()=>{
  test('made once, owner-only, then reused; env wins',async()=>{
    const home=await mkdtemp(join(tmpdir(),'vx-token-'));
    const a=await editorToken(home,undefined);
    expect(a.token.length).toBeGreaterThan(20);
    expect(a.file).toBe(join(home,'mcp-token'));
    if(process.platform!=='win32')expect((await stat(a.file!)).mode&0o777).toBe(0o600);
    expect((await editorToken(home,undefined)).token).toBe(a.token);
    expect(await editorToken(home,' from-env ')).toEqual({token:'from-env'});
  });
});

describe('native check',()=>{
  test('names each missing piece and what it costs',async()=>{
    const root=await mkdtemp(join(tmpdir(),'vx-natives-')),fonts=join(root,'fonts');
    await mkdir(join(root,'models'));await mkdir(fonts);
    const none=await checkNatives({root,python:'py',fontsDir:fonts,probe:async()=>false});
    expect(none.missing).toHaveLength(4);
    expect(missingNote(none)).toContain('bun run setup');
    expect(missingNote(none)).toContain('zooms aim at the middle');
    for(const f of [FACE_MODEL,SUBJECT_MODEL])await writeFile(join(root,'models',f),'x');
    await writeFile(join(fonts,PIXEL_FONT),'x');
    const all=await checkNatives({root,python:'py',fontsDir:fonts,probe:async()=>true});
    expect(all).toMatchObject({python:true,faceModel:true,subjectModel:true,pixelFont:true,missing:[]});
    expect(missingNote(all)).toBe('');
  });

  test('the repo ships both models and the pixel font',async()=>{
    const c=await checkNatives({fontsDir:join(import.meta.dir,'..','apps/editor-mcp/fonts'),probe:async()=>true});
    expect(c.missing).toEqual([]);
  });

  test('venv interpreter path per platform',()=>{
    expect(venvPython('/r',false)).toBe(join('/r','.venv','bin','python'));
    expect(venvPython('/r',true)).toBe(join('/r','.venv','Scripts','python.exe'));
  });

  test('pixel font loads as the family "Pixelify Sans"',()=>{
    expect(fontFace(PIXEL_FONT)).toEqual({family:'Pixelify Sans',weight:400,style:'normal'});
  });

});
