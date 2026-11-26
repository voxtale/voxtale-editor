# Spike 4 — OTIO rough cut into DaVinci Resolve

Beads: super-tale-x1so.4. Plan: `docs/agentic-video-editor-plan.md` §8 Export,
P7. Tested 2026-09-30 on Resolve 21.0.2 (free), macOS.

## Verdict: go, with a file hand-off

A plain OTIO JSON file, written by our own TS code (no OTIO library), imports
into Resolve Free with the right tracks, cuts, timing, audio, markers and
linked original media. The ProRes 4444 graphic keeps its alpha. Resolve's
render matches FFmpeg references.

Free Resolve does not accept outside scripts, so the app cannot push the
timeline in. The hand-off is a file the creator imports (File → Import →
Timeline), with an optional Resolve script for one click.

## Test timeline

Written by `toOtio()` (session scratchpad `spike4/otio.ts`), 30 fps:

| Track | Content |
|---|---|
| V1 A-roll | Talking head (1080p60): 20–26 s → 0, 40–47 s → 6, 80–84 s → 13 |
| V2 B-roll | Screen recording (1512×982, 60 fps) 420–424 s → 6.5 |
| V3 Graphics | `graphic.mov` (ProRes 4444, spike 3) 0–6 s → 10 |
| A1 | A-roll audio, same cuts |
| Markers | Intro @ 0, Costs @ 6 |

Source ranges use each file's own rate (60), timeline 30; gaps filled with
`Gap.1`.

## Results

| Check | Result |
|---|---|
| Import, `file://` URL refs | **Fails.** Resolve can't resolve the URL, scans the whole folder tree for the clip (minutes on `~/Movies`), then gives up |
| Import, plain absolute paths | Works, `Clip.1` and `Clip.2` alike, ~1 s |
| Tracks and names | 3 video + 1 audio, our names kept |
| Timing | Every item start, end and source offset exact to the frame |
| Media | All items link to the original files (60 fps sources in a 30 fps timeline) |
| Markers | Both, at the right frames |
| Render (H.264, 1080p30) | 17.0 s, audio 17.07 s |
| Frame at 3 s vs FFmpeg reference | 52 dB PSNR |
| Graphic over A-roll at 12 s vs FFmpeg overlay | 43 dB — alpha correct |
| B-roll at 8 s | Same picture; Resolve fits the 1512×982 clip and shows V1 in the side bars (my reference padded black) |

## Findings

- **Paths, not URLs.** Write `target_url` as a plain absolute path on the
  creator's machine. File URLs fail slowly.
- **No outside scripting on the free edition.** `scriptapp("Resolve")`
  returns nothing from Python or `fuscript`. Scripts placed in
  `…/Fusion/Scripts/Utility/` run from Workspace → Scripts and have the full
  API (import, render). Resolve Studio allows outside scripting; don't depend
  on it.
- **Source timecode.** Resolve links clips by timecode extents. Our test files
  start at 0. Camera files with a start timecode need
  `available_range.start_time` (and source ranges) offset by it, or linking
  fails ("timecode extents do not match"). The desktop reads the start
  timecode at ingest (FFprobe `timecode` tag) and the writer adds it.
- **Smaller clips on upper tracks** are fitted, not padded: the track below
  shows through. The desktop editor must do the same, or B-roll smaller than
  the frame looks different in Resolve. Decide in P7; record the choice in
  the export.
- **What OTIO carries:** cuts, tracks, gaps, markers, clip names, metadata.
  Not zoom keyframes, text styles, audio levels or transitions. Zooms and text
  go as baked clips or as a list for the creator; captions go as SRT.
- The writer is ~100 lines of pure TS: it belongs in `@voxtale/editdoc` as
  `toOtio()`.

## Changes to the plan

- §8 Export: Resolve package = `.otio` with plain paths + alpha ProRes
  graphics + SRT + reference MP4 + a `VoxTale Import.lua` Utility script. No
  live link to Resolve.
- P7: timecode offset at ingest; fit-vs-fill rule shared by editor and export.
- P1: `toOtio()` moves into `packages/editdoc` with tests.

Scripts: session scratchpad `spike4/` (`otio.ts`, `variants.ts`, Lua runner);
`otio.ts` moves into the package in P1.
