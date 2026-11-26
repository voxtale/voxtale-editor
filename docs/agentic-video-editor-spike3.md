# Spike 3 — Opus 5.5 graphic → sandbox → alpha clip → editor

Beads: super-tale-x1so.3. Plan: `docs/agentic-video-editor-plan.md` §5.
Tested 2026-09-30. Code kept for P5 in `src/video/graphics/`
(`gate.ts`, `sandbox/`, `spike-gen.ts`).

## Verdict: go

Opus 5.5 writes usable Remotion graphics against our kit. A locked Docker
container renders them to VP9 alpha WebM with no network. The clip plays over
footage in both the editor preview and the export. New data re-renders with no
model call.

## Flow tested

1. **Request**: purpose, data, spoken words, canvas, placement, style tokens.
2. **Opus 5.5** (`anthropic/claude-opus-5.5`, OpenRouter) gets the kit source
   and rules. Returns one TSX module exporting `schema` (zod), `defaultProps`,
   and a default component. All visible text and numbers come from props.
3. **Gate** (`gate.ts`, TypeScript AST): imports only `react`, `remotion`,
   `./kit`; bans network, file, process, eval, timers, `Date`, `Math.random`,
   media tags, URL-like strings, `constructor`/`prototype` chains; checks the
   three exports.
4. **Sandbox render**: `docker run --network none --read-only`, tmpfs `/tmp`,
   2 GB RAM, 2 CPUs, 512 pids, all capabilities dropped, non-root user.
   Bundle + stills + `codec: vp9`, `pixelFormat: yuva420p`. ProRes 4444 `.mov`
   on request (for Resolve).
5. **Perceiver** (Gemini Flash) on 3 stills: defect questions only. Major
   defect → one repair turn to Opus with the defect list.

## Results

| Step | Result |
|---|---|
| Opus write | 18–22 s, ~$0.06 per turn (4.5k in, 2.1k out) |
| Gate | Generated code passed first time. Hostile samples blocked: `node:fs` import, `fetch`, `(0,eval)`, `globalThis`, `<img src=https…>`, CSS `url()`, `({}).constructor.constructor` |
| Sandbox render | 6 s for 3 stills; 20–31 s for a 4–6 s 1080p clip on 2 CPUs; bundle 3.6 s |
| Alpha | `alpha_mode=1`; 94% of pixels fully clear, edges and shadows partial |
| Repair loop | First draft rendered "8 of the time" (dropped `%`); perceiver caught it; repair fixed it |
| Props re-render | New title, bars and note; computed share (44%) correct; no model call |
| Editor export | Graphic over A-roll at the right time; panel area within ~6/255 of an FFmpeg reference composite (colour conversion), footage outside the panel identical |
| Editor preview | Shows the graphic with correct transparency after adding `alpha: true` to every `CanvasSink` (10 sites, `voxtale-desktop` `spike/1`) |
| Total per graphic | ~$0.13 with one repair; about 1.5 min |

## Findings

- **The gate is a filter, not the wall.** A static check can't stop every
  trick (string-built property names). The container is the security
  boundary: no network, read-only root, capped resources, fresh per job.
  Keep both.
- **Perceiver too strict on contrast.** It called a muted grey footnote
  "illegible" (major) on both attempts, so the job ended "failed" on a good
  graphic. Fix: compute text contrast in code (sample text vs panel colour)
  and keep the perceiver to cut-off text, overlap, empty frames and wrong
  data. Contrast as a code check, not a model question.
- **Kit works.** Opus used `Stage`, `Panel`, `Heading`, `Bar`, `CountUp`,
  `useEnter`/`useExit`, `useUnit` without prompting. Shared look across
  graphics comes from the kit, not the prompt.
- **Webpack cache** warns on the read-only root; harmless. Point cache at
  `/tmp` in P5.
- **Editor bugs seen:** total duration shows `00:00:00` after MCP edits
  (x1so.12); WebM thumbnail shows black (alpha thumbnail on dark card —
  draw on a checker background).
- Opus model cost ~$0.06 per turn; Remotion automation licence adds per-render
  fees (plan §5).

## Changes to the plan

- §5 step 4: contrast checked by code; perceiver asks defect questions only.
- §5: container flags above are the render-box baseline.
