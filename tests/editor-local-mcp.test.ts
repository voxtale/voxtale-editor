// The local editor MCP without footage or a model: what it lists before a
// project opens, its resources and prompt, and the stdio-free handler.
import {describe,expect,test} from 'bun:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {mcpHandler,type Rpc} from '../src/video/editor/agent/mcp-protocol';
import {z} from '../src/video/editor/agent/port';
import {localEditorServer} from '../src/video/editor/local-mcp/server';

const req=(method:string,params:unknown={},id=1):Rpc=>({jsonrpc:'2.0',id,method,params});

describe('local editor MCP',()=>{
  test('lists server and editor tools before a project opens',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'edit-mcp-'));
    const answer=mcpHandler(localEditorServer({folder,graphics:false},()=>()=>{}));
    const init=await answer(req('initialize',{protocolVersion:'2025-06-18'})) as any;
    expect(init.result.capabilities).toEqual({tools:{listChanged:true},prompts:{},resources:{}});
    expect(init.result.instructions).toBeString();
    const names=((await answer(req('tools/list')) as any).result.tools as {name:string}[]).map(t=>t.name);
    for(const n of ['editing_guide','open','resume','render','sheet','clips','export_timeline','get_transcript','set_cut','finish'])expect(names).toContain(n);
    // Graphics off: no graphics tools. No moments: no find_footage.
    expect(names).not.toContain('render_graphic');
    expect(names).not.toContain('find_footage');
  });

  test('editor tools need an open project; resume says when there is none',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'edit-mcp-'));
    const answer=mcpHandler(localEditorServer({folder,graphics:false},()=>()=>{}));
    const r=await answer(req('tools/call',{name:'get_transcript',arguments:{}})) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('no project open');
    const resume=await answer(req('tools/call',{name:'resume',arguments:{}})) as any;
    expect(resume.result.isError).toBe(true);
  });

  test('serves the EditDoc schema, the guide and the prompt',async()=>{
    const answer=mcpHandler(localEditorServer({folder:tmpdir(),graphics:true},()=>()=>{}));
    const list=(await answer(req('resources/list')) as any).result.resources.map((r:{uri:string})=>r.uri);
    expect(list).toEqual(['editdoc://guide','editdoc://schema','editdoc://current']);
    const schema=JSON.parse((await answer(req('resources/read',{uri:'editdoc://schema'})) as any).result.contents[0].text);
    expect(schema.type).toBe('object');
    expect(schema.properties.tracks).toBeDefined();
    expect((await answer(req('resources/read',{uri:'editdoc://current'})) as any).error.code).toBe(-32002);
    const prompt=(await answer(req('prompts/get',{name:'edit-video'})) as any).result;
    expect(prompt.messages[0].content.text.length).toBeGreaterThan(1000);
    expect(((await answer(req('tools/list')) as any).result.tools as {name:string}[]).map(t=>t.name)).toContain('render_graphic');
  });
});

describe('MCP protocol',()=>{
  test('serial servers run one call at a time and report progress to the caller',async()=>{
    let running=0,most=0;
    const sent:[string,any][]=[];
    const answer=mcpHandler({name:'t',version:'1',serial:true,tools:()=>[{name:'wait',description:'',input:{ms:z.number()},
      run:async({ms},ctx)=>{
        running++;most=Math.max(most,running);ctx.progress(1,2,'half');
        await new Promise(r=>setTimeout(r,ms));
        running--;
        return {text:'done'};
      }}]},(method,params)=>sent.push([method,params]));
    await Promise.all([answer(req('tools/call',{name:'wait',arguments:{ms:20},_meta:{progressToken:'p'}},1)),answer(req('tools/call',{name:'wait',arguments:{ms:5}},2))]);
    expect(most).toBe(1);
    expect(sent).toEqual([['notifications/progress',{progressToken:'p',progress:1,total:2,message:'half'}]]);
    expect(await answer({jsonrpc:'2.0',method:'notifications/initialized'})).toBeNull();
    expect((await answer(req('prompts/list')) as any).error.code).toBe(-32601);
  });
});
