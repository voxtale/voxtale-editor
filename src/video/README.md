# VoxTale local video editor

Core video module, exposed through the internal CLI, using FFmpeg and Remotion.
`voxtale-editor/video` exports pure edit logic and `runVideoPipeline` with injected
transcription, planner, renderer and output sink. `voxtale-editor/video/local` provides
filesystem and provider adapters. `voxtale-editor/video/editor` is the desktop
editor's rules, API and jobs, shared by the hosted API, the worker and the
desktop's local build (`editor/local.ts`); see
[docs/agentic-video-editor-api.md](../../../docs/agentic-video-editor-api.md).
Rendering is local. AssemblyAI transcribes uploaded audio; OpenRouter plans edits
from the transcript. It does not generate avatars or narration.

## Run it

From the repository root, run `bun install`. Dependencies use the workspace lockfile. Install
FFmpeg if needed (`ffmpeg` and `ffprobe` must be on PATH).

Put `ASSEMBLYAI_API_KEY` and `OPENROUTER_API_KEY` in `.env`. Bun loads `.env` when you run from the repository root.
These are paid API stages; rendering itself makes no model calls.

**To get an automatic first edit:**

```sh
bun run video init --source /absolute/path/recording.mp4 --out edit.json
bun run video produce edit.json --out production-v1
```

Open `production-v1/preview-1/video.mp4`. The command transcribes, selects takes,
adds captions, plans graphics and renders a preview. Each stage writes a plan
and an edit file. `init` alone keeps the whole recording; `preview` alone renders
an existing edit without making new decisions.

**To inspect each stage before continuing:**

```sh
bun run video transcribe edit.json --out transcript.json
bun run video select-takes edit.json --transcript transcript.json --out takes-v1
# Read takes-v1/review.txt and decisions.json; preview the cuts if useful.
bun run video preview takes-v1/edit.json --out cuts-preview-v1
bun run video graphics takes-v1/edit.json --transcript transcript.json --out graphics-v1
bun run video preview graphics-v1/edit.json --out graphics-preview-v1
bun run video render graphics-v1/edit.json --out final-v1
```

Preview renders at 640 pixels wide; render uses the edit's size (1920×1080 by
default). This is a rendered preview, not an interactive timeline editor.

## What the stages do

**Transcribe:** FFmpeg extracts mono 16 kHz FLAC; AssemblyAI returns words with
source timestamps and confidence. The request enables disfluencies to retain
filler words and uses Universal-3.5 Pro with Universal-2 fallback. Files:
`transcript.json` (normalized words in seconds), `.assemblyai.json` (raw result),
and `.state.json` (provider job ID). Repeat the command after a polling failure
to resume the same job. A completed transcript is reused after checking the
source file hash. `ASSEMBLYAI_REGION=eu` selects the EU endpoint.

If submission succeeds but the connection drops before the ID is saved, the
command refuses to submit twice. Find the job in AssemblyAI and resume with:

```sh
bun run video transcribe edit.json --out transcript.json --transcript-id JOB_ID
```

**Select takes:** the LLM compares repeated passages, chooses the more complete
version, and proposes removing inferior takes, abandoned restarts and setup
chatter. Retake/false-start decisions must name a surviving replacement using
word IDs. The code rejects unknown IDs, overlapping cuts and removal of a
selected replacement. It keeps suggestions below 0.85 confidence for review.
This score is the model's estimate, not a calibrated probability.

Selection judges wording and completeness, **not facial expression, vocal energy
or audio quality**. Review the cut before publishing. Unique facts and meaningful
corrections should stay; the model can still make mistakes. No words are rewritten
or synthesized. Long transcript gaps over 1.2 seconds are shortened with 0.2 seconds
of room on either side. Leading/trailing gaps may be removed. Use `--keep-pauses`
to disable this. Short grouped captions come from surviving source words and carry a `sceneId`
so text from a discarded range cannot appear in a kept scene. Manual SRT captions
remain unscoped and follow source time; import captions after the cut stage if
you prefer your own cues.

```sh
bun run video select-takes edit.json --transcript transcript.json --out takes-v2 --keep-pauses --confidence 0.95
```

**Graphics:** a separate LLM pass sees only the kept words. It proposes short
chapter headings, lower-thirds and factual callouts, anchored to word IDs in a
specific scene. Remotion animates their entrance/exit over a 2–5 second window
(clipped to the scene), keeping captions below them. References outside kept
footage, overlaps and clashes with manual scene titles fail validation. Zero
graphics is valid if none would help. This is text/graphic composition, not
image generation or automatic B-roll sourcing.

Both planning stages use `anthropic/claude-sonnet-4.6` through OpenRouter by
default. Set `VIDEO_EDIT_MODEL` or pass `--model` to use another model supporting
strict JSON schema outputs. Each stage saves `response.json`, `plan.json`,
`decisions.json`, `review.txt`, `edit.json` and `stage.json` (input/output hashes,
model and usage, including provider cost when returned). Up to 8,000 selected
words are supported per plan; larger edits must be split into sections.

### Review and rerun a plan

Edit a copy of `plan.json` and apply it without another LLM request:

```sh
bun run video select-takes edit.json --transcript transcript.json --plan reviewed-takes.json --out takes-reviewed
bun run video graphics takes-reviewed/edit.json --transcript transcript.json --plan reviewed-graphics.json --out graphics-reviewed
```

Take-plan word ranges are inclusive. Lower a decision's confidence or remove it
from `removals` to keep that passage. Graphics plans name a scene ID and source
word range. Validation still applies to manual plans. If a model response fails
validation, its `response.json` remains available; extract its `plan` object,
correct it and pass it to `--plan` with a new output folder.

Repeating a stage with identical inputs reuses the saved result. Changed inputs,
prompts, settings or an edited output require a new folder. `produce` resumes
saved stages and skips an already-complete matching preview. A failed render
gets a fresh preview directory on retry. Lock files prevent concurrent submissions;
after a hard process kill, remove the stale lock only once that process has stopped.

The first render downloads Remotion's Chrome Headless Shell. Later renders use
the local browser. To supply a browser, set `VIDEO_BROWSER_EXECUTABLE` to its
executable path. Rendering uses two concurrent frame workers. FFmpeg prepares
clips before Remotion composes graphics, captions, B-roll and audio.

You can also run the package directly:

```sh
bun run editor --help
```

## Edit the scene plan

The JSON file is the edit. Change it in any text editor. Source times are seconds
in the original recording; `out` is exclusive. Scenes play in array order and
may repeat or reorder footage. Cuts round to the nearest output frame.

```json
{
  "version": 1,
  "name": "My first edit",
  "source": "recording.mp4",
  "fps": 30,
  "width": 1920,
  "height": 1080,
  "scenes": [
    {"id": "intro", "in": 1, "out": 8, "title": "What changed", "zoom": 1},
    {
      "id": "example", "in": 10, "out": 18, "zoom": 1.1,
      "title": "The result", "titleStyle": "lower-third",
      "broll": {"path": "result.png", "kind": "image", "fit": "contain"}
    },
    {"id": "close", "in": 21, "out": 26, "title": "Try this next", "titleStyle": "card"}
  ],
  "captions": [{"start": 10.2, "end": 12.4, "text": "Here is the result."}],
  "music": {"path": "music.wav", "volume": 0.1},
  "speechVolume": 1,
  "accent": "#E84860"
}
```

Paths resolve from the edit file, not the shell directory. `init`, `revise` and
caption/cut commands save absolute media paths so the output can move locally.
Media itself stays in its original location; moving to another machine requires
copying media and updating paths. URLs are not accepted.

- **Cuts:** omit unwanted source ranges. The source file never changes.
- **Punch-ins:** `zoom` ranges from 1 to 2, centered on the shot.
- **Graphics:** `titleStyle` is `lower-third` or `card`. Titles stay on for the
  whole scene; split a scene to control when they appear.
- **B-roll:** images or real video clips cover the scene while original speech
  continues. Video B-roll has its own `in` in seconds and must be long enough.
  Its audio is muted. Images receive a small push-in. `fit` is `cover` or `contain`.
- **Captions:** original source timestamps follow cuts automatically. Cues that
  cross cuts are clipped to kept ranges. Use short cues; there is no word-by-word
  animation. The transcription stage generates these captions automatically.
- **Audio:** original audio stays with each kept shot. Music loops at the stated
  volume. There is no automatic ducking, loudness matching or noise cleanup yet.

## EditDoc v2 (desktop format)

Each planning stage also writes `editdoc.json`: the same edit as an EditDoc v2
(`@voxtale/editdoc`, `packages/editdoc`), the multi-clip, fixed-track format
VoxTale Desktop and the cloud agent share. The stage result lands as policy-checked
stage patches: takes as `assembly` (a-roll) then `text` (captions), graphics as
`text` (text track). Provenance records each stage with its prompt versions and model.
`produce` hands the takes doc to the graphics stage, so one doc carries both.

`src/video/editdoc.ts` converts both ways, frame exact:

- `editDocFromEdit` — scenes become a-roll items; titles, graphics and captions
  move to output time; b-roll and music need a `mediaClip` resolver.
- `editFromEditDoc` — back to v1 for the Remotion renderer. Refuses what v1 cannot
  play: several a-roll clips, gaps, voiceover, b-roll that does not span a scene.
- `applyEditStage` — diff a v1 stage result into a doc as stage patches.

`tests-ts/video-editdoc.test.ts` round-trips the saved OwnPod edits
(`data/video/ownpod-v5`, skipped when absent) and checks the same cut, captions
and graphic frames come back.

## Suggest cuts and import captions

```sh
bun run video suggest-cuts /tmp/my-edit/edit.json --out /tmp/my-edit/proposed.json
bun run video captions /tmp/my-edit/proposed.json --srt /path/recording.srt --out /tmp/my-edit/captioned.json
```

The cut proposal detects pauses of at least 0.6 seconds below −35 dB and keeps
0.15 seconds of room at either edge. It intersects these with existing scenes,
preserving their order and settings. Review the proposal before rendering:
quiet speech and intentional pauses can resemble unwanted silence. This does
not identify repeated takes or make AI story decisions. SRT times must match
the original recording, not an already-cut export. JSON captions also work.

## Save revisions

Make a JSON patch containing the fields to replace, then:

```sh
bun run video revise /tmp/my-edit/edit.json --patch /path/changes.json --out /tmp/my-edit/v2.json
bun run video render /tmp/my-edit/v2.json --out /tmp/my-edit/render-v2
```

Top-level fields merge; arrays such as `scenes` replace the entire array. Each
scene needs a unique stable ID. New paths in a patch resolve from the original
edit file. To remove an optional field such as music, edit a copy of the JSON
and remove that field. Unknown fields and invalid ranges fail validation.

Every output directory must be new. It contains:

- `video.mp4`: H.264 video with AAC audio.
- `poster.png`: a frame for quick review.
- `edit.json`: the input snapshot with absolute paths.
- `report.json`: status, elapsed time, edit hash and source-to-output frame map.

Failures and cancellation leave a failure report, and may leave a partial MP4.
Only a report with `status: complete` marks a finished render. Start a retry in
a new output directory. The current implementation rerenders all scenes; it
has no resumable asset cache. Temporary clips and browser bundles are cleaned
up when the process exits normally or handles Ctrl-C.

## Checks

```sh
bun run typecheck
bun test tests-ts/video-*.test.ts
VIDEO_RENDER_TEST=1 bun test tests-ts/video-render.integration.test.ts
```

The render test uses synthetic footage and distinct audio tones to check that
cuts preserve audio timing, then renders image/video B-roll, graphics, captions,
music and a new revision. It checks that existing output cannot be overwritten.
Unit tests cover take/graphic plan validation and resuming provider jobs. A live
AssemblyAI + OpenRouter smoke test also selected a deliberate retake and rendered
a timed callout. Synthetic fixtures test the workflow; they do not establish edit
quality on a person's recording. Inspect your own footage before relying on the result.

No worker or website integration is part of this package. Automatic B-roll sourcing,
visual performance scoring and generated media remain out of scope.
Remotion's [license](https://www.remotion.dev/license) applies to its dependencies.

Take selection now supplies exact repeat candidates (words and phrases), then
audits retained speech in a second model pass for missed restarts and sentence
retakes. Candidates never cause cuts on their own. Each decision names its kept
replacement. Review `review.txt`, `retained-transcript.json`, and
`remaining-repetition-candidates.json`; intentional repeats can remain. Both model
responses are cached, and stage artifacts record prompt versions and hashes.

For a model-proposed single-word connector restart, a separate timing/grammar
check can confirm the cut. It excludes emphasis such as “very very” and verb
repeats such as “had had.” Clause alignment keeps a unique lead-in when the
model puts it inside a broader cut. Invalid plans get one repair request;
further validation failures stop the stage and keep all responses for review.

A later recap separated by more than eight transcript words stays for review;
the model cannot use it to erase the earlier setup automatically. This is a
conservative editing rule, not a measured quality score. Graphics planning
receives each scene’s word IDs and gets one repair pass for invalid anchors.

## Debug traces

Editor jobs take an optional `TraceRecorder` (`editor/trace.ts`); the local
engine turns it on with `trace: true`. It records every model call (prompt id
and version, model, input, output, usage), each artifact and progress line,
and saves `trace/<jobId>.json` beside the clip, edit or graphic, failed jobs
included. Plan traces also carry `cutMap` (`cut-map.ts`): kept and removed
source time per clip, with why, plus the joins in the cut. The desktop's debug
mode draws both; see `docs/agentic-video-editor-api.md` § Debug mode.
