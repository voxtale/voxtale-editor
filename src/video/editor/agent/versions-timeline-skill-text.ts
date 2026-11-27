// Agent text for edit versions, the text timeline and find_words (bd
// voxtale-editor-evf, -5fe, -5ot). Not in a skill version yet: the
// coordinator folds VERSIONS_TIMELINE_SKILL_TEXT into the next one.

export const TIMELINE_DESCRIPTION='The edit as text, one line per item per track (captions and text on top, then graphics, zoom, footage, speaker, sound): id, what it shows (clip and the words it plays), output start → end, source in, and the settings that matter (speed, crop, layout, gain, J/L, transitions, fades, variants, CREATOR for the creator\'s own items). at: only what sits under that output second, with the source second each clip plays there (what a note at 1:23 is about). tracks: only those tracks. Cheap: use it instead of reading edit.json, and before each touch-up. timeline_view is different: it looks at source footage.';

export const FIND_WORDS_DESCRIPTION='When words are heard in the CUT: each place a phrase is said, as output seconds (after cuts, J/L sound shifts and footage speed), with the clip, word ids and source second. get_transcript gives source times only; use this to land a title, a graphic or a sound on a word ("put the title where he says budget"). Matching ignores case, accents and punctuation. A phrase not heard says whether the cut dropped it or no transcript has it.';

export const NEW_VERSION_DESCRIPTION='Start the next version of the edit before you change it for a new request: the edit as it is now is kept as a version, untouched, and you go on changing an exact copy. Call it once at the start of each creator request that changes the edit (not before every tool). note: what this version is for ("tighter hook", "music from the chorus"). If you forget, the server keeps the edit as it was before your first change after open, resume or a long pause; new_version right after that only names it.';

export const VERSIONS_DESCRIPTION='The versions of this edit, oldest first: number, when, its note, which one it was restored from, and the working one.';

export const RESTORE_VERSION_DESCRIPTION='Go back to an earlier version ("the cut before the music"): the working edit is kept as a version first, then the old one comes back as the next version. Nothing is lost; restore again to go forward.';

export const TRASH_DESCRIPTION='Send what you tried and dropped to the system Trash (recoverable from there): versions by number (never the working one), and/or scratch: true for the preview stills watch_cut and sheet left in .edit/. Footage, transcripts and renders are never touched. Use it once your answer is ready, for tries the creator will not want back.';

/** For the next skill version: a section after the workflow steps. */
export const VERSIONS_TIMELINE_SKILL_TEXT=`### Versions and reading the cut
- Each creator request that changes the edit starts with \`new_version\` (a note on what it is for); the edit before it stays as a version. \`versions\` lists them; \`restore_version\` brings one back as the next version, so going back never loses work.
- Tries you drop on the way: \`trash\` them once your answer is ready. Never the working version.
- Read the cut with \`timeline\`, not edit.json: one line per item. \`timeline at\` answers "what is at 1:23" for a note, with the source second.
- To land anything on a spoken word, \`find_words\` gives the output second; never convert get_transcript times by hand.
`;
