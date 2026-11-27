# VoxTale editor MCP (local)

The VoxTale editor's tools as an MCP server on your own machine, for any
agent: Claude Code, Codex, Cursor. The agent cuts your footage, adds
captions, zooms on your eyes, shows b-roll and screen recordings, makes
animated graphics, and renders an MP4. It can also hand the edit to
Resolve, Premiere or Final Cut (FCPXML/OTIO), or rebuild it in another
editor through that editor's own MCP.

No VoxTale account. Runs from a checkout of this repo; all the logic is in
core (`voxtale-editor/mcp`), this app only starts it.

The server listens on a local URL, `http://127.0.0.1:7820/mcp`, which any
client can reach. It can also run over stdio for clients that start it
themselves.

## Set up (once)

### Mac

```sh
brew install git bun ffmpeg-full uv
git clone https://github.com/voxtale/voxtale-editor ~/voxtale-editor
cd ~/voxtale-editor
bun install            # also runs `bun run setup`
```

The editor finds ffmpeg-full by itself; set `VOXTALE_EDITOR_FFMPEG` /
`VOXTALE_EDITOR_FFPROBE` only to use another build.

### Windows

In PowerShell:

```
winget install Git.Git Oven-sh.Bun Gyan.FFmpeg astral-sh.uv
```

Close and reopen PowerShell, then check `bun --version`, `ffmpeg -version`
and `uv --version` each print a version. If ffmpeg lives elsewhere:
`setx VOXTALE_EDITOR_FFMPEG "C:\path\ffmpeg.exe"` and
`setx VOXTALE_EDITOR_FFPROBE "C:\path\ffprobe.exe"`.

```
git clone https://github.com/voxtale/voxtale-editor $HOME\voxtale-editor
cd $HOME\voxtale-editor
bun install
```

### What setup does

`bun install` runs `bun run setup`, which makes `.venv` (Python with OpenCV,
through uv) for the face finder and the subject mask. The models
(`models/`, YuNet and U2-Net-p) and the Pixelify Sans font ship in the
repo. Run `bun run setup` again any time; it skips what is there and
says what is missing.

- Face finder: zooms aim at your eyes. Without it they aim at the middle.
- Subject mask: text can sit behind you. Without it, text goes over you.

The server checks both at start. If something is missing it says so in
the terminal and in the reply to `open` and `resume`, so your agent tells
you.

If the server fails with `Cannot find module 'voxtale-editor/mcp'`,
`bun install` did not link the workspace: delete `node_modules` and run
`bun install` again.

### Transcription

Free and local by default: Parakeet v3 runs on your machine (MLX on Apple
Silicon, ONNX on the CPU elsewhere). Fetch the model once:

```sh
tools/fetch-parakeet.sh          # 2.5 GB on Apple Silicon, 490 MB elsewhere
tools/fetch-parakeet.sh --onnx   # the CPU model (also for VOXTALE_EDITOR_ASR=cpu on a Mac)
```

`VOXTALE_EDITOR_TRANSCRIBE` picks the engine:

- `auto` (default): local when the model is there; else `open` stops and
  names the fetch script. It never falls back to a paid engine.
- `local`: always local.
- `assemblyai`: AssemblyAI (assemblyai.com; about $0.01 per minute of
  speech). Needs `ASSEMBLYAI_API_KEY`.

`open` prints which engine ran for each talk clip. A saved transcript is
reused whatever the engine.

### Keys

For AssemblyAI only: put `ASSEMBLYAI_API_KEY=…` in `.env` in the repo
folder (bun loads it), or pass it with `-e` on a stdio client line.

`OPENROUTER_API_KEY` (openrouter.ai) is optional but recommended for
video. Each b-roll and screen clip gets labels, so the agent can search
footage (`find_footage`) and see when a synced screen changes
(`screen_activity`). `VOXTALE_EDITOR_VISION` picks who writes them:

- `openrouter` (default when the key is set): `open` labels the footage
  with a Gemini model (`VIDEO_INDEX_MODEL` to change it), the same pass
  the cloud editor runs. Roughly 1-3 cents and under a minute per minute
  of footage; the talking-head clip is not labelled.
- `harness` (default with no key, or `VOXTALE_EDITOR_VISION=harness`): the
  server calls no model. `label_footage` hands the agent contact sheets of
  each clip's picture changes; it describes them and `save_labels` keeps
  the labels. Free here; it spends the agent's own context.

Either way labels are kept in `.edit/moments/`, so opening the same files
again costs nothing.

## Start the server

```sh
cd ~/voxtale-editor          # Windows: cd $HOME\voxtale-editor
bun run mcp                  # http://127.0.0.1:7820/mcp
bun run mcp -- --port 7900   # another port (or VOXTALE_EDITOR_PORT=7900)
```

Leave it running in its own terminal. It prints its URL and where its
token is.

### Token

Every request needs `Authorization: Bearer <token>`. The first start makes
a random token in `~/.voxtale-editor/mcp-token` (owner-only), or set your
own with `VOXTALE_EDITOR_TOKEN`. Read it:

```sh
cat ~/.voxtale-editor/mcp-token                     # Mac
Get-Content $HOME\.voxtale-editor\mcp-token         # Windows
```

What keeps web pages out: the server binds 127.0.0.1 only, refuses any
`Host` that is not loopback, refuses any browser `Origin` that is not its
own, and needs the token. Anyone who can read your home folder can read
the token.

## Connect a client

Use the URL and token from the server's start message. One server holds
one open project: run one edit at a time, or start a second server on
another port.

### Claude Code

```sh
claude mcp add --scope user --transport http voxtale-editor http://127.0.0.1:7820/mcp \
  --header "Authorization: Bearer $(cat ~/.voxtale-editor/mcp-token)"
```

Windows (PowerShell):

```
claude mcp add --scope user --transport http voxtale-editor http://127.0.0.1:7820/mcp --header "Authorization: Bearer $(Get-Content $HOME\.voxtale-editor\mcp-token)"
```

Renders take minutes. Let Claude Code wait for them:
`export MCP_TOOL_TIMEOUT=3600000` in your shell profile (Mac) or
`setx MCP_TOOL_TIMEOUT 3600000` (Windows; reopen the terminal).

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.voxtale-editor]
url = "http://127.0.0.1:7820/mcp"
bearer_token_env_var = "VOXTALE_EDITOR_TOKEN"
tool_timeout_sec = 3600
```

Then set `VOXTALE_EDITOR_TOKEN` to the token in the shell you start Codex
from (`export VOXTALE_EDITOR_TOKEN=$(cat ~/.voxtale-editor/mcp-token)`).

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "voxtale-editor": {
      "url": "http://127.0.0.1:7820/mcp",
      "headers": {"Authorization": "Bearer <token>"}
    }
  }
}
```

### Stdio (the client starts the server)

```sh
claude mcp add --scope user voxtale-editor -e ASSEMBLYAI_API_KEY=your-key -- bun ~/voxtale-editor/apps/editor-mcp/src/main.ts --stdio
```

Windows: `bun $HOME\voxtale-editor\apps\editor-mcp\src\main.ts --stdio`.
With no flag the server picks stdio when a client starts it with pipes and
HTTP when you run it in a terminal; `--stdio` / `--http` (or
`VOXTALE_EDITOR_TRANSPORT`) make it explicit.

## Use

Open your agent in the folder with your clips and say what you want:

- "Edit talk.mp4 into a 30 second vertical short; the rest is b-roll."
- "Make a video from voiceover.m4a with these clips over it."
- "talk.mp4 and screen.mp4 were recorded together; show the screen when I
  point at it."

Over HTTP the server does not share your agent's folder: the agent passes
the footage folder to `open` (it does so from the paths you give).

The agent opens the files, edits, and writes `final.mp4` into the folder.
Ask for changes in plain words ("tighter start", "less b-roll") and it
renders again. The edit lives in `.edit/` in that folder; a new session
picks it up with `resume`.

## Graphics

Graphics render with Remotion by default (`VOXTALE_GRAPHICS_RENDERER=hyperframes`
for HyperFrames). The first graphic installs the renderer and a headless
browser into `~/.voxtale-editor/remotion` (or `hyperframes`), a few hundred
MB, once. The agent's graphic code runs on your machine with network
access: fine for your own agent on your own machine. Turn graphics off
with `VOXTALE_GRAPHICS=off`.

Fonts in `fonts/` (Inter, Pixelify Sans for pixel art; both OFL) load
into every graphic.

For a locked render (Docker, network off), build the sandbox image:
`bun run build:sandbox` (`tools/build-remotion-sandbox.sh`).

## Environment

| Variable | Use |
|---|---|
| `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_REGION` | Transcription; paid |
| `OPENROUTER_API_KEY` | Footage labels at `open`; optional, paid |
| `VOXTALE_EDITOR_PORT` | HTTP port (default 7820) |
| `VOXTALE_EDITOR_TOKEN` | HTTP bearer token (default: `~/.voxtale-editor/mcp-token`) |
| `VOXTALE_EDITOR_TRANSPORT` | `http` or `stdio` (default: stdio when started with pipes, else http) |
| `EDIT_FOLDER` | Footage folder when a call names none (default: the working folder) |
| `VOXTALE_GRAPHICS_RENDERER` | `remotion` (default) or `hyperframes` |
| `VOXTALE_GRAPHICS` | `off` turns graphics off |
| `VOXTALE_STYLES` | Style folders (default `~/.voxtale-editor/styles`) |
| `VOXTALE_EDITOR_FFMPEG`, `VOXTALE_EDITOR_FFPROBE` | ffmpeg paths |
| `VOXTALE_EDITOR_PYTHON`, `VOXTALE_EDITOR_UV` | Python interpreter (default the repo's `.venv`) / uv binary |
| `VOXTALE_REMOTION_IMAGE`, `VOXTALE_HF_IMAGE` | Sandbox image tags |
| `VOXTALE_EDITOR_SKIP_SETUP=1` | Skip setup during `bun install` |

## What it offers

- Tools: `editing_guide`, `open`, `resume`, the editor tools (`get_transcript`,
  `set_cut`, `timeline_view`, `watch_cut`, `show_footage`, `find_footage` and
  `screen_activity` (once footage is labelled), `label_footage` and
  `save_labels` (harness mode), `set_captions`,
  `set_zooms`, `place_text`, `render_graphic`, `place_graphic`, `set_music`,
  `set_sfx`, `set_look`, `propose_rule`, `finish`, …), `render`, `sheet`,
  `clips`, `export_timeline`, and the style tools (`styles`, `style`,
  `create_style`, `use_style`, `learn_style`, `set_brand`, `rules`,
  `decide_rule`, …).
- Sound and colour: `set_sfx` places sounds from a built-in library, made
  locally (no licence), each lined up on a word, card or cut. `set_music`
  starts the track where it comes alive, or at an `in` second you give;
  footage snaps to the beat only when the beat is firm. `set_look`
  measures the picture, fixes exposure and colour cast, adds a light look,
  and shows a before/after still. `check_cut` and `render` report loudness
  (LUFS, true peak) against the target.
- Styles: a style folder (rules, measured pace, brand, references) per
  look you edit in, in `~/.voxtale-editor/styles`. When you say "always" or
  "from now on", the editor proposes a rule; say yes, reword it or say no,
  and your agent records it with `decide_rule`.
- Resources: `editdoc://guide`, `editdoc://schema`, `editdoc://current`.
- Prompt: `edit-video`.

## Update

```sh
cd ~/voxtale-editor          # Windows: cd $HOME\voxtale-editor
git pull
bun install
```

Then restart the server.
