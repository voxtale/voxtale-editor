// Agent text for auto reframe (set_frame) and title motion tracking
// (track_title). NOT folded into a skill version yet: the skill section below
// waits for the next skill bump (skill.ts), the tool descriptions are live.
import {REFRAME_SPEEDS} from '@voxtale/editdoc';

export const SET_FRAME_DESCRIPTION=`Set the output frame shape. aspect "9:16" (Shorts, Reels, TikTok), "1:1", "4:5", "16:9", or "source" (the main clip's own shape, the default). When the frame is narrower than the footage, the crop follows the speaker left and right (auto reframe: the face, a person where no face shows), held still through small moves and smoothed so it never jitters. speed (${REFRAME_SPEEDS.join(', ')}; default "default") is how quickly the crop catches up: slower for a seated talk, faster for someone who walks. follow false crops the middle instead. Changing the frame drops every motion track (track_title again after). Needs the original files on this machine.`;

export const TRACK_TITLE_DESCRIPTION=`Pin a text or graphic to a spot in the scene so it moves with the camera (motion tracking). id: the text or graphic. x,y: the spot to follow, fractions of the frame, at output second at (default the item's middle): pick something fixed in the set with clear texture (a corner of a sign, a window edge, a poster), not a face, a person or sky. zone (x,y,w,h fractions of the frame) narrows what drives the track when moving things sit near the spot. Text follows shift and scale; a graphic follows shift only. Works on a-roll pieces in one camera (no split, picture-in-picture or other angle); outside the piece under it the item holds still. clear true removes the track. A recut that moves the footage under the item drops its track: track again.`;

/** Skill section for the next skill version: after zoom and reframe. */
export const TRACK_SKILL_TEXT=`### Frame shape and motion tracking
- A vertical or square cut: \`set_frame\` aspect "9:16" or "1:1" once, before captions and text, since their places read off the frame. The crop follows the speaker; check watch_cut for a face cut by the edge (two people far apart cannot both fit: say so).
- A title that should sit in the scene (on a wall, beside a sign) while the camera moves: place the text or graphic, then \`track_title\` on a fixed textured spot near it. Read the result: a big "moved" with "partial" means the item runs past the shot, so trim it to the shot. Skip tracking on a locked-off camera: nothing moves.
`;
