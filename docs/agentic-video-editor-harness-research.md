# Agent harness for the auto-editor: research (2026-10-07)

bd: super-tale-i0xu. Research only; nothing built. Web search was down for the
research agents, so sources are direct fetches (GitHub, docs, arXiv, HN, X).

## Question

Today the editor is a fixed pipeline of one-shot model calls (index → story →
retakes → text → b-roll → graphics plan → graphic write/check). Should an agent
loop drive it, with the stages as tools? Which harness, provider-agnostic? Why
are our motion graphics dull next to the viral Claude + Remotion work?

## Findings

### 1. Viral motion graphics: what and why

- Remotion Agent Skills (`npx skills add remotion-dev/skills`), 20 Jan 2026:
  18.9M views. HeyGen HyperFrames (HTML + GSAP, made in Claude Code), Apr 2026:
  3.0M views, 58k stars. Claude Design ships an "Animated video" skill.
- Quality comes from the workflow, not the model alone:
  - ~15k words of craft rules: easing defaults (`bezier(0.16,1,0.3,1)`,
    spring damping 200), perceptual scale, TransitionSeries, shapes,
    rough-notation highlights, ~70 effects, fonts, Lottie, text fitting.
  - Render chosen frames, look, fix. Many rounds, targeted edits.
  - Real assets: fonts, logos, icons, images.
  - HyperFrames splits a director (shot plan JSON) from a builder, builds from
    180 vetted blocks, names motion moves (`scale_punch` → `back.out(2.2)`),
    gates layout defects in code, then checks proof stills (opening, signature
    move, final hold). Its `talking-head-recut` skill is our exact use case:
    word timings → storyboard → one card per beat, 10 style presets, layout
    zones relative to the speaker.
  - Human taste: viral demos took 1–3 hours of back-and-forth each. One
    critic (316k views) got "bland, stock-looking" output at first and says
    many one-prompt demos were faked. One user put the cost at ~$700 of tokens.

### 2. Why ours are dull

- One write call, six kinds, prompt pushes reuse of a small kit: one look.
- Deny-list bans images, SVG `<use>`, `staticFile`, fonts beyond Inter.
- No style presets, no example components, no craft rules.
- Checker looks for defects only and never at quality; one repair turn.
- 5-second default canvas; no tie to word timings beyond the anchor words.

### 3. Other agent video editors

- Products (Descript Underlord, Riverside, Kapwing) are chat agents over the
  product's own coarse tools. Descript admits the agent overpromises and costs
  vary per run. Mosaic (YC) moved from chat to saved node graphs: chat was slow
  on long video and creators repeat the same flow.
- video-use (28k stars, Claude Code skill): the model never watches the video;
  it reads a packed word-timed transcript (~12KB), looks at a filmstrip PNG only
  at decision points, writes an EDL, renders, checks every cut boundary, fixes
  up to 3 times. Cuts snap to word boundaries with 30–200ms padding.
- Timeline-Bench (arXiv 2609.35143, Sep 2026), the best evidence:
  - best agent solves 26.8% of 56 real tasks;
  - 73% of failures pass format checks and fail on craft;
  - agents under-cut (0.72× reference pace) and render late;
  - agent self-review fixes pacing/story 5.5% of the time vs 66% of human notes;
  - agents claim full success in 93% of runs, including failed ones;
  - $0.13–$41 per run; a GUI-driving agent did worst.
- Lesson: free agent + raw ffmpeg loses. What works is a text timeline the
  agent edits through checked operations, coarse domain tools, cheap
  perception on demand, and an outside judge for pace and story.

### 4. Harness options

| Option | Verdict |
|---|---|
| Vercel AI SDK `ToolLoopAgent` (`ai`, Apache-2.0, already a dep) | **Pick.** Plain fetch, runs in Bun and Electron main. `stopWhen` (steps, finish tool, budget), `prepareStep` (swap model/tools, trim old images), `toModelOutput` returns images. Durability is ours: Convex job lease + per-step checkpoint. Skip `WorkflowAgent` (needs Workflow DevKit compiler). Upgrade from 7.0.2 first. |
| Mastra (`@mastra/core`, already used by outline v2) | Fallback. Durable agents, suspend/resume, workspaces. Heavy for Electron, ~10 minor releases a month, npm org compromised twice in 2026: pin exact versions. |
| OpenAI Agents SDK JS | Second layer over the AI SDK for non-OpenAI models; pre-1.0. No. |
| LangGraph.js | Best checkpointing, but pulls in LangChain core; a free-form loop needs no graph. No. |
| Pi (`@earendil-works/pi-*`, MIT) | Small loop; `pi-durable` matches our durability needs but is "experimental". Watch. |
| Claude Agent SDK | Anthropic commercial terms, Claude only, spawns Claude Code. Fails provider-agnostic. |
| Codex / OpenCode SDKs | Coding agents for repos via a sidecar process; wrong shape for timeline tools. |

Risk: image tool results through OpenRouter depend on the upstream model.
Test the Claude, GPT and Gemini slugs we would use; fall back to putting the
image in a user message via `prepareStep`.

### 5. Sandbox

Keep one fresh Docker container per render, network off. Swap the deny-list
for an allow-list: Remotion's dynamic-compilation pattern passes code as input
props and injects only allowed APIs, plus a read-only, pre-staged asset folder
(fonts, icons, brand kit, Lottie). Cloud sandbox vendors (E2B, Vercel Sandbox)
add cost and a dependency for no gain on our VPS.

## Recommendation

1. **Harness:** AI SDK `ToolLoopAgent` in `src/video/agent/`, model
   from an injected factory over OpenRouter. Same module in the worker and the
   desktop local engine, like `editor/jobs.ts` today.
2. **Shape:** not a free agent. Keep the current stages as coarse tools and the
   EditDoc as the single source of truth:
   - read: `get_index`, `search_transcript`, `get_timeline`
   - edit: `apply_ops` (typed ops, validated, word-snapped in code)
   - stages: `plan_story`, `find_retakes`, `plan_text`, `plan_broll`,
     `plan_graphics`
   - look: `render_stills(times)`, `filmstrip(range)`, `check_timeline`
     (deterministic pace/defect metrics)
   - graphics: `make_graphic` (runs the graphics sub-agent below)
   - `finish(summary)`

   Caps: steps, dollars, render rounds. Pace and story judged in code or by a
   validated judge, never by the agent's own "done".
3. **Graphics first** (largest visible gain, smallest risk): a graphics
   sub-agent with director → builder split, style presets, a block library,
   per-type craft guidance from `remotion-dev/skills`, staged assets, and a
   render → contact sheet → targeted edit loop (3–4 rounds). Layout gates in
   code, including a face keep-out zone.

## Open questions

- Remotion license: automation in a paid product needs a Remotion company
  license; check terms before scaling. HyperFrames (HTML + GSAP) is an
  alternative renderer worth a short spike; check its license.
- Cost per edit with a loop: Timeline-Bench's best agent averaged ~$10 per run.
  Needs a budget per tier.
- Desktop: graphics still need Docker locally, or route them to the cloud.

## Addendum (same day): follow-up questions

### Timeline-Bench leaderboard (timelinebench.tensortest.com, 19 setups)

The paper's best (GPT-6 Astra in Codex, 26.8%) is no longer top. Now:
Claude Code + Opus 5.5 32.1% (18/56). Same model across harnesses:
GPT-6 Astra Codex 21.4% = OpenCode 21.4%; Fable 5.1 Claude Code 17.9% =
OpenCode 17.9%; Opus 5 Claude Code 23.2% vs OpenCode 17.9%. 95% intervals are
~±13 points (56 tasks). Model matters more than harness. Every setup is a
coding agent (shell, files, code); the one GUI agent scored 3.6%.

This weakens the plain AI SDK pick: it has no shell, files, skills, context
compaction or sub-agents; we would rebuild them.

### Revised shape: harness behind a port

- Tools: one MCP server of ours (EditDoc ops, render stills, filmstrip, checks,
  graphics render). Claude Agent SDK, OpenCode, Codex and Pi all speak MCP.
- Craft: skills (`SKILL.md` + helpers), a format the same harnesses load.
- State: a per-job workspace (packed transcript, EditDoc JSON, renders); the
  harness holds nothing we need.
- Core: one `AgentRunner` port; one adapter per harness. First adapter Claude
  Agent SDK (top score), second OpenCode or Pi to prove the switch. Same eval
  set on each.
- Claude Agent SDK over OpenRouter: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`,
  key in `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""`. Guaranteed with
  Anthropic models only. SDK is under Anthropic commercial terms, spawns the
  Claude Code runtime.
- The agent has a shell: run it in a container per job in the cloud.

### video-use (browser-use/video-use)

MIT, 28k stars. A skill: `SKILL.md` + Python helpers (`transcribe`,
`pack_transcripts`, `timeline_view`, `render`, `grade`). Runs under any
harness with skills and a shell. Gaps: ElevenLabs Scribe transcription (we
use AssemblyAI), output is `final.mp4` via ffmpeg, not an EditDoc the desktop
timeline can open; waits for chat approval. Use: vendor its helpers and
rules as our starting skill; swap transcribe and the output step.

### Renderer licenses

- Remotion: free for individuals and companies up to 3 people, automation
  included. At 4+: Automators plan, $0.01/render, $100/month minimum.
- remocn: MIT, but it is a component library for Remotion; Remotion's license
  still applies.
- HyperFrames: Apache-2.0, no per-render fees. Plain HTML; animation adapters
  for GSAP, CSS, WAAPI, Anime.js, Lottie, Three.js. video-use already supports
  it.
- GSAP: free for commercial use; bans use in no-code visual animation builders
  that compete with Webflow. AI-written GSAP code is explicitly allowed. Our
  props form is not an animation builder, but CSS/WAAPI avoid the question.
- Motion Canvas (MIT, 19k stars) and Revideo (MIT, 4k) exist; less agent
  tooling, last pushes Jul 2026.
