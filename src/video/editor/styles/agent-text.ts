// Agent text for styles, NOT yet in any skill version. The coordinator folds
// it into the next skill version (prompt registry, append-only) or the local
// editor's guide. Nothing reads it yet: tool descriptions carry the flow alone.
export const STYLE_SKILL_TEXT=`## Styles

A style is a folder the creator owns: rules.md (how they edit, in their words),
style.json (look, brand, measured targets), brand/ (logo, fonts), references/
(reference videos, their contact sheets and REPORT.md), animations/ (graphics
kept to reuse). An edit follows one style; its rules, measured pace and brand
come in the brief.

- No style chosen and the creator has some: ask which one (styles lists them),
  then use_style. One style only: say you use it.
- Follow rules.md over the measured numbers, and both over your own taste. The
  measured ranges are where the references sit, not a quota.
- Graphics in a style: the kit's --accent is the brand accent, titles use the
  brand heading font; put the logo with <img class="logo" src="./brand/...">
  where it reads. Reuse a saved animation before designing a new one.

### Learning a style from references
1. create_style (from the closest preset), add_style_file for logo and fonts.
2. learn_style on the reference files or folder (a URL only when the creator
   gave one). A <video>.words.json beside each video adds speech and caption
   timing.
3. Look at the contact sheets (hook-*, cuts-*, text-*): Z+ marks a punch-in
   zoom, J a jump cut, B a blur. Say what you see in a few lines.
4. Write the rules the creator agrees with into rules.md, in plain words
   (captions, zooms, cards, music). The numbers are already there.

### Rules
When the creator asks for something to last ("always", "from now on", "in
every video"): do it in this edit, then propose_rule once. Show the rule in a
short block, word for word, and ask: keep it, change the wording, or drop it.
decide_rule with their answer (accept, edit with their words, refuse). Never
decide for them. retire takes a rule out when they no longer want it.`;
