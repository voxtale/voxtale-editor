# Agent notes: VoxTale editor

Local MCP video editor (see README.md). Standalone: no VoxTale account,
Convex or web code. A web hook-up may come later through the `voxtale-editor`
package entrypoints (`src/package.json`), never by importing app code here.

## Issues

Tracked with **bd (beads)**: `bd ready`, `bd show <id>`, `bd update <id> --claim`, `bd close <id>`.

## Build & test

```sh
bun install
bun run typecheck
bun test tests          # no network, no paid API
```

`OPENROUTER_API_KEY` / `ASSEMBLYAI_API_KEY` in `.env` arm paid calls; bun
auto-loads `.env`. Renders and bench runs cost time and money: run them only
when asked.

## Rules

- Every LLM prompt lives in the versioned registry (`src/services/prompts.ts`);
  versions are append-only. Tests assert wiring via prompt ids, not copy.
- Code or text copied from REDACTED keeps its `// from REDACTED <file>` mark.
  The repo is private; those parts must be replaced before any public release.

## Writing style

Telegraph. Short words, active voice, no filler.
