// Agent text for the last REDACTED gaps (logo, cut-out stills, D-Log M, new
// make_graphic templates). Folded into skill v29 (skill.ts MERGE_V29); the
// A/V check at open is a local-server note (local-mcp/guide.ts).
import {LOGO_CORNERS} from './logo';

export const PLACE_LOGO_DESCRIPTION=`Put the brand logo over the cut: the style's brand-kit logo, or a logo clip the creator gave. corner (${LOGO_CORNERS.join(', ')}; default top-right) or x,y (top-left, fractions of the frame); size = its width as a share of the frame (0.06-0.15 reads as a mark, more is a statement). from/to: spoken words it spans; leave both out for the whole cut. opacity under 1 for a watermark. Drawn over footage and graphics, under captions; its own see-through kept. Same id again moves it; an empty list removes every logo. Keep it off the face and out of the caption band.`;

/** Skill v29: a section after Text behind the speaker. */
export const LOGO_SKILL_TEXT=`### Brand logo
- \`place_logo\`: one quiet corner mark for the whole cut, or the logo big on the line that names the brand; not both at once.
- Keep it off the face, out of the caption band and away from a chapter label's corner. watch_cut draws it: check it there.
`;

/** Skill v29: the make_graphic templates, by what each says. */
export const TEMPLATES_SKILL_TEXT=`(list, stat, before/after, key term, compare, title, flow;
   marked underlines the one word that carries a headline; chapter is a
   section title that parks in a top corner while the part runs; cards deals
   3-8 short examples onto a pile, for "there are lots"; beatWords lights each
   word of a short line as it is said, only for a line that is the graphic,
   since captions already do it) says it;`;
