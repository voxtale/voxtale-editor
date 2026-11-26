// Agent text for the last REDACTED gaps (logo, A/V at open, cut-out stills,
// D-Log M, new make_graphic templates). Not a registered skill version: the
// coordinator folds it into the next skill.
import {LOGO_CORNERS} from './logo';

export const PLACE_LOGO_DESCRIPTION=`Put the brand logo over the cut: the style's brand-kit logo, or a logo clip the creator gave. corner (${LOGO_CORNERS.join(', ')}; default top-right) or x,y (top-left, fractions of the frame); size = its width as a share of the frame (0.06-0.15 reads as a mark, more is a statement). from/to: spoken words it spans; leave both out for the whole cut. opacity under 1 for a watermark. Drawn over footage and graphics, under captions; its own see-through kept. Same id again moves it; an empty list removes every logo. Keep it off the face and out of the caption band.`;

export const REDACTED_GAPS_SKILL_TEXT=`## Logo, sync and colour checks
- Brand logo: place_logo. One quiet corner mark for the whole cut, or the logo big on the line that names the brand; not both at once. Check it in watch_cut.
- At open, each talk clip's sound is checked against the lips (first 30 s). A "sound is …ms ahead of / behind the lips" line means the picture and sound are out of step: look at a still, then set_av_offset <clip> measure:true.
- watch_cut draws the speaker cut out over a behindSubject graphic, as the export does; if the stills show the graphic over the face, the subject model is missing and the export will look the same.
- DJI D-Log M footage is converted with DJI's own LUT when tools/fetch-dji-luts.sh has fetched it (the open says so); else ask for the .cube and pass it as set_look inputLut.`;
