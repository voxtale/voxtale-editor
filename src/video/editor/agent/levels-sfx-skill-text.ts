// Agent text for cutting by sound level, SFX recipes and sequence
// transcription (bd voxtale-editor-d2p, -47t, -ypo). Tool descriptions are
// live; the *_SKILL_TEXT sections are in skill v30 (skill.ts).

/** set_cut segment field `clean`. */
export const CLEAN_FIELD='clean by level: inside this segment, code shortens every pause to `pause` seconds and drops hesitations (um, uh), each cut set on the clip\'s measured sound, never inside a kept word. For a long rambling take; leave it off where pauses carry meaning. Needs the clip\'s levels (read at open); without them the segment cuts by words as usual';

/** make_sfx tool. */
export const MAKE_SFX_DESCRIPTION=`Make a sound effect on this computer from a recipe, no download and no paid service: generated sound is free to use. recipe = one of the named starters (variant changes pitch or tone), or graph = your own ffmpeg lavfi audio graph (sources sine, anoisesrc, aevalsrc, anullsrc; filters such as afade, bandpass, lowpass, highpass, aecho, volume, amix, adelay; no files). It is rendered, limited, peak-measured and added as an sfx clip: place it with set_sfx by the clip id this returns. Same recipe and settings again returns the same clip. Every sound ends on a fade-out.`;

/** transcribe_sequence tool. */
export const TRANSCRIBE_SEQUENCE_DESCRIPTION='Transcribe only what the cut plays on the chosen audio tracks (a-roll, b-roll with its sound on, voiceover, music) between from and to (seconds of the cut; default the whole cut): each passage heard is sent once, its words added to the clip\'s transcript in source time. For a clip open skipped or a b-roll with speech you need as words. Free with the local engine; spends transcription credit on AssemblyAI (the engine when the server has ASSEMBLYAI_API_KEY), so send only passages with speech you need.';

/** Next skill version: a section after Cut edges. */
export const LEVELS_SKILL_TEXT=`### Clean by level
- Code reads each speaking clip's sound level every 10 ms at open. Edges where two words run together sit in the quietest spot between them.
- \`clean\` on a set_cut segment shortens pauses and drops hesitations by the measured sound. Use it on long loose takes; keep pauses that land a point (hold) out of it.
`;

/** Skill v30: under Sound effects (its gesture and level rules stay as they are). */
export const SFX_RECIPES_SKILL_TEXT=`### Where sounds come from
- make_sfx (made here from a recipe or your own graph), the fixed library, or CC0 files the creator adds as sfx clips. Never download sounds or call a paid sound service; CC BY only if the creator agrees to credit it, never NC.
- A repeat of the same hit: make_sfx the recipe again with another variant (pitch or tone) rather than the same clip.
`;
