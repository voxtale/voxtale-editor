// Skill v29 wiring, and the registry check: every tool the skill or the local
// guide names is registered with the agent or served by the local MCP.
import {describe,expect,test} from 'bun:test';
import {clipRefSchema} from '@voxtale/editdoc';
import {AGENT_SKILL_PROMPT_ID} from '../src/video/editor/agent/skill';
import {editorTools} from '../src/video/editor/agent/tools';
import {newWorkspace} from '../src/video/editor/agent/session';
import {mcpHandler,type Rpc} from '../src/video/editor/agent/mcp-protocol';
import {editingGuide,SERVER_INSTRUCTIONS} from '../src/video/editor/local-mcp/guide';
import {localEditorServer} from '../src/video/editor/local-mcp/server';
import {listPrompts,promptText,promptTextVersion} from '../src/services/prompts';

const req=(method:string,params:unknown={}):Rpc=>({jsonrpc:'2.0',id:1,method,params});
const ref=(id:string,h:string,o:Record<string,unknown>)=>clipRefSchema.parse({id,hash:h.repeat(64),name:`${id}.mov`,kind:'video',roleSource:'index',duration:10,hasAudio:true,width:1920,height:1080,...o});
/** A job that switches on every conditional tool: footage with moments, music, a sync group. */
function agentTools():Set<string> {
  const job:any={id:'j',name:'J',clips:[
    {ref:ref('a','a',{role:'a-roll'}),words:[{id:0,text:'hi',start:0,end:1}]},
    {ref:ref('b','b',{role:'b-roll',hasAudio:false}),words:[],moments:{moments:[{t:1}]}},
    {ref:ref('m','c',{role:'music',kind:'audio'}),words:[]}],sync:[]};
  const ws:any=newWorkspace({dir:'/tmp/skill-v29',job,frames:{} as any,graphics:true});
  ws.syncGroups={groups:[{id:'g'}]};
  return new Set(editorTools(ws).map(t=>t.name));
}
async function served(vision:null|undefined):Promise<string[]> {
  const answer=mcpHandler(localEditorServer({graphics:true,vision},()=>()=>{}));
  return ((await answer(req('tools/list')) as any).result.tools as {name:string}[]).map(t=>t.name);
}
// snake_case words in the text that are not tools (a role).
const NOT_TOOLS=new Set(['screen_synced']);
const named=(text:string)=>[...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g)??[])].filter(n=>!NOT_TOOLS.has(n));

describe('skill v29',()=>{
  test('is the active editor skill, on top of v28',()=>{
    expect(listPrompts().find(p=>p.id===AGENT_SKILL_PROMPT_ID)?.active).toBe(29);
    expect(promptText(AGENT_SKILL_PROMPT_ID)).toBe(promptTextVersion(AGENT_SKILL_PROMPT_ID,29));
    expect(promptTextVersion(AGENT_SKILL_PROMPT_ID,29)).not.toBe(promptTextVersion(AGENT_SKILL_PROMPT_ID,28));
    expect(promptText(AGENT_SKILL_PROMPT_ID)).toContain('place_logo');
  });
  test('the local guide carries it',()=>{
    expect(editingGuide(true,false).startsWith(promptText(AGENT_SKILL_PROMPT_ID))).toBe(true);
  });
});

describe('tool registry',()=>{
  test('every tool the skill and the local guide name is registered',async()=>{
    const agent=agentTools();
    const harness=await served(null),all=new Set([...agent,...harness,...await served(undefined)]);
    for(const text of [promptText(AGENT_SKILL_PROMPT_ID),editingGuide(true,false),editingGuide(true,true),SERVER_INSTRUCTIONS])
      expect(named(text).filter(n=>!all.has(n))).toEqual([]);
    for(const t of ['label_footage','save_labels'])expect(harness).toContain(t);
    for(const t of ['set_angles','set_av_offset','place_logo'])expect(agent.has(t)).toBe(true);
  });
  test('the local MCP serves every agent tool that needs no footage',async()=>{
    const list=new Set(await served(null));
    // With no project open the footage-only tools (moments, music, other video, angles) wait for open.
    const waiting=new Set(['find_footage','screen_activity','set_music','survey_clips','rank_candidates','show_footage','set_angles']);
    expect([...agentTools()].filter(n=>!waiting.has(n)&&!list.has(n))).toEqual([]);
  });
});
