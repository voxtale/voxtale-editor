# VoxTale editor

A local video editor any agent can drive. It runs as an MCP server over
stdio (Claude Code, Codex, Cursor or any MCP client) against a folder of
clips on your machine. No account, no cloud service, no web app.

> **Private.** Some code and prompt text here was copied from REDACTED and
> carries a `// from REDACTED <file>` mark (see
> `src/video/editor/agent/THIRD_PARTY_NOTICES.md`). Replace every marked
> part before any public release.

## Quick start

```sh
bun install
bun run mcp            # stdio MCP server: bun apps/editor-mcp/src/main.ts
```

Client setup, ffmpeg and face-finder notes: [apps/editor-mcp/README.md](apps/editor-mcp/README.md).
Staged CLI workflow: [docs/usage.md](docs/usage.md).

## Layout

| Path | What |
|---|---|
| `src/` | Core package `voxtale-editor` (entrypoints in `src/package.json`; `voxtale-editor/mcp` is the server) |
| `src/video/` | Edit model, media/ffmpeg, transcript, beats, sfx, looks, render |
| `src/video/editor/` | Editor jobs, agent tools, rules, checks |
| `src/video/editor/agent/` | Agent tools, skill prompt, Remotion and HyperFrames renderers, sandbox images |
| `src/video/editor/local-mcp/` | The stdio MCP server |
| `src/video/graphics/` | Graphics planning and sandboxed render |
| `src/services/prompts.ts` | Versioned prompt registry |
| `src/native/` | Face finder bridge (Python via `.venv` or `uv`) |
| `packages/editdoc` | `@voxtale/editdoc`: edit document types, validation, exports (OTIO, FCPXML) |
| `packages/frames` | `@voxtale/frames`: filmstrips, frames, voice checks from local files |
| `apps/editor-mcp` | The MCP server entry and bundled fonts |
| `voxtale_native/` | Python face finder (OpenCV YuNet) and subject mask (U2-Net-p, for text behind the speaker); `models/` holds the models |
| `tests/` | Unit tests (`bun test tests`) |
| `bench/agenticvbench/` | Bench harness scripts only (no results, no media) |
| `docs/` | Design notes, research, REDACTED comparisons |

## Develop

```sh
bun run typecheck
bun test tests                     # no network, no paid calls
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # optional face finder
tools/fetch-subject-model.sh                                         # optional subject mask (text behind the speaker)
```

## Environment

| Variable | Use |
|---|---|
| `OPENROUTER_API_KEY` | Optional, recommended: footage labels at `open` (Gemini, best on video), CLI planning stages, cloud jobs; paid |
| `VOXTALE_EDITOR_VISION` | Who labels footage: `openrouter` (default with a key) or `harness` (default without: the agent labels via `label_footage` / `save_labels`, no server model call) |
| `VIDEO_INDEX_MODEL` | OpenRouter vision model for labels; default `google/gemini-3.8-flash` |
| `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_REGION` | Transcription; paid |
| `VOXTALE_EDITOR_FFMPEG`, `VOXTALE_EDITOR_FFPROBE` | ffmpeg paths (old `SUPERTALE_*` names still work) |
| `VOXTALE_EDITOR_PYTHON`, `VOXTALE_EDITOR_UV` | Face finder interpreter / uv binary |
| `VOXTALE_EDITOR_PROMPTS` | Prompt version override, `id=N,...` (internal experiments) |

## History

Moved out of the VoxTale monorepo (`super-tale`) on 2026-11-26 from commit
`a0792c81`. Code comments citing `bd super-tale-…` refer to issues in that
repo.
