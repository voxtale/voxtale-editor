// Agent-facing text for local transcription (bd voxtale-editor-ypi). Not in a
// skill version yet: the coordinator folds it into the next one (./skill.ts).

/** Replaces "transcribes speech (about 1 min per 10 min of speech)" in the open tool's description. */
export const OPEN_TRANSCRIBE_NOTE='transcribes speech on this machine with Parakeet (free, no key; slower on a CPU than on Apple Silicon), or with AssemblyAI when the server is set to (VOXTALE_EDITOR_TRANSCRIBE=assemblyai, paid)';

/** Skill section: what the agent says and does about transcription. */
export const TRANSCRIBE_SKILL_TEXT=`## Transcription

Open transcribes talk clips locally by default: Parakeet v3 on the creator's
machine, free, no key, no upload. Each clip's open log says which engine ran
("Engine: local Parakeet v3, free" or "AssemblyAI, paid"). A saved transcript
is reused, whatever engine made it.
- Open fails with "Local transcription needs the Parakeet v3 model": tell the
  creator to run \`tools/fetch-parakeet.sh\` in the editor repo once (2.5 GB on
  Apple Silicon, 490 MB elsewhere), then open again (no restart). Or, if
  they want the paid engine, set VOXTALE_EDITOR_TRANSCRIBE=assemblyai with
  ASSEMBLYAI_API_KEY. Never switch to the paid engine for them.
- Parakeet keeps no "um"s and spells names by ear: check names and numbers in
  the transcript; fillers are not words, so find them by sound.
- Local words have a confidence too: low ones (under 0.5) are worth a listen
  before a cut lands on them.`;
