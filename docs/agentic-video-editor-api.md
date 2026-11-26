# Video editor API

HTTP routes behind VoxTale Desktop's video editor (`apps/web/app/api/v1/video`).
Plan: [agentic-video-editor-plan.md](agentic-video-editor-plan.md) §9.

Base: `/api/v1/video`. Every call takes `Authorization: Bearer <token>` (same
tokens as the `voxtale` CLI). The account needs the `video-editor` feature
(`apps/web/convex/entitlements.ts`). For planning, media stays on the creator's
machine: the desktop sends a clip's audio (FLAC), stills and segment list,
nothing else. Only [cloud render](#cloud-render) uploads whole clips, and only
when the creator asks for it.

**One editor, three callers.** The rules (who may do what, job hand-offs,
revision checks, error codes) live once in core, `src/video/editor/`:
`state.ts` (rules over two ports: a store and a job queue), `api.ts` (what
these routes serve), `jobs.ts` (index, plan, graphic and render jobs) and
`local.ts` (all of it in one process). Callers only adapt:

| Caller | Store / queue | Jobs run in |
|---|---|---|
| These routes (`apps/web/lib/api/video.ts`) | Convex: `convex/video.ts` + `convex/lib/videoJobs.ts` | `apps/worker` (`runEditorJob`) |
| Desktop, local build | JSON file + folder (`editor/local.ts`) | the app's main process |
| Tests | memory (`editor/memory.ts`) | the test |

`convex/video.ts` holds no rules: it checks args, signs the caller in, gates
the feature and claims jobs for the worker, then calls core.

Errors are JSON `{ error: { code, message } }`. Codes the desktop acts on:

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_INPUT` | 400 | Body failed validation |
| `INVALID_CLIPS` | 400 | 0 or more than 200 clips |
| `INVALID_DURATION` | 400 | Target length outside 5 s – 4 h |
| `INVALID_STYLE` | 400 | Unknown style preset |
| `INVALID_PROPS` | 400 | Graphic values not an object under 16 KB |
| `FEATURE_LOCKED` | 403 | Plan lacks the video editor |
| `NOT_FOUND` | 404 | No such clip |
| `CLIP_NOT_INDEXED` | 409 | Plan asked for before every clip is indexed |
| `NOT_UPLOADING` | 409 | Upload URLs asked for on an indexed or queued clip |
| `MISSING_UPLOADS` | 409 | `complete` called before every file arrived; `details.missing` lists them |
| `EDIT_BUSY` | 409 | The agent is planning this edit |
| `REVISION_CONFLICT` | 409 | Save based on an old revision; pull first |
| `GRAPHIC_BUSY` / `GRAPHIC_NOT_READY` | 409 | Graphic still rendering / never made |
| `SOURCE_MISSING` | 409 | Cloud render asked for before every clip's full file is up; `details.hashes` lists them |
| `MISSING_PARTS` | 409 | Source `complete` called before every part arrived; `details.missing`, `details.stored` |
| `STALE_UPLOAD` | 409 | A newer source upload replaced this one; start again |
| `NOT_READY` | 409 | Render asked for on an edit with no cut yet |

## Clips

A clip is keyed by the SHA-256 of its bytes (64 lowercase hex). Same hash, same
clip: an indexed clip is never uploaded or charged twice.

| Route | Body | Returns |
|---|---|---|
| `POST /clips` | `ClipIngest` (`@voxtale/editdoc`): probe, segments, stills times, role, loudness | `{hash, status, upload}`; 201 when files are wanted |
| `POST /clips/{hash}/uploads` | `{files: ["audio.flac", "stills/S001-0.jpg", …]}`, ≤ 500 | `{urls: {name: signedPutUrl}}`, valid 1 h |
| `POST /clips/{hash}/complete` | — | 202 `{hash, status: "queued"}`; checks every file first |
| `GET /clips/{hash}` | — | `{status, error, roleGuess, index, overrides}`; `index` once indexed |
| `PUT /clips/{hash}/overrides` | `IndexOverrides` | The stored overrides |

Indexing meters footage by started minute. Music and sound effect clips
(`role: "music" | "sfx"`) skip transcription.

## Edits

| Route | Body | Returns |
|---|---|---|
| `POST /edits` | `{name, clipHashes, instruction?, targetDuration?, style?, brand?, projectId?}` | 202 `{editId, status: "planning"}` |
| `GET /edits/{editId}` | — | `{status, revision, error, notes, instruction, targetDuration, style, clipHashes, projectId, doc}` |
| `GET /projects/{projectId}/edits` | — | `{edits: [{editId, name, status, revision, createdAt}]}`, newest first |
| `GET /projects/{projectId}/sources` | — | `{title, material?, outline?, packaging?, publishedTitle?}`: the plan the agent reads; the desktop's local build fetches it to cut toward a cloud project |
| `POST /edits/{editId}/replan` | `{instruction?, targetDuration?, style?, clipHashes?}` | 202; plans from the latest revision, creator items kept |
| `POST /edits/{editId}/revisions` | `{baseRevision, accept?, reject?, patch?}` | 201 `{revision, decisions, doc}` |

- `style`: `calm-explainer` (default), `fast-paced`, `podcast`, `tutorial`.
  Sets pace, captions, music level, sound effects and loudness target.
- `targetDuration`: seconds, 5 – 14400.
- `projectId`: a VoxTale web project (`GET /api/v1/projects`), yours or
  `NOT_FOUND`. The agent gets its plan: the published title (else the top
  three packaging ideas with hooks), the outline promise and beats, and the
  topic or script. It opens on the line that pays off the title and uses the
  beats to tell points from rambles; the footage wins where they differ. The
  web project page lists the project's edits.
- `brand`: the creator's kit, `{colors?: {primary?, accent?, background?, text?}, fonts?: {heading?, body?}}`;
  colours `#RRGGBB`, fonts a name up to 80 characters (`INVALID_BRAND` otherwise).
  Laid over the preset whenever a plan picks a fresh look: the first cut, or a
  replan with a new `style`. A replan on the same style keeps the edit's look.
- `doc` is an `EditDoc` (`@voxtale/editdoc`). Poll `GET` until `status` is
  `ready` or `failed`.
- `patch.tracks.<track>` and `patch.markers` take `{upsert, remove}`; the
  server validates items against the EditDoc schema and logs each change.
- `patch.style` changes the look: `brand` (`colors`, `fonts`, `captionStyle`,
  `logoAssetId`, `safeMargins`), `pace.captions`, `audio.musicLevelDb`.
  `patch.mix` changes mix fields (`duckingDb`, `cutFades`, …). Each value is
  checked against the style or mix schema. A new cut keeps them unless it
  picks another style preset.
- A text item's `look` (`fontFamily`, `fontSize` in px at 1080 tall,
  `fontWeight`, `color`, `backgroundColor` or `"none"`) overrides its template.

## Graphics

| Route | Body | Returns |
|---|---|---|
| `GET /edits/{editId}/graphics` | — | `{graphics: [{assetId, status, revision, readyRevision, kind, title, props, jsonSchema, problem, webmUrl, stillUrl}]}` |
| `POST /edits/{editId}/graphics/{assetId}/props` | `{props}` under 16 KB | 202; renders again from the same source, no model call |

`webmUrl` is a VP9 WebM with alpha; `stillUrl` a JPEG of it. Both are signed
and short-lived: download, don't store the URL. `jsonSchema` describes `props`.

## Frame calls

A cloud agent run looks at footage and renders its graphics on the creator's
computer, so full clips never go up. The run posts a frame call; the desktop,
while signed in, claims it, answers from its own files (`@voxtale/frames`
`answerFrameCall`) and uploads the result.

| Route | Body | Returns |
|---|---|---|
| `GET /frame-calls?wait=N` | — | `{calls: [{id, call, deadline}]}`; holds up to N s (max 25) until one comes |
| `POST /frame-calls/{callId}/claim` | — | `{id, call, deadline}`; 409 `CALL_TAKEN` when it lapsed or another window took it |
| `POST /frame-calls/{callId}` | multipart: `reply` JSON `{ok, error?, report?}` + one part per file | `{ok: true}`; 409 `STALE_CALL` when it lapsed |

- `call.op`: `filmstrip {clip, start, end}`, `joins {pairs}`,
  `frames {clip, times, width}`, `graphic {job}`. Clips by hash.
- Result files: `image` (filmstrip, joins), `f0`…`f63` (frames; a missing
  frame has no part), `webm` and `sheet` (graphic). PNG, JPEG or WebM, told
  apart by their first bytes; at most 64 parts, 48 MiB in all, with a
  Content-Length.
- Refuse a call by answering `{ok: false, error}`: the agent reads the error.
- A call lapses at `deadline`. Unclaimed after 45 s, the run tells the agent
  VoxTale is closed and to work from the transcript; later calls give up after
  15 s until one is answered.

## Cloud agent editor (`video-agent`)

With `VOXTALE_AGENT_PLANS=1` on the Convex deployment, new plans and replans
queue as `video-agent` instead of `video-plan`. Same meter (`videoPlans`),
same worker calls (`workerEdit`, `workerEditReady`). The worker runs the
agent loop on the Claude Agent SDK; frames and graphic renders go through
frame calls to the creator's desktop.

- Before the agent starts, the worker asks the desktop for one frame of every
  clip. No answer, or a clip it cannot find: the story stages plan instead,
  with the note "Planned without the agent editor: VoxTale was not open…".
- Worker env: `ANTHROPIC_API_KEY` (required; no key, the worker never claims
  `video-agent`), `VOXTALE_AGENT_MODEL` (default `claude-opus-5-5`),
  `VOXTALE_AGENT_MAX_TURNS` (60), `VOXTALE_AGENT_BUDGET_USD` (3, per plan),
  `WORKER_MAX_AGENT` (1 run at a time per worker), `VOXTALE_AGENT_BASE_URL`
  (local test proxy only).
- Own host: set `VOXTALE_AGENT_POOL=1` on every worker, so general ones leave
  `video-agent` alone, and start one with `WORKER_JOB_TYPES=video-agent`.
  With the flag, that worker skips the native preflight and corpus sync.
- Size: a run holds one Claude Code process plus our MCP endpoint, and
  makes one ffmpeg still per graphic. Footage and renders stay on the
  desktop, so it needs far less than the render box. Not yet measured: check
  the worker's memory during the first real runs before raising
  `WORKER_MAX_AGENT` on the 4 GB VPS; move to its own host if it competes
  with generate jobs.

## Cloud render

The cloud renders a saved revision from the creator's full clips, so each clip
the cut shows or plays goes up once. Same EditDoc, same maths as the desktop
export (`@voxtale/editdoc` `render.ts`); the render box runs ffmpeg.

**Full clip upload** (S3 multipart, straight to storage):

| Route | Body | Returns |
|---|---|---|
| `POST /clips/{hash}/source` | `{size, ext}` | `{status, size, partSize, parts}`; 201 on a new upload. Same size and type resumes the one under way |
| `GET /clips/{hash}/source` | — | `{status: "none" \| "uploading" \| "ready", size?, partSize?, parts?}` |
| `DELETE /clips/{hash}/source` | — | 204; stops the upload and forgets it |
| `POST /clips/{hash}/source/parts` | `{partNumbers}`, 1–100 | `{urls: {n: signedPutUrl}}`, valid 1 h; a 403 on PUT means ask again |
| `POST /clips/{hash}/source/complete` | — | `{status: "ready", size}` once every part is in |

- `parts` lists stored parts as `{partNumber, size}`: send only the rest.
- `partSize` follows from `size` (at least 16 MiB, at most 9000 parts), so a
  resume lines up with the first try.
- `ext`: mp4, mov, m4v, mkv, webm, avi, mxf, mts, m2ts, mp3, wav, m4a, aac,
  flac, ogg, png, jpg, jpeg, webp.
- The render box checks the joined file hashes to the clip before using it.

**Renders:**

| Route | Body | Returns |
|---|---|---|
| `POST /edits/{editId}/renders` | `{revision}` (defaults to latest) | 202 `{renderId}`; 409 `SOURCE_MISSING` with `details.hashes` when clips are not up |
| `GET /edits/{editId}/renders` | — | `{renders: [...]}`, newest first |
| `GET /renders/{renderId}` | — | `{renderId, createdAt, status, revision, progress, url, frames, duration, bytes, skipped, error}` |

- `status`: `queued`, `rendering` (a worker holds the job), `ready`, `failed`.
- `progress` while queued or rendering: `{job, stage, fraction}`; `stage` is
  `downloading` (fetching clips), `rendering`, then `uploading`.
- `url`: signed MP4 link once `ready`, valid 1 h. Download it; don't store it.
- `skipped`: items left out, e.g. a graphic still rendering.
- Meter: `renderMinutes`, by started minute of the finished video.

The desktop flow: `POST renders`; on `SOURCE_MISSING`, upload each listed
clip, then `POST renders` again; poll `GET /renders/{id}` every 2 s; download
`url` to the file the creator picked.

## Local test stack

`tools/video-localstack.sh` runs the whole editor flow on this machine, with
nothing in production: Convex and S3 storage in Docker, a fake sign-in server,
the API on :3130, the main worker and the render box.

```bash
tools/video-localstack.sh up       # start (first run sets up keys and config)
tools/video-localstack.sh app      # open VoxTale Desktop as tester@local.test
tools/video-localstack.sh status
tools/video-localstack.sh logs worker   # web | worker | render | issuer
tools/video-localstack.sh down     # stop, keep data
tools/video-localstack.sh reset    # stop and delete all local data
```

Needs Docker. State lives in `~/.voxtale-localstack`. Indexing and planning
call AssemblyAI and OpenRouter with the keys in `.env`, so each run costs a
little. Motion graphics need the `voxtale-graphics-sandbox:1` image.

Cloud agent editor: `VOXTALE_LOCAL_AGENT=1 tools/video-localstack.sh up`
also starts an `agent` worker (`WORKER_JOB_TYPES=video-agent`) and sets
`VOXTALE_AGENT_PLANS=1` on local Convex, so plans run there; a plain `up`
turns it off again. It takes `ANTHROPIC_API_KEY` from the shell or `.env`
(billed; budget defaults to $1 a plan here), or `VOXTALE_AGENT_BASE_URL` for
a loopback proxy. `app` opens the cloud desktop build, which answers the
agent's frame calls; keep it open while a plan runs.

## Local build (no cloud)

The desktop's local build runs the whole editor inside the app: no sign-in,
no Convex, no storage service, no worker. It loads core's editor as one
bundle (`engine.mjs`) and runs the same rules and jobs the cloud runs, with
your own model keys.

```bash
tools/build-video-engine.sh ../voxtale-desktop   # bundle core → apps/desktop/resources/engine
cd ../voxtale-desktop/apps/desktop
pnpm build:local && pnpm exec electron .         # run it (keys from env, see below)
pnpm dist:local                                  # unsigned "VoxTale Local" app in release/
bun scripts/local-e2e.ts <clip> [seconds]        # whole pipeline, no window (run from a folder whose .env has the keys)
```

- Keys: `OPENROUTER_API_KEY` and `ASSEMBLYAI_API_KEY` from the environment,
  else `~/Library/Application Support/VoxTale Local/voxtale/keys.json`.
  The app re-reads that file before each job, so no restart. A job that fails
  for want of a key says which key and where to put it.
- Data: `VoxTale Local/` beside the hosted app's folder; state is
  `voxtale/engine/state.json`, files under `voxtale/engine/blobs/`.
- Render uses the app's ffmpeg; ffprobe comes from `PATH`.
- Motion graphics are on. They render in Docker (the
  `voxtale-graphics-sandbox:1` image), since the model writes their code. Each
  plan checks for Docker and the image; without them the cut has no graphics
  and says why. `VOXTALE_GRAPHICS=0` turns them off. Face search for
  reframing is off.
- The bundle is private: gitignored in the desktop repo (its remote is the
  public upstream). Local builds are for internal use.

### Debug mode

Settings → General → **VoxTale debug mode** adds a Debug section to the
VoxTale panel. The local build saves one trace per index, plan and graphic
job, failed ones too; the hosted editor saves none, so the section is empty
there.

- Each trace lists the job's steps in order: model calls (prompt
  `id@version`, model, prompt text, input, output, usage, cost, time),
  artifacts the stages wrote, and, with **Progress**, progress lines.
  Vision images show as their size, not their bytes.
- A plan trace carries a cut map: each speaking clip's source time as a
  strip, coloured by why each part stayed or went (kept, unsure, pause,
  retake, false start, setup, off topic, cut for length). Click a kept part
  to seek there. **Words** shows the transcript struck through the same way.
- While the timeline shows the traced revision, each join in the cut gets a
  tick on the timeline naming what it skipped.
- Files: `trace/<jobId>.json` under the clip (index), the edit (plan) or the
  graphic (graphic) in the engine's blobs. Traces hold whole prompts and
  transcripts; the cloud worker does not turn them on.
- Engine side: `traceRecorder` (`src/video/editor/trace.ts`) wraps
  the planner, vision and writer seams; `cutMap` (`src/video/cut-map.ts`)
  is pure; `api.traces(editId)` reads them back.
