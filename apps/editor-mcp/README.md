# VoxTale editor MCP (local)

The VoxTale editor's tools as an MCP server on your own machine, for any
agent: Claude Code, Codex, Cursor. The agent cuts your footage, adds
captions, zooms on your eyes, shows b-roll and screen recordings, makes
animated graphics, and renders an MP4. It can also hand the edit to
Resolve, Premiere or Final Cut (FCPXML/OTIO), or rebuild it in another
editor through that editor's own MCP.

No VoxTale account. Runs from a checkout of this repo; all the logic is in
core (`voxtale-editor/video/editor/mcp`), this app only starts it.

## Set up (Windows, once)

1. In PowerShell:

   ```
   winget install Git.Git Oven-sh.Bun Gyan.FFmpeg astral-sh.uv
   ```

   Close and reopen PowerShell, then check `bun --version`,
   `ffmpeg -version` and `uv --version` each print a version.

   - uv runs the face finder that aims zooms at your eyes (it fetches
     Python and OpenCV on first use). Without uv, zooms aim at the middle.
   - If ffmpeg lives elsewhere: `setx VOXTALE_EDITOR_FFMPEG "C:\path\ffmpeg.exe"`
     and `setx VOXTALE_EDITOR_FFPROBE "C:\path\ffprobe.exe"`.

2. Get the code:

   ```
   git clone https://github.com/voxtale/voxtale-editor $HOME\voxtale-editor
   cd $HOME\voxtale-editor
   bun install
   ```

   If the server fails with `Cannot find module 'voxtale-editor/video/editor/mcp'`,
   `bun install` did not link the workspace: delete `node_modules` and run
   `bun install` again.

3. Get an AssemblyAI key (assemblyai.com; about $0.01 per minute of
   speech) and add the server to Claude Code:

   ```
   claude mcp add voxtale-editor --scope user -e ASSEMBLYAI_API_KEY=your-key -e OPENROUTER_API_KEY=your-key -- bun $HOME\voxtale\apps\editor-mcp\src\main.ts
   ```

   `OPENROUTER_API_KEY` (openrouter.ai) is optional. With it, `open` labels
   each b-roll and screen clip with a vision model, the same pass the cloud
   editor runs, so the agent can search footage (`find_footage`) and see
   when a synced screen changes (`screen_activity`). It costs roughly
   1-3 cents and under a minute per minute of footage; the talking-head
   clip is not labelled. Labels are kept in `.edit/moments/`, so opening the
   same files again costs nothing. Without the key, `open` only transcribes
   and those two tools stay off.

4. Renders take minutes. Let Claude Code wait for them:

   ```
   setx MCP_TOOL_TIMEOUT 3600000
   ```

   Reopen the terminal after `setx`.

Mac: `brew install bun ffmpeg-full uv`, then steps 2–4 with Mac paths
(`export MCP_TOOL_TIMEOUT=3600000` in your shell profile). The editor finds
ffmpeg-full by itself, so `VOXTALE_EDITOR_FFMPEG` / `VOXTALE_EDITOR_FFPROBE` are
optional on Mac; set them only to use another build.

## Use

Open Claude Code in the folder with your clips and say what you want:

- "Edit talk.mp4 into a 30 second vertical short; the rest is b-roll."
- "Make a video from voiceover.m4a with these clips over it."
- "talk.mp4 and screen.mp4 were recorded together; show the screen when I
  point at it."

The agent opens the files, edits, and writes `final.mp4` into the folder.
Ask for changes in plain words ("tighter start", "less b-roll") and it
renders again. The edit lives in `.edit/` in that folder; a new session
picks it up.

## Graphics

The first graphic installs HyperFrames and a render browser into
`~/.voxtale-editor/hyperframes` (about 200 MB, a few minutes, once). The
agent writes each graphic as HTML, and it runs in that browser with
network access: fine for your own agent on your own machine. Turn graphics
off with `-e VOXTALE_GRAPHICS=off` on the `claude mcp add` line.

## What it offers

- Tools: `editing_guide`, `open`, `resume`, the editor tools (`get_transcript`,
  `set_cut`, `timeline_view`, `watch_cut`, `show_footage`, `find_footage` and
  `screen_activity` (with `OPENROUTER_API_KEY`), `set_captions`,
  `set_zooms`, `place_text`, `render_graphic`, `place_graphic`, `set_music`,
  `set_sfx`, `set_look`, `propose_rule`, `finish`, …), `render`, `sheet`,
  `clips`, `export_timeline`, `rules`, `decide_rule`.
- Sound and colour (skill v26): `set_sfx` places sounds from a built-in
  library, made locally (no licence), each lined up on a word, card or cut.
  `set_music` starts the track where it comes alive, or at an `in` second you
  give; footage snaps to the beat only when the beat is firm. `set_look`
  measures the picture, fixes exposure and colour cast, adds a light look,
  and shows a before/after still. `check_cut` and `render` report loudness
  (LUFS, true peak) against the target.
- Standing rules: when you say "always" or "from now on", the editor
  proposes a rule. Say yes, reword it or say no; your agent records it with
  `decide_rule`. Accepted rules live in `~/.voxtale-editor/rules.json` and
  load into every later edit.
- Resources: `editdoc://guide`, `editdoc://schema`, `editdoc://current`.
- Prompt: `edit-video`.

## Update

```
cd $HOME\voxtale-editor
git pull
bun install
```
