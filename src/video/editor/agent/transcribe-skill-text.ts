// Agent-facing text for local transcription (bd voxtale-editor-ypi).
// TRANSCRIBE_SKILL_TEXT is in skill v30 (./skill.ts); OPEN_TRANSCRIBE_NOTE is in the open tool.

/** Replaces "transcribes speech (about 1 min per 10 min of speech)" in the open tool's description. */
export const OPEN_TRANSCRIBE_NOTE='transcribes speech with AssemblyAI when the server has ASSEMBLYAI_API_KEY (paid), else on this machine with Parakeet (free, no key; slower on a CPU than on Apple Silicon)';

/** Skill section: what the agent says and does about transcription. */
export const TRANSCRIBE_SKILL_TEXT=`## Transcription

Open transcribes talk clips with AssemblyAI (paid) when the server has
ASSEMBLYAI_API_KEY; with no key, locally with Parakeet v3 on the creator's
machine (free, no upload). VOXTALE_EDITOR_TRANSCRIBE=local or =assemblyai
forces one. Each clip's open log says which engine ran ("Engine: local
Parakeet v3, free" or "AssemblyAI, paid"). A saved transcript is reused,
whatever engine made it.
- Open fails with "Local transcription needs the Parakeet v3 model": tell the
  creator to run \`tools/fetch-parakeet.sh\` in the editor repo once (2.5 GB on
  Apple Silicon, 490 MB elsewhere), then open again (no restart). Or, if
  they want the paid engine, set ASSEMBLYAI_API_KEY in the server's
  environment. Never set a key for them.
- Parakeet keeps no "um"s and spells names by ear: check names and numbers in
  the transcript; fillers are not words, so find them by sound.
- Local words have a confidence too: low ones (under 0.5) are worth a listen
  before a cut lands on them.`;
