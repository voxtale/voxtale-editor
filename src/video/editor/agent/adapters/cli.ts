// Harness CLIs as subprocesses: `claude -p` and `codex exec`. Each uses whatever
// login the CLI already has (a subscription, or a proxy in the user's Claude
// Code settings), so dev runs cost no API credit. Never offer this to users:
// products may not run on a consumer login. Tools come from our MCP endpoint
// (../mcp-http); the CLI only drives the loop.
import {spawn} from 'node:child_process';
import type {EventEmitter} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import type {AgentRun,AgentRunner,AgentTask} from '../port';

const SERVER='editor';
const TOKEN_ENV='VOXTALE_EDITOR_MCP_TOKEN';

function childEnv(extra:Record<string,string>={}):Record<string,string> {
  const env={...process.env,...extra} as Record<string,string>;
  // Never let a stray API key turn a subscription run into a billed one,
  // and don't look like a nested Claude Code session.
  for(const k of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT'])delete env[k];
  return env;
}

/** Run a CLI that prints one JSON event per line; returns its exit code. */
function lines(task:AgentTask,cmd:string[],cwd:string,env:Record<string,string>,on:(ev:any)=>void):Promise<number> {
  task.log?.(`spawn ${cmd[0]} ${cmd.slice(1).map(a=>a.length>60?`${a.slice(0,57)}…`:a).join(' ')}`);
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd[0]!,cmd.slice(1),{cwd,env,stdio:['ignore','pipe','pipe']});
    const kill=()=>p.kill();
    task.signal?.addEventListener('abort',kill,{once:true});
    const each=(input:NodeJS.ReadableStream,fn:(l:string)=>void)=>(createInterface({input}) as unknown as EventEmitter).on('line',fn);
    each(p.stderr!,l=>{if(l.trim())task.log?.(`[stderr] ${l.trim().slice(0,300)}`);});
    each(p.stdout!,l=>{
      const line=l.trim();
      if(!line)return;
      let ev:unknown;
      try {ev=JSON.parse(line);} catch {task.log?.(`[stdout] ${line.slice(0,300)}`);return;}
      on(ev);
    });
    // bun-types drop ChildProcess's EventEmitter side; node has it.
    const events=p as unknown as EventEmitter;
    events.on('error',(e:Error)=>{task.signal?.removeEventListener('abort',kill);reject(e);});
    events.on('close',(code:number|null)=>{task.signal?.removeEventListener('abort',kill);resolve(code??-1);});
  });
}

/** Harness cwd: an empty folder, so no project CLAUDE.md/AGENTS.md leaks in. */
async function scratch<T>(fn:(dir:string)=>Promise<T>):Promise<T> {
  const dir=await mkdtemp(join(tmpdir(),'voxtale-agent-'));
  try {return await fn(dir);} finally {await rm(dir,{recursive:true,force:true});}
}

const short=(name:string)=>name.replace(`mcp__${SERVER}__`,'');

/** `claude -p`: Claude Code's own loop, no built-in tools, only ours. */
/** settings: JSON string or file for `--settings`, e.g. a proxy's ANTHROPIC_BASE_URL env. */
export function claudeCliRunner(o:{bin?:string;settings?:string}={}):AgentRunner {
  return {name:'claude-cli',run:task=>scratch(async cwd=>{
    if(!task.server)throw new Error('claude-cli needs task.server');
    const mcp=join(cwd,'mcp.json'),sys=join(cwd,'system.md');
    await writeFile(mcp,JSON.stringify({mcpServers:{[SERVER]:{type:'http',url:task.server.url,headers:task.server.headers}}}));
    await writeFile(sys,task.instructions);
    const cmd=[o.bin??'claude','-p',task.prompt,'--output-format','stream-json','--verbose',
      '--system-prompt-file',sys,'--tools','','--mcp-config',mcp,'--strict-mcp-config',
      '--allowedTools',...task.tools.map(t=>`mcp__${SERVER}__${t.name}`),
      // user settings only: keeps the user's login/proxy, skips project config.
      '--setting-sources','user','--permission-mode','dontAsk',
      '--max-turns',String(task.maxTurns),'--max-budget-usd',String(task.maxBudgetUsd),
      ...(o.settings?['--settings',o.settings]:[]),
      ...(task.model?['--model',task.model]:[])];
    const calls:AgentRun['toolCalls']=[];
    let stop='unknown',turns=0,costUsd:number|null=null,finalText='';
    const code=await lines(task,cmd,cwd,childEnv(),m=>{
      if(m.type==='system'&&m.subtype==='init')task.log?.(`init model=${m.model} tools=${(m.tools??[]).length} mcp=${JSON.stringify(m.mcp_servers)}`);
      if(m.type==='assistant')for(const b of m.message?.content??[]) {
        if(b.type==='text'&&b.text.trim()){task.log?.(`agent: ${b.text.trim().slice(0,400)}`);task.said?.(b.text);}
        if(b.type==='thinking'&&b.thinking?.trim())task.said?.(b.thinking);
        if(b.type==='tool_use'){task.log?.(`call ${short(b.name)} ${JSON.stringify(b.input).slice(0,200)}`);calls.push({name:short(b.name),ms:0,isError:false});}
      }
      if(m.type==='user')for(const b of m.message?.content??[])if(b.type==='tool_result'&&b.is_error&&calls.length)calls[calls.length-1]!.isError=true;
      if(m.type==='result'){stop=m.subtype;turns=m.num_turns;costUsd=m.total_cost_usd??null;if(m.subtype==='success')finalText=m.result;}
    });
    if(stop==='unknown')stop=`exit ${code}`;
    return {stop,turns,costUsd,toolCalls:calls,finalText};
  })};
}

/** `codex exec`: Codex's loop on the ChatGPT login. Instructions go in AGENTS.md. */
export function codexRunner(o:{bin?:string}={}):AgentRunner {
  return {name:'codex-cli',run:task=>scratch(async cwd=>{
    if(!task.server)throw new Error('codex needs task.server');
    await writeFile(join(cwd,'AGENTS.md'),task.instructions);
    const s=`mcp_servers.${SERVER}`;
    const token=(task.server.headers.Authorization??'').replace(/^Bearer /,'');
    const cmd=[o.bin??'codex','exec','--json','--skip-git-repo-check','--ephemeral','-s','read-only','-C',cwd,
      '-c',`${s}.url=${JSON.stringify(task.server.url)}`,'-c',`${s}.bearer_token_env_var=${JSON.stringify(TOKEN_ENV)}`,
      '-c',`${s}.startup_timeout_sec=60`,'-c',`${s}.tool_timeout_sec=600`,
      ...(task.model?['-m',task.model]:[]),task.prompt];
    const calls:AgentRun['toolCalls']=[];
    let turns=0,finalText='',failed='';
    const code=await lines(task,cmd,cwd,childEnv({[TOKEN_ENV]:token}),ev=>{
      const it=ev.item;
      if(ev.type==='item.completed'&&it?.type==='agent_message'){finalText=it.text;task.log?.(`agent: ${String(it.text).slice(0,400)}`);task.said?.(String(it.text));}
      if(ev.type==='item.completed'&&it?.type==='mcp_tool_call'){
        task.log?.(`call ${it.tool} ${JSON.stringify(it.arguments).slice(0,200)} ${it.status}`);
        calls.push({name:it.tool,ms:0,isError:it.status!=='completed'||!!it.result?.is_error});
        turns++;
      }
      if(ev.type==='item.completed'&&it?.type==='reasoning'&&it.text)task.said?.(String(it.text));
      if(ev.type==='item.completed'&&it?.type==='command_execution')task.log?.(`shell (built-in): ${String(it.command).slice(0,200)}`);
      if(ev.type==='turn.completed')task.log?.(`usage ${JSON.stringify(ev.usage)}`);
      if(ev.type==='turn.failed'||ev.type==='error')failed=JSON.stringify(ev.error??ev).slice(0,300);
    });
    return {stop:failed?`error ${failed}`:code===0?'success':`exit ${code}`,turns,costUsd:null,toolCalls:calls,finalText};
  })};
}
