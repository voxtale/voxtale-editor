// Spike 3: Opus writes a Remotion graphic against the kit; gate; sandbox render;
// perceiver check on stills; at most one repair.
import {gate} from './gate';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
const [jobDir, requestFile] = process.argv.slice(2);
const request = JSON.parse(await readFile(requestFile!, 'utf8'));
const kit = await readFile(join(import.meta.dir, 'sandbox/kit.tsx'), 'utf8');
const OR = async (model: string, messages: any[], extra: any = {}) => {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {method: 'POST', headers: {Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json'}, body: JSON.stringify({model, messages, usage: {include: true}, ...extra})});
  const b: any = await r.json(); if (!b.choices) throw new Error(JSON.stringify(b).slice(0, 400)); return b;
};
const system = `You write one motion graphic for a YouTube video as a Remotion component in TSX. It is rendered with a transparent background and laid over footage.
Rules:
- Import only from "react", "remotion" and "./kit". The kit source is below; prefer its components and hooks so graphics share one look.
- Export \`schema\` (a zod object via \`z\` from "./kit") describing every piece of text and data, \`defaultProps\` matching it, and a default-exported component taking those props. All visible text and numbers must come from props so they can change without new code.
- Never paint a full-frame background; the footage shows through. Keep everything inside <Stage> (safe area).
- Size with useUnit() (px at 1920 wide). Motion: enter with useEnter, leave with useExit; use frame-based animation only.
- No images, video, audio, URLs, fetch, timers, Date, Math.random, window or document.
- Text must fit: short lines, no overflow at the given canvas.
Return only the TSX module in one \`\`\`tsx block.

Kit (./kit):
\`\`\`tsx
${kit}
\`\`\``;
const user = (r: any) => `Graphic request:
purpose: ${r.purpose}
data: ${JSON.stringify(r.data)}
spoken over it: "${r.anchorWords}"
canvas: ${r.width}x${r.height}, ${r.fps} fps, ${r.durationInFrames} frames
placement: ${r.placement}`;
const extract = (s: string) => (s.match(/```(?:tsx|ts)?\n([\s\S]*?)```/)?.[1] ?? s).trim() + '\n';
let cost = 0; const log: any[] = [];
const messages: any[] = [{role: 'system', content: system}, {role: 'user', content: user(request)}];
async function write(attempt: number) {
  const t = Date.now(); const b = await OR('anthropic/claude-opus-5.5', messages, {max_tokens: 8000});
  cost += b.usage?.cost ?? 0; const code = extract(b.choices[0].message.content);
  messages.push({role: 'assistant', content: b.choices[0].message.content});
  log.push({attempt, step: 'write', seconds: (Date.now() - t) / 1000, cost: b.usage?.cost, tokens: [b.usage?.prompt_tokens, b.usage?.completion_tokens]});
  return code;
}
async function render(code: string, stills: number[]) {
  await mkdir(jobDir!, {recursive: true});
  await writeFile(join(jobDir!, 'graphic.tsx'), code);
  await writeFile(join(jobDir!, 'input.json'), JSON.stringify({props: request.props ?? undefined, tokens: request.tokens, width: request.width, height: request.height, fps: request.fps, durationInFrames: request.durationInFrames, stills, stillsOnly: true}));
  const p = Bun.spawnSync(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=1g', '--tmpfs', '/home/render:rw,size=64m', '--memory', '2g', '--cpus', '2', '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', `${jobDir}:/job`, 'voxtale-graphics-sandbox:spike']);
  return JSON.parse(await readFile(join(jobDir!, 'out/report.json'), 'utf8'));
}
async function perceive(stills: number[]) {
  const content: any[] = [{type: 'text', text: `These are frames of a motion graphic that will be laid over video (transparent areas show as white/grey here). Answer each question about defects only, never about taste. JSON only: {"defects":[{"frame":number,"kind":"text-cut-off"|"text-overlap"|"illegible"|"outside-safe-area"|"empty-frame"|"wrong-data"|"other","detail":string,"major":boolean}]}. Expected content: ${JSON.stringify(request.data)}. Frames in order: ${stills.join(', ')} (last frames may be mid-exit).`}];
  for (const f of stills) content.push({type: 'image_url', image_url: {url: `data:image/png;base64,${Buffer.from(await readFile(join(jobDir!, `out/still-${f}.png`))).toString('base64')}`}});
  const b = await OR('google/gemini-3.8-flash', [{role: 'user', content}], {response_format: {type: 'json_object'}, temperature: 0});
  cost += b.usage?.cost ?? 0; return JSON.parse(b.choices[0].message.content.replace(/^```json\s*|```\s*$/g, ''));
}
const D = request.durationInFrames, stills = [Math.round(D * 0.15), Math.round(D * 0.5), Math.round(D * 0.8)];
let code = await write(1), result: any = {};
for (let attempt = 1; attempt <= 2; attempt++) {
  const g = gate(code); log.push({attempt, step: 'gate', ...g});
  let problem = '';
  if (!g.ok) problem = `The static check rejected it:\n${g.errors.join('\n')}`;
  else {
    const r = await render(code, stills); log.push({attempt, step: 'render', ok: r.ok, stage: r.stage, seconds: r.totalSeconds, error: r.error?.slice(0, 600)});
    if (!r.ok) problem = `Rendering failed at ${r.stage}:\n${r.error?.slice(0, 1500)}`;
    else { const p = await perceive(stills); log.push({attempt, step: 'perceive', ...p}); const major = (p.defects ?? []).filter((d: any) => d.major);
      if (major.length) problem = `A visual check found defects:\n${major.map((d: any) => `frame ${d.frame}: ${d.kind} — ${d.detail}`).join('\n')}`; }
  }
  if (!problem) { result = {ok: true, attempts: attempt}; break; }
  if (attempt === 2) { result = {ok: false, attempts: attempt, problem}; break; }
  messages.push({role: 'user', content: `${problem}\nFix it. Return the whole module again.`});
  code = await write(2);
}
await writeFile(join(jobDir!, 'gen.json'), JSON.stringify({result, cost, log}, null, 1));
console.log(JSON.stringify({result, cost, log}, null, 1));
