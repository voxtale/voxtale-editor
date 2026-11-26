// Claude Agent SDK runner for the cloud agent editor. API key only: products
// may not run on a claude.ai login (that is ./cli, for dev). No built-in
// tools, no settings files, no session on disk; only our MCP endpoint.
import {query} from '@anthropic-ai/claude-agent-sdk';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentRun,AgentRunner} from '../port';

const SERVER='editor';
const short=(name:string)=>name.replace(`mcp__${SERVER}__`,'');

export interface SdkRunnerOptions {
  apiKey:string;
  /** Default model when the task names none. */
  model?:string;
  /** Anthropic API base URL; default the SDK's. For a local test proxy only. */
  baseUrl?:string;
  /** Path to the Claude Code executable; default: the SDK's own. */
  executable?:string;
}

export function claudeSdkRunner(o:SdkRunnerOptions):AgentRunner {
  return {name:'claude-agent-sdk',async run(task):Promise<AgentRun> {
    if(!task.server)throw new Error('claude-agent-sdk needs task.server');
    // An empty cwd, so no project CLAUDE.md reaches the agent.
    const cwd=await mkdtemp(join(tmpdir(),'voxtale-agent-'));
    const abort=new AbortController();
    const stop=()=>abort.abort();
    task.signal?.addEventListener('abort',stop,{once:true});
    let result='unknown',turns=0,costUsd:number|null=null,finalText='';
    try {
      const q=query({prompt:task.prompt,options:{
        abortController:abort,cwd,
        model:task.model||o.model||'claude-opus-5-5',
        systemPrompt:task.instructions,
        tools:[],
        mcpServers:{[SERVER]:{type:'http',url:task.server.url,headers:task.server.headers}},
        allowedTools:task.tools.map(t=>`mcp__${SERVER}__${t.name}`),
        permissionMode:'dontAsk',
        settingSources:[],
        persistSession:false,
        maxTurns:task.maxTurns,
        maxBudgetUsd:task.maxBudgetUsd,
        ...(o.executable?{pathToClaudeCodeExecutable:o.executable}:{}),
        // Only what the loop needs: never the worker's other secrets.
        env:{
          PATH:process.env.PATH??'',HOME:process.env.HOME??tmpdir(),
          ANTHROPIC_API_KEY:o.apiKey,
          ...(o.baseUrl?{ANTHROPIC_BASE_URL:o.baseUrl}:{}),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
          CLAUDE_AGENT_SDK_CLIENT_APP:'voxtale-agent-editor/0.1',
        },
        stderr:d=>{if(d.trim())task.log?.(`[sdk] ${d.trim().slice(0,300)}`);},
      }});
      for await (const m of q) {
        if(m.type==='assistant')for(const b of m.message.content) {
          if(b.type==='text'&&b.text.trim()){task.log?.(`agent: ${b.text.trim().slice(0,400)}`);task.said?.(b.text);}
          if(b.type==='thinking'&&b.thinking.trim())task.said?.(b.thinking);
          if(b.type==='tool_use')task.log?.(`call ${short(b.name)} ${JSON.stringify(b.input).slice(0,200)}`);
        }
        if(m.type==='result'){result=m.subtype;turns=m.num_turns;costUsd=m.total_cost_usd;if(m.subtype==='success')finalText=m.result;}
      }
    } finally {
      task.signal?.removeEventListener('abort',stop);
      await rm(cwd,{recursive:true,force:true});
    }
    // plan.ts counts tool calls itself, with timings.
    return {stop:result,turns,costUsd,toolCalls:[],finalText};
  }};
}
