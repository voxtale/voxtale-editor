// Skill v29/v30 wiring, and the registry check: every tool the skill or the local
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
  ws.picker=async()=>[];ws.media={};   // the object model and local media switch on pick_object, make_sfx, transcribe_sequence
  return new Set(editorTools(ws).map(t=>t.name));
}
async function served(vision:null|undefined):Promise<string[]> {
  const answer=mcpHandler(localEditorServer({graphics:true,vision},()=>()=>{}));
  return ((await answer(req('tools/list')) as any).result.tools as {name:string}[]).map(t=>t.name);
}
// snake_case words in the text that are not tools (a role).
const NOT_TOOLS=new Set(['screen_synced']);
const named=(text:string)=>[...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g)??[])].filter(n=>!NOT_TOOLS.has(n));

describe('skill v30',()=>{
  test('is the active editor skill, on top of v29, which stays registered',()=>{
    expect(listPrompts().find(p=>p.id===AGENT_SKILL_PROMPT_ID)?.active).toBe(30);
    expect(promptText(AGENT_SKILL_PROMPT_ID)).toBe(promptTextVersion(AGENT_SKILL_PROMPT_ID,30));
    const v29=promptTextVersion(AGENT_SKILL_PROMPT_ID,29);
    expect(v29).not.toBe(promptTextVersion(AGENT_SKILL_PROMPT_ID,28));
    expect(v29).toContain('place_logo');
    expect(v29).not.toContain('pick_object');
  });
  test('carries every W22 section',()=>{
    const t=promptText(AGENT_SKILL_PROMPT_ID);
    for(const tool of ['set_frame','track_title','live_scan','live_make_clip','pick_object','new_version','restore_version','timeline','find_words','download','make_sfx','trash'])
      expect(t).toContain(tool);
    for(const h of ['### Versions and reading the cut','### Clean by level','### Frame shape and motion tracking','### Text behind an object','## A finished livestream','### Where sounds come from','## Transcription','## Media from a link','## Render speed'])
      expect(t).toContain(h);
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
    for(const t of ['set_angles','set_av_offset','place_logo','set_frame','track_title','pick_object','find_words','timeline','make_sfx','transcribe_sequence'])expect(agent.has(t)).toBe(true);
    for(const t of ['live_scan','live_candidates','live_rate','live_make_clip','live_layout','new_version','versions','restore_version','trash','download'])expect(all.has(t)).toBe(true);
  });
  test('the local MCP serves every agent tool that needs no footage',async()=>{
    const list=new Set(await served(null));
    // With no project open the footage-only tools (moments, music, other video, angles, object picks, local media) wait for open.
    const waiting=new Set(['find_footage','screen_activity','set_music','survey_clips','rank_candidates','show_footage','set_angles','pick_object','make_sfx','transcribe_sequence']);
    expect([...agentTools()].filter(n=>!waiting.has(n)&&!list.has(n))).toEqual([]);
  });
});
