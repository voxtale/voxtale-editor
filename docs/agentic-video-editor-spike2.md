# Spike 2 — Footage index with Gemini

Beads: super-tale-x1so.2 (and .14, shot detection). Plan:
`docs/agentic-video-editor-plan.md` §2. Tested 2026-09-30 through OpenRouter.

## Verdict: go, with a changed design

Gemini is good at saying *what* is on screen and bad at saying *when*. So our
code owns time and Gemini only labels spans we cut ourselves:

1. Shot cuts from our detector, long shots split into ≤20 s chunks → segments
   with fixed IDs (`S01…`).
2. Per segment: 2 stills (30% and 70% of the span; 1 still under 2 s) plus the
   AssemblyAI words spoken in it.
3. One Gemini Flash call per ~40 segments returns JSON by segment ID. We merge
   by ID and keep our own start/end.

No video goes to Gemini. The desktop uploads audio and small JPEG stills, not a
proxy.

## Footage

| Clip | Kind | Length | Our cuts |
|---|---|---|---|
| 1 | Screen recording, 1512×982, 60 fps | 14.1 min | 56 |
| 2 | Talking head, 1080p, 60 fps | 5.8 min | 0 |
| 3 | Vertical talking head, red light, 25 fps | 3.0 min | 0 |

## Route: whole video to Gemini (rejected)

OpenRouter passes video as a `video_url` data URL. It works, with limits:

- **20 MB request cap** (AI Studio returns 413). A 14-minute 540p proxy is
  49 MB, so long clips need windows of ≤ ~14 MB raw media. Some large requests
  routed to another Google provider and timed out (504).
- **Timestamps drift.** One 14-minute call: segment times up to 60% late.
  5.8-minute call: median error 0.5 s, 5 of 6 within 1 s — fine for short
  clips, not something to build on.
- **Burned-in timecode does not fix it.** 5 fps windows with a drawn clock:
  visual descriptions at segment midpoints right about 5 of 12 times, shifted
  by about a minute; speech placed ~69 s off. Gemini Pro ignored the clock and
  returned window-relative times.
- Agreement with the stills run (same app on screen, second by second over
  290–590 s of clip 1): Flash with timecode 42%, Pro 66%.

## Route: our segments + stills (chosen)

| Run | Segments | Returned | Cost | Time | Stills size |
|---|---|---|---|---|---|
| Clip 1, 290–590 s, 768 px | 39 | 39 | $0.089 | 64 s | 3.5 MB |
| Clip 1, 290–590 s, 512 px | 39 | 39 | $0.086 | 64 s | 1.9 MB |
| Clip 2, whole, 768 px | 18 | 18 | $0.042 | 25 s | 0.6 MB |
| Clip 3, whole, 512 px | 10 | 10 | $0.022 | 20 s | 0.2 MB |

- **Timing:** exact by construction.
- **Descriptions:** checked against midpoint frames on clip 1; app and page
  names right ("ScreenshotOne homepage", "Starwind UI landing page", "Ableton
  Live arrangement"). Talking-head segments get useful `mustShow` lines drawn
  from the words ("statement on needing to be a daily user of the product").
- **Image size:** 512 px and 768 px bill the same tokens (~1,000 per image).
  Use 512 px: half the upload, same result.
- **Cost:** ~$0.43/hour for talking head, ~$1.05/hour for busy screen
  recordings (more cuts → more stills). Cap stills per minute if needed.
- Gemini Flash (`google/gemini-3.8-flash`). Pro was no better at the part
  that matters and costs ~3×.

## Shot detection (x1so.14)

`packages/editdoc/src/shots.ts`: TS port of `voxtale_native/video_pacing`
(HSV 8×8×8 histogram, correlation < 0.75, min shot 0.5 s). Fed every frame
from FFmpeg (`scale=96:54`, `rgb24`), so cuts land on exact frames.

- Matches the Python detector on all three clips (Python samples fewer frames;
  every Python cut has a TS cut within one sample step).
- 14-minute 60 fps file: 15 s on an M-series Mac, one histogram in memory.
- Clip 3 had a camera move into black that neither detector calls a cut. The
  20 s split covers it; a fade detector can come later.

## Privacy

Stills and audio go to Google (Gemini) and AssemblyAI through our pipeline.
Originals and video proxies do not leave the machine for indexing. Privacy
copy must say so, and the delete path must cover R2 stills.

## Changes to the plan

- §2 rewritten to the stills route (done with this doc).
- Desktop ingest: shots + segment list + 512 px stills + audio. No proxy
  upload until cloud render (P7).
- `ClipIndex.segments[].start/end` come from our segments; Gemini output
  without a known ID is dropped, missing IDs are retried once.

Scripts: session scratchpad `spike2/` (`shots.ts`, `stills.ts`, `index.ts`,
`score.py`); not kept.
