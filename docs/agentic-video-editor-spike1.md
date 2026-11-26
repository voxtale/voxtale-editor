# Spike 1 — OpenReel as the VoxTale Desktop base

Beads: super-tale-x1so.1. Plan: `docs/agentic-video-editor-plan.md`.
Tested 2026-09-30 on Mac arm64, OpenReel 5f3c85e (v1.0.0-alpha.17 + lockfile),
local repo `~/code/voxtale-desktop`, branch `spike/1`. Windows not tested.

## Verdict: go

OpenReel holds up as the base. The MCP surface can build a real edit from our
cut list, keep our IDs, save and reopen it, and export it at 7–8× real time
with frame-accurate video. Every problem found is either a small patch or
something the adapter works around. None needs a rewrite.

## What was tested

Real footage: OwnPod A-roll (1620×1080, 126 s), B-roll screen capture, a
14.3-minute 60 fps camera file. Edit built from
`data/video/ownpod-v5/takes/edit.json` over MCP (`127.0.0.1:<port>/mcp`,
Bearer token).

| Check | Result |
|---|---|
| Build (install, wasm, ffmpeg fetch, desktop build) | Works. FFmpeg 7.1 GPL arm64, sha checked |
| Import over localhost URL | 187 MB in 2.5 s; 644 MB in 3.9 s |
| Cut list as one `batch_actions` (17 actions) | 66 ms. Our clip IDs kept. Duration 96.642 s matches the module |
| B-roll cutaways, muted | Render; `volume: 0` holds |
| SRT captions (`import_srt`) mapped to output time | Render at right times |
| Zoom keyframes (`scale.x`/`scale.y`, clip-local time) | Render |
| Save → reopen | IDs, in/out, 4 keyframes, B-roll volume survive |
| Export 96.6 s | 12.9 s (7.5× real time), 13 Mbps, 157 MB |
| Export 14.3 min 60 fps | 105 s (8.2× real time), 1.29 GB; renderer peak 419 MB |
| Video sync | Within 1 frame at 2, 10, 14 min and across every cut |
| Audio sync | Constant 44 ms late, no drift (bug 1) |
| Transparent overlay (VP9 alpha WebM) | Black box in export until patched; correct after (bug 2) |
| Transparent overlay (ProRes 4444) | Export fails: "Video load failed" (bug 3) |
| Preview of alpha overlay | Not verified (see open items) |

## Bugs and gaps

1. **Audio 44 ms late in every export.** AAC encoder priming (2112 samples at
   48 kHz = 44.0 ms) is left in the stream and Mediabunny 1.25.3 writes no
   `edts`/`elst` box to tell players to skip it. Same path serves the UI's
   default MP4 export, so all OpenReel users get this. Fix: write an edit
   list, or drop the priming samples before muxing. Under the lip-sync
   tolerance most viewers notice, but it stacks with anything else late.
2. **Alpha dropped when decoding overlays.** `ExportFrameDecoder` builds
   `CanvasSink` without `alpha: true`, so clear pixels come out black.
   One-line patch in `packages/core/src/media/mediabunny-engine.ts` (on
   `spike/1`); after it a 50% red box over A-roll gives (140,16,20) against
   an expected (141,16,19). Five more `CanvasSink` sites (preview, thumbnails)
   still lack it.
3. **No ProRes decode.** Chromium's WebCodecs can't decode ProRes, and export
   fails outright. Consequence for the plan: Remotion graphics ship as **VP9
   alpha WebM**, not ProRes 4444. ProRes stays only for the Resolve hand-off.
4. **Media copied into IndexedDB.** Every import becomes a blob; no path
   links. Fine for the spike, wrong for 50 GB of footage. Needs path-based
   media (read from disk through the main process) before real use.
5. **Loopback fetch blocked and whole body sent over IPC.** Needed
   `OPENREEL_ALLOW_LOCAL_FETCH=1` and a raised 4 GB cap. Goes away with (4).
6. **`clip/trim` wrong duration** when both in and out are set. Adapter uses
   `clip/add` with in/out instead; fix upstream later.
7. **Two keyframe naming schemes** (`scale.x` in the engine,
   `transform.position.y` in the registry). Adapter writes the engine names.
8. **Letterbox default.** `fitMode` defaults to `contain`; 1620×1080 source
   gets side bars. Adapter sets fill per clip from `EditStyle`.
9. **No text track.** Text clips land on a video track. Our fixed track kinds
   need a real text/graphics track or a convention the adapter enforces.
10. **`open_project` needs the autosave slot ID** (`<projectId>-slot-N`), not
    the project ID.
11. **`preview_frame` works only for multicam.** Spike checked frames from
    exported files instead. We will want a frame-grab tool for the agent.

## Keep / cut

| Part | Size | Call | Why |
|---|---|---|---|
| `apps/desktop` | 7.7k | Keep | Electron shell, MCP server, FFmpeg sidecar, file IO |
| `apps/web` editor + `src/desktop` shell | most of 174k | Keep | The renderer; Edit page is the product |
| `apps/web` Motion Design page | part of `motion/` 49k | Cut | Our graphics come from Remotion; hide first, delete once unused |
| `packages/core` | 155k | Keep | Timeline, engine, export. Its `motion/` 50k is threaded through the engine, actions and types — not cheap to cut; leave it |
| `packages/agent` | 52k | Keep, trim later | MCP tools the adapter calls. Cut the `creation-*` tools |
| `packages/ui` | 5.6k | Keep | Shared UI kit |
| `packages/agent-runner` | 1k | Keep | Headless runner, useful for tests |
| `apps/image` + `packages/image-core` | 35k + 4.4k | Cut | Separate image editor, nothing in the video app uses it |
| `apps/studio` + `packages/fxpkg` | 6k + 2.7k | Cut | Effects authoring tool |
| `creation-agent`, `creation-core`, `creation-bindings` | small | Cut | 3D "creation" scenes; not our use |
| `creation-schema` | small | Keep until agent tools trimmed | `packages/agent` imports it |
| `apps/desktop/src/aurora-host` | — | Cut with Motion page | Native renderer for Motion Design previews |

Rebrand list: window title and `OpenReelMark`, app name and bundle ID,
updater feed (`dl.openreel.video` in electron-builder config), crash reporter,
icons. Keep OpenReel's MIT copyright line and license text.

## Changes on `spike/1` (uncommitted)

- `apps/web/src/services/agent/live-host.ts`: import cap 4 GB.
- `packages/core/src/media/mediabunny-engine.ts`: `alpha: true` on the export
  decoder sink.

## Open items (move to x1so.12 / P2)

- Windows build and export.
- Native FFmpeg export path (ProRes/AV1/"Smallest"). Not on our main path:
  both the agent export and the UI's default MP4 use WebCodecs.
- Preview alpha check. MCP has no seek tool and the UI showed 00:00 total
  after MCP edits — check whether the Edit page picks up MCP changes without a
  reload.
- Fix bug 1 and verify with the cross-correlation script
  (`scratchpad/spike1/async.py` pattern: per-cut offset should read 0 ms).
