// Agent-facing text for multicam, A/V offset, proxies and log footage: tool
// descriptions, and two pieces of skill v28 (./skill.ts).

/** Appended to the open tool's description: the new roles. */
export const OPEN_MEDIA_NOTE='More cameras or mics recorded with the talk clip: give the main camera as talk, each other camera as camera (not transcribed), each separate mic or recorder as mic. Open lines them up by their sound and reports each file\'s start and match strength; a file that does not line up is kept as is. Big, 10-bit or non-H.264 video gets a light 720p copy for previews (render uses the original). Log or HDR footage is detected and converted to Rec.709 before any look.';

/** Appended to set_look's description: colour space and input LUT. */
export const LOOK_COLOR_NOTE='Log or HDR footage is converted to Rec.709 first, as detected at open (the reply says what it found). Wrong detection: set colorSpace (Rec.709 = no conversion). A camera with no built-in formula (DJI D-Log M, Osmo Pocket 4 D-Log): ask the creator for the maker\'s .cube and pass it as inputLut.';

export const SET_ANGLES_DESCRIPTION='Multicam: which camera shows and which mic plays, per word range of the talk clip. Ranges are inclusive word ids. layout: camera (one picture), split (two side by side; top and bottom on a tall canvas) or pip (companion small in pipCorner). auto.mic picks, per piece, the mic that sounds most active; auto.angle does the same for cameras (rough: loudness, not faces). Choices win over auto. clear:true goes back to the talk camera and its own sound. A camera or mic that does not hold the whole piece falls back to the talk clip (render lists it).';

export const SET_AV_OFFSET_DESCRIPTION='Sound out of step with the picture on a clip (lips move before or after the words): measure:true compares mouth movement with loudness over the first minute and sets what it finds when the match is sure; offset sets it by hand (seconds, positive moves the sound later, -2..2). 0 clears it. Check a talking moment with watch_cut after.';

/** Skill v28 (./skill.ts): its own section. Opening with these roles is the open tool's job (OPEN_MEDIA_NOTE). */
export const MULTICAM_SKILL_TEXT=`## Several cameras or mics

Open lines up other cameras and mics with the talk clip by their sound and
reports each match strength; trust 8 or more.
- The cut stays in the talk clip's words. \`set_angles\` picks the camera and
  mic per word range; \`auto.mic\` is a safe default when each speaker has a
  lav.
- Switch angle on a sentence or a thought, not every few words. \`split\` for
  two people talking to each other; \`pip\` for a screen with the speaker.
- Lips out of step on one camera: \`set_av_offset\` with \`measure: true\` on
  that clip, then \`watch_cut\` a talking moment.
`;

/** Skill v28: appended to its Colour section. */
export const LOG_COLOUR_SKILL_TEXT=`
Log and HDR clips are converted to Rec.709 before \`set_look\` measures, so
grade as usual. Picture grey and flat after the cut: read \`set_look\`'s
colour line and set \`colorSpace\` if detection was wrong. DJI D-Log M and
Osmo Pocket 4 D-Log have no formula: ask for DJI's .cube and pass it as
\`inputLut\`.
`;
