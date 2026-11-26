# AgenticVBench: does it help test our editor and REDACTED?

Date: 2026-11-23. Read-only research. Sources: agenticvbench.com (home,
/tasks, /leaderboard), arXiv 2605.27705 (v1, 26 May 2026, Philo Labs), and
github.com/PhiloLabs/agentic-vbench (shallow clone, read, not run). Nothing
was installed, run or paid for.

## Verdict (one screen)

**Borrow parts, do not adopt.** AgenticVBench tests coding agents (Claude
Code, Codex, OpenCode) that edit with ffmpeg in a Linux sandbox and write a
file to `/workspace/output`. It does not test editing mechanics as such, and
it cannot drive a closed desktop app.

- **Skip:** Repair, the new Understanding family, the Harbor harness and the
  leaderboard. They test signal repair and video Q&A.
- **"Our editor"** in this doc = the editor tools + MCP core
  (`src/supertale/video/editor/agent/` tools; `local-mcp/` and the cloud
  planner share them), driven by any agent harness: local Claude Code via
  `apps/editor-mcp`, or the cloud worker. The bench runs the local harness.
  One harness difference matters here: the cloud path labels footage at
  `open`, the local one does not (next bullet but two).
- **Use: 15 tasks** (§6), same brief to REDACTED (by hand) and our editor:
  - **Repurpose `ted`, `comedy-knead`.** Each ships a brief, a binary
    rubric (22 and 32 items) and a `judge.py` that scores **any MP4**,
    whatever made it. They hit seams, captions, open/close, end card and
    cut types. Kept at two: the only family that costs money.
  - **Sequencing, 9 tasks: 5 on both tools, 4 REDACTED only.** Put
    shuffled clips in order. Free local scorer. Our editor orders clips via
    `set_cut`, which needs spoken words. A speech check (2026-11-24) found a
    wordless clip in 4 of the 8 picks; one spare passed (§6).
  - **Assembly, 4 tasks, REDACTED only.** Pick the right shot per slot.
    Our editor cannot take it: the clips are silent and every placement
    tool anchors on a spoken word. That limit is in the core, so it holds
    for both harnesses.
- **Clip labels (the harness difference):** the cloud worker runs the
  vision labeller (`video/footage-index.ts`, plus moments) at `open`, so
  `find_footage` and `screen_activity` are there. The local MCP `open` only
  transcribes and hides both tools (`local-mcp/guide.ts` says so). On the
  bench the agent knows clips only by transcript and `timeline_view` frames
  (§6).
- **Judge cost** (§7): ≈ $1–1.5 per Repurpose run, $0 for the other two
  families. All of it ≈ $5; ≈ $10 with one re-judge each.
- **Borrow ideas:** the rubric style (binary, one defect per item, a check
  written next to each item, deterministic where it can be, penalty items)
  and a handful of items that hit our mechanics: no mid-word cuts, caption
  sync within ±0.3 s, captions legible, open on substance, close on a
  landing, no padding, no off-topic cutaways.
- **What it misses:** J/L cuts, punch-ins, zoom/pan, motion graphics, style
  presets, retake and filler cleanup, pacing tightness. Several talk briefs
  even forbid added graphics and B-roll. Our REDACTED sessions S2–S5 and S7
  stay as planned; the benchmark has nothing to replace them.

**Change to the REDACTED plan (done):** (1) S1, S2 and S6 now carry a
**Grade** step with the borrowed pass/fail checks (list in §4), run the same
way on REDACTED and on our editor. (2) New optional block **B1–B15** after
S7: ≈ 4 h of trial time on REDACTED; our side ≈ 2 h 25 min any time later. S1–S7 are otherwise unchanged. B1–B2 judges call Claude
Opus and Gemini 3.1 Pro, so they cost API money: needs your OK.

## Component table

| Component | What it is | Run on our editor? | Run on REDACTED? | Tests our mechanics? | Effort | Call |
|---|---|---|---|---|---|---|
| Assembly (18) | Pick the right shot per storyboard slot from 1 real + 2 AI fakes that differ in shot size, angle, lens or camera move. Output MP4 + `solution.json`. Local SSIM + match scorer, free. | **No.** Clips are silent; `set_cut` and `show_footage` anchor on spoken words. Would need a whole-clip placement tool | Yes, by hand: import clips, paste storyboard, export, write `solution.json` from the timeline | Weakly: shot grammar (push-in, dolly, shot size) | 10 min per task | **Use 4, REDACTED only** |
| Sequencing (28) | Put shuffled clips back in story order. Output MP4 + `solution.json`. Local scorer, free: (1 − ND) × LIS × ADJ. | Only when every clip has speech: open each as `talk`, order with one `set_cut`, script turns `edit.json` into `solution.json` | Yes, same as Assembly | Partly: reading speech and story across cuts | 15 min per task per tool | **Use 8 speech-led** |
| Repair (18) | Fix one defect in one window: audio (noise, echo, muffled), visual (colour, blur), timeline (repeated frames, out-of-order shots, fillers, wrong line). Scored by PSNR/SSIM/speech metrics vs. the clean original. | Only the filler/repeat items, and they are scored as pixel and signal match, not edit quality | No | Barely (filler cut) | — | Skip |
| Repurpose (36) | Long source (4 min–3 h) → short cut to a brief (runtime, aspect, captions, story beats, tone). Output `repurpose.mp4`. | Yes, outside Harbor: in Claude Code, `open` source as `talk`, cut, `render`, run judge. Exact runtime may need an ffmpeg trim | Yes, by hand: give brief in chat, export MP4, run judge | Partly: seams, captions, open/close, padding, reframe. Mostly story and clip choice | Judge setup ~half a day; then ~35 min per task per tool | **Use 2 (`ted`, `comedy-knead`)** |
| Repurpose rubrics | 1,137 binary items (~32 per task): format 144, visual 388, story 320, sound 243, penalty 42. Each item has criterion, why, check, judge type. | n/a | n/a | Some items (see §4) | Copy by hand | **Borrow** |
| Judges | Deterministic (196 items: ffprobe, silencedetect); Claude Opus 4.7 vision at 1 fps (626); Gemini 3.1 Pro audio (290) and video (25). | Same | Same | — | Needs `ANTHROPIC_API_KEY` + `GEMINI_API_KEY`; ≈ $1–1.5 per run (§7) | Use with the tasks above |
| Understanding (27) | Community add-on: long video + one question, JSON answer, deterministic scorer (counts, timelines). | No | No | No | — | Skip |
| Harbor harness + `./avb` | Docker/Modal sandbox, agent gets shell + ffmpeg + Whisper, 30 min, 200 turns. Adapters for claude-code, codex, gemini-cli, opencode. | Possible via a custom Harbor adapter: container must hold Claude Code, Bun, the editor MCP, Chrome for HyperFrames, AssemblyAI key. 2–4 days. Not needed: running Claude Code by hand is cheaper | No: GUI, macOS, chat only, no API | — | High | Skip |
| Leaderboard | 23 model+harness rows; best 38.4% (GPT-5.6-sol/Codex), Claude Fable 5/Claude Code 32.4%, humans 88.5%. No commercial editors listed. | We could submit, but it would rank our harness, not our product | No | — | Full 100-task run; paper put the full matrix at ~$7.5k | Skip |
| Licence / data | Code Apache-2.0, paper CC BY 4.0. Footage: films, TED, sports broadcasts, no data licence stated; paper says some sources cannot be redistributed. Repurpose set 18.6 GB; per task 8 MB–4.7 GB. | Fine for internal tests | Same | — | Download only the 14 tasks used (≈ 0.36 GB) | Internal use only |

## Detail

### 1. What the benchmark is

100 tasks in four families, written by 20 working editors (avg. 6 years).
Each task is a Harbor task folder: `steps/solve/instruction.md` (the brief),
a Dockerfile that bakes the source from Hugging Face, and
`steps/solve/tests/` (judge). Agents get no editing tools: they get a shell
with ffmpeg, Python and a cached Whisper model. Trajectories show agents
writing ffmpeg and OpenCV scripts.

Scores: humans 88.5% average; best agent 38.4%. The paper's point is that
coding agents with ffmpeg are far from editors. It says nothing about
products built for editing (ours, REDACTED, Descript, CapCut).

### 2. The part worth using: Repurpose judge

`tasks/agentic_vbench_repurpose/<task>/steps/solve/tests/` holds
`rubric.json`, `config.yaml`, `judge.py`, `aggregate.py`, `test.sh`.
`test.sh` copies the MP4 into a work folder and runs
`python3 judge.py <run_dir> <source.mp4> <run_id>`, then `aggregate.py`
writes a 0–1 reward plus a per-item breakdown. Nothing in it needs Harbor.
Python deps: anthropic, google-genai, openai-whisper, librosa, scenedetect,
pytesseract, ImageHash.

Talk-like tasks, closest to creator footage:

| Task | Source | Brief in short |
|---|---|---|
| `talk-tim-urban-procrastinator-ted` | 37 MB | Narrator-led short for TikTok/Shorts |
| `ted` | 95 MB | 75 s LinkedIn reel, Ken Robinson, sound-off viewer |
| `conf-tech` | 117 MB | 75 s 1920×1080 reel, React Conf keynote, 5 speakers, burned captions, end card |
| `standup` | 121 MB | 75 s stand-up highlight |
| `late-night` | 59 MB | 80 s monologue highlight |
| `panel` | 358 MB | 78 s from a 43 min panel, 4 speakers |

Fit problems to know before using it:

- **It tests selection, not craft.** The story pillar (320 items) asks
  "did the reel land the two announcements", "did it open on a striking
  line". That is the long-to-shorts feature, which the user ranks below
  editing mechanics.
- **Third-party footage.** Clean, single-take stage talks. No retakes,
  false starts or dead air, so smart clean and pacing never show up.
- **Strict format.** Runtime within ±0.1 s, exact resolution, h264,
  stereo. Our editor's `render` takes its size from the talk clip and its
  length from the cut; `open` takes a `target` but nothing forces ±0.1 s.
  Trim with ffmpeg after render and log the miss.
- **LLM judges with no stated agreement figure** for the VLM grader (the
  paper gives human-to-human agreement, 96–98%). Treat a small score gap as
  noise; read the per-item breakdown, not the total.
- **Leaderboard grader may differ.** The site says the leaderboard grader is
  withheld; the repo judge is the public one. Fine for comparing two tools
  on the same judge.

### 3. REDACTED

No API and not an MCP server (it says so). Harbor cannot run it. The only
path is by hand: open the source in REDACTED, paste the brief into chat,
let it run, export MP4, score with `judge.py` on our machine. About 30–40
min per task plus judge time. Uses REDACTED agent budget, which the trial
needs for S1–S7, so put it last.

### 4. Checks to fold into the REDACTED sessions

Now folded into the plan as **Grade** steps in S1, S2 and S6. Run each on
both tools' output. Deterministic ones need only ffprobe, the
transcript and our existing tools; vision ones can stay manual (you watch
and tick).

| Session | Check (from Repurpose rubrics) | How |
|---|---|---|
| S1 Pacing | No seam cuts a word or a laugh (`S-SEAM-QUALITY`, `S-NO-MID-WORD-CUT`) | Cut times vs. word times from transcript; count cuts inside a word |
| S1 Pacing | No jarring level jump at a cut (`S-SEAM-LEVEL`) | Loudness 200 ms each side of every cut |
| S1/S2 | Open on substance within 5 s; close on a landing, not a trail-off (`N-OPENS-ON-SUBSTANCE`, `N-CLOSES-ON-LANDING`) | Watch, tick |
| S2 Cut placement | Same as seam check, plus where in the gap the cut sits | Cut point vs. silence midpoint |
| S3 Cut types | "Cuts read as deliberate: subject continuity, motion match, or a clear jump cut for emphasis" | Watch, tick per join |
| S5 Graphics | End card ≤ 3 s, no padding (`V-TITLECARD-CAP`) | ffprobe + watch |
| S6 Captions | Present on every spoken second; sync within ±0.3 s and ≤ 3 words drift; no line carried past a cut; ≥ 40 px at 1080p, high contrast, inside safe area (`V-01`–`V-03`, `P4-CAPTIONS-ASYNC`) | Caption track times vs. word times; one frame grab per caption for size |
| S6 Transitions | No flash under 3 frames, no dissolve ≥ 1.5 s used as padding | Project file / frame step |

Nothing in the benchmark covers J/L cuts, punch-ins, zoom/pan keyframes,
motion graphic build, variants, or style copying: S3 (beyond the line
above), S4, S5 and S7 keep their own checks.

### 5. If we want a repeatable test of our own editor later

The Repurpose layout (brief + binary rubric + judge that scores an MP4) is a
good shape for an internal eval on creator footage: our own raw clips with
retakes, briefs that ask for J/L cuts or punch-ins, rubric items written per
mechanic. That would be new work, not this benchmark.

### 6. The task set: 2 + 8 + 4

"Our editor" = the editor tools + MCP core: the tools in
`src/supertale/video/editor/agent/`, spoken over MCP by both `local-mcp/`
and the cloud planner (`agent/plan.ts`), which build their job and workspace
through the same `agent/session.ts`. Any agent harness can drive it: local
Claude Code via `apps/editor-mcp`, or the cloud worker. Tool rules (what
`set_cut`, `show_footage` accept) live in the core and are the same in both.

The bench uses the local harness. The one difference that matters: the
cloud path runs vision labelling (`video/footage-index.ts`) and moments at
`open` (`editor/jobs.ts`), so `find_footage` and `screen_activity` are
live; local `open` only transcribes, and `agent/session.ts` hides both
tools when no clip has moments. A cloud run would give the agent clip
labels the local one lacks; for speech-led Sequencing the transcript
carries most of the signal, so the gap there is small.

Moving target: an uncommitted change in the working tree (2026-11-24,
`local-mcp/project.ts` `labelFootage`, `guide.ts`) makes local `open` label
**b-roll and screen** clips too when the server has `OPENROUTER_API_KEY`.
The bench opens every clip as `talk`, so it gets no labels either way, and
no OpenRouter spend. Recheck before day 1.

**What the agent can see and do with clips** (checked in code):

| Exists | Where | Can the agent call it on the local harness? |
|---|---|---|
| Clip labels: a vision model labels each shot segment (description, action, setting, subjects, on-screen text) | `video/footage-index.ts` `indexClip` | **No.** Only the cloud worker builds it (`editor/jobs.ts`). Local `open` only transcribes (AssemblyAI), reads loudness, beats and faces. |
| Moments: every visible change on a clip, described | `video/moments.ts` | **No.** Local `open` builds none. |
| `find_footage` (search labels/moments; rank footage against spoken words), `screen_activity` | `editor/agent/tools.ts` | **No.** `jobTools` hides both when no clip has moments, which is always the case locally. `experiments/agent-editor` does expose `find_footage` over the footage index (builds it via OpenRouter, ≈ 1 cent a clip). |
| `get_transcript` (word ids, retakes, stressed words), `timeline_view` (8 frames + words over any stretch of any clip), `clips` (names, roles, lengths) | `agent/tools.ts`, `local-mcp/server.ts` | Yes. This is all the agent knows about the footage locally. |
| `set_cut`: ordered segments, each a word range of one speaking clip | `agent/tools.ts` | Yes. This is how it orders clips. It needs words: a clip with no speech cannot be placed. |
| `show_footage`: another clip over the voice, 1.5–6 s (b-roll) or ≤ 12 s, starting on a spoken word | `agent/tools.ts` | Yes, but only over speech. |

A clip-labelling tool exists, but only the cloud harness reaches it. What
this means for the benchmark:

- **Sequencing, speech-led tasks: yes.** Open each clip as `talk`; the agent
  reads transcripts, looks with `timeline_view`, orders with one `set_cut`.
  `set_cut` snaps to word edges, so clips get trimmed; the scorer accepts
  trims if `solution.json` gives the real source ranges (it scores order
  only, after an SSIM check per clip). A clip with no words cannot be
  placed, and a missing clip scores zero.
- **Sequencing, silent shots (films, montages): no.**
- **Assembly: no, on either harness.** Its candidates are short silent
  shots, and every placement tool anchors on a spoken word (core). Cloud
  labels would let the agent *find* the right shot but not place it. It
  would need a tool that places whole clips without speech.
  REDACTED only, as a reference.

**Why more tasks.** One Sequencing or Assembly task is a single number with
wide spread; 2 per family cannot tell two tools apart. Their judges are
free, so the cost of more is only footage and time.

| Family | Tasks | Footage | REDACTED | Ours | Judge |
|---|---|---|---|---|---|
| Repurpose (B1–B2) | `ted`, `comedy-knead` | 133 MB | 70 min | 70 min | ≈ $1–1.5 a run |
| Sequencing, both tools (B3–B7) | 5 Immigrant Standup, 17 Calhoun Effect, 14 Altman Musk Trial, 9 63 Up 2019, 8 63 Up 2019 (spare in) | 117 MB | 75 min | 75 min | $0 |
| Sequencing, REDACTED only (B8–B11) | 7 Poverty Trap, 3 Dyson Vacuum, 16 Rabbit Doc, 18 Nuphy Air75 | 107 MB | 60 min | — (a wordless clip each) | $0 |
| Assembly (B12–B15) | 11 (camera moves), 16, 15, 14 (shot size, angle, lens) | 32 MB | 40 min | — | $0 |
| **Total** | 15 tasks | ≈ 0.35 GB (fetched) | ≈ 4 h 05 min | ≈ 2 h 25 min | ≈ $5 |

- **Sequencing picks:** by title, the eight most likely to carry speech in
  every clip, then a free speech check (2026-11-24, `silencedetect` +
  local Whisper `base` word count; `silencedetect` alone could not tell
  speech from music beds). Every clip speaks in 5, 17, 14, 9 and spare 8.
  7 (clip 19), 3 (clip 8), 16 (clip 4) and 18 (11 of 12 clips) have a
  wordless clip: our editor would leave it out and score 0, so they run on
  REDACTED only. Spare 11 failed too (8 wordless clips). Five tasks give a
  thin mean; 8 and 9 come from the same film. More speech-led spares would
  need more downloads.
- **Assembly picks:** the four smallest plus 11 for camera moves. REDACTED
  only, so it says how REDACTED picks shots, not which tool is better.
- **Repurpose stays at two:** it is the only family that costs money.
- **Left out:** Repurpose `conf-tech` (117 MB, like `ted`), `scifi-lie` (one
  transitions item), `talk-tim-urban` (21 of 37 items audio, 16 story);
  the other 19 Sequencing tasks: mostly film or montage shots our editor
  cannot place; 19 (talk, 99 MB) is the one untried spare.

Per task, how to feed each tool, paths and day-1 commands: plan § B1–B15.

### 7. Judge cost

Only B1–B2 cost money. Sequencing and Assembly score locally: $0, however
many we run. Our side also pays AssemblyAI at `open` (≈ 0.4 GB of footage,
well under $1).

Model in `judge.py`: Opus 4.7 at $5/M in, $25/M out (cache read $0.50/M);
images ≈ w×h/750 tokens. Pillar 1 sends ≈ 60–75 frames at 512×288 (≈ 12–15k
tokens); pillar 2 ≈ 9k tokens of 400 px frames plus transcript. Gemini 3.1
Pro assumed at $2/M in, $12/M out (not checked).

| Item kind | Cost per item |
|---|---|
| Deterministic | $0 |
| Opus vision | ≈ $0.08 first call, ≈ $0.02 when the prompt cache hits (up to 6 run in parallel, so several pay full) |
| Gemini audio (≈ 75 s) | ≈ $0.035 |
| Gemini video | ≈ $0.10 |

| Run | Cost |
|---|---|
| B1 `ted`, one MP4 | ≈ $0.9–1.3 |
| B2 `comedy-knead`, one MP4 | ≈ $0.9–1.4 |
| B1 + B2 on both tools (4 MP4s) | ≈ $4–6 |
| Plus one re-judge per MP4 to see noise | ≈ $8–12 |
| B3–B15, any number of runs | $0 |
| Budget with retries | < $15 |

Paper check: Repurpose cost $2,904 across its full matrix, ≈ $3.50 per run
including agent cost, so the judge share fits.

Ways to cut it:

1. **Pillar 0 only** (format, runtime, deterministic seams): $0. Good
   enough to see if both tools even hit the spec.
2. **Drop pillar 2 (story):** 7 of 22 and 7 of 32 items. We do not rank
   story choice here; saves ≈ 30%.
3. **One judge vendor:** route Gemini items to Opus or the reverse in a
   local copy of `judge.py`. Saves a key and a setup step, not much money.
4. **Cheaper model** (e.g. Sonnet 5.5): ≈ 60% less. Scores stop matching
   the paper's, but A vs. B on one judge stays fair.
5. **Fewer frames** (n = 30): halves pillar 1 input.
6. **Keep each pillar's result file;** re-judge only MP4s that changed.

Cheapest useful run: options 1 + 2 + 5 on 4 MP4s ≈ $2–3.
