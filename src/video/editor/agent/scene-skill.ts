// Agent text for native scenes, papercraft and pixel art. NOT a registered
// skill version: several threads change the skill at once, so the
// coordinator folds this into the next SKILL version at merge.
// (translated, adapted to write_scene/render_scene; REDACTED-only parts dropped:
// reference/ guides, sfx recipes, stills.ts, styles/ paths, the inspector)

/** Scenes in general: when to use which graphics tool, and the scene file shape. */
export const SCENES_SKILL_TEXT = `## Native scenes (Remotion)

Three ways to make a graphic, cheapest first:
- make_graphic: a designed template (title card, lower third…) filled from its schema. Use it when one fits.
- render_scene with a built-in (list_scenes): Title, LowerThird, Hook, Annotate, Sparkles, ProgressBar, Rec, WordStack, Flash. Pass only the props you change.
- write_scene, then render_scene: your own scene, when no template or built-in says it. render_graphic (HTML/GSAP) still works.

A scene file:
\`\`\`tsx
import {AbsoluteFill, interpolate, useCurrentFrame, curves, clamp, z, color, num} from './kit';
import type {SceneBase} from './types';
export const schema = z.object({text: z.string(), accent: color('Accent'), size: num(40, 200)});
export const defaultProps: z.infer<typeof schema> = {text: 'Hi', accent: '#ffd400', size: 120};
export default function Scene(p: z.infer<typeof schema> & SceneBase) {
  const f = useCurrentFrame();
  const y = interpolate(f, [0, 20], [60, 0], {easing: curves.flowIn, ...clamp});
  return <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
    <div style={{transform: \`translateY(\${y}px)\`, fontSize: p.size, color: p.accent}}>{p.text}</div>
  </AbsoluteFill>;
}
\`\`\`
- Lay out in the 1080-px-short-side frame (useVideoConfig gives width and height); place by fractions of them.
- Everything comes from the frame: random(seed) from ./kit, never Math.random, Date or timers.
- Transparent where you draw nothing: the speaker shows through. An opaque scene (papercraft, pixel art) covers the frame; keep it short or use it as a cutaway.
- The gate and type check reject bad files with line numbers: fix and write again under the same name.
- Check the stills render_scene returns before you place it.`;

/** Papercraft: from REDACTED papercraft/SKILL.md §0-§4, §6, the puppet example. */
export const PAPERCRAFT_SKILL_TEXT = `## Papercraft scenes

A papercraft scene is a photographed cardboard model: printed, cut cards unfold on a hinge from a printed ground, rise fast,
overshoot a little and settle; light comes from one side, soft shadows take the world's colour; a long lens looks down on the
model, a sharp band in the middle, blur above and below. Built on the papercraft lib (github.com/xikhar/papercraft, MIT).

### The twelve laws
1. Everything is a sheet with a thickness: cut, fold, stack, slot; never a sculpted volume. Round upright things (trees, posts, tents) = two cards slotted in a cross; low things = one card facing the camera.
2. Matte, no gloss.
3. One key light from the side, a little toward the camera; soft shadows in the world's colour (amber by day, lilac on snow, night blue), never grey or black; every piece touches the ground.
4. Each print is a small paper collage: 3 to 5 inks in 3 values, one ornament, one contrasting accent; each layer has a short shadow and a light edge on the lit side.
5. The cut edge: a thin dark-brown line, a light highlight on the lit side only. Never a white halo all round.
6. A macro lens looking down (40-55°); the ground runs past every edge: no sky, horizon or table.
7. The palette comes from the subject, never from the example: a pale soft ground, one colour family carried by the pieces, contrasting accents; paper greens, cream not white, ink not black.
8. Dense and readable: a real model world (groups of 4 to 8 different pieces, at most 3 alike in view), not three props on a plain.
9. What you cross, pass under or enter is built (bridge, stairs, folded house), never a standing card.
10. Paper moves by turning on its folds: it rises fast, overshoots 8-15% with 2 or 3 quivers, settles in 1 s; nothing grows, stretches or fades in.
11. (Sound: none here.)
12. The world lives with its own things: 3 to 5 kinds (leaves, snow, birds, smoke, cloud shadows, animals), small and slow.

### The scene
\`\`\`tsx
import {z, color, num} from './kit';
import {PaperStage, P2, P3, createLife, type PaperHarness} from './paper';
import type {SceneBase} from './types';
export const schema = z.object({ground: color('Ground'), roof: color('Roofs'), start: num(0, 4, 0.1)});
type Props = z.infer<typeof schema>;
export const defaultProps: Props = {ground: '#d9cfb4', roof: '#c8513b', start: 0};
function build(p: Props) {
  return (H: PaperHarness) => {
    H.printGround(({washes}: any) => { washes([p.ground, P2.shade(p.ground, -0.05)]); /* this world's ground */ });
    // pieces: H.popup(outline, paint, {x, z, cross, sway, scale}), H.stack, H.dome, H.printed, H.lamp, H.glowing
    H.riseAt = 0.6; // the printed ground alone first, then the cards unfold
  };
}
export default function Scene(p: Props & SceneBase) {
  return <PaperStage options={{ground: p.ground, mood: 'day', view: {pitch: 47, dist: 66, target: [2, 1.5, -6]}}}
    build={build(p)} deps={[p.ground, p.roof]} start={p.start} />;
}
\`\`\`
- Import everything from './paper': PaperStage, P2 (shapes, prints, colours), P3 (material, cards, hinges, crosses, folds, platforms), paperMotion, createLife (the world's life), builtGround (bridge, stairs, ramp, terrace, house), and the full example COUNTRYSIDE + countryside. They are untyped (any): read the stage harness type PaperHarness for H.
- build(H) lays the world once. H gives printGround, popup, stack, dome, printed, cardOpts, lamp, glowing, setHero, heroWalk, onStep, onRestart, groundAt, inFrame, sharpAt, view, target, scene, camera, paper. deps: the props that rebuild the scene.
- Main colours are props (color('…')): the ground, the colour family, one or two accents, the hero's costume, the object that matters (5 to 8 at most). Derive other tints with P2.shade and P2.mix, not hard-coded.
- Time: every video frame replays the stage clock from 0 (60 steps a second). What moves beyond the hinges (a wheel, a lamp, the camera) goes in H.onStep((t, dt) => …) and resets in H.onRestart. Randomness: P2.rng(seed), never Math.random or the clock.
- Camera: options.view (pitch 40-55, dist, fov 24-32, target); it drifts gently by itself. One camera move per shot: in H.onStep move H.target or change H.view.dist, H.view.tyaw, H.view.tpitch.
- Light: options.mood: day, golden, dusk, night, or a preset from papercraft/reference/lights.json (overcast, mist, snow-bright, aquatic, hard-noon, soft-spring…); then options.light (colours, direction, leak = shadow colour) and options.lens (focusBand, maxBlur, haze, exposure). Focus on options.focus ([x, y, z]), else the hero, else target.
- A hero to follow (nearly always: a film is about someone): a paper puppet seen one card at a time: front when coming toward the camera, back when leaving, profile when crossing; never two faces mixed. viewFigure(H, {front, back, side, leg, legSide, legLen}): three drawings of body and head (P2.drawnPiece; the profile faces right and turns by itself), a leg front and side. Big head, small body, colours that cut against the ground, one costume detail, a pose that says its state.
  const fig = viewFigure(H, …); H.setHero(H.popup(null, null, {node: fig, height, x, z, scale}), {stride: fig.userData.stride}); then H.heroWalk([{at, x, z}, …], {lead: [dx, dz]}): it walks between points (two points at the same place = it stops), limbs swing, feet follow the ground or a bridge, the camera follows. To follow someone bring the camera close (dist 30-40, not 66): the hero is then 10-15% of the frame height.
- No text in the scene: a title goes on a separate graphic above, beside the subject.
- Cost: building prints every card (a few seconds for 200 pieces). One papercraft scene on screen at a time (each has its own WebGL context). Split a film into shots.
- A cut-out shape (shelter, arch, window, grid): P2.drawnPiece keeps only the outer outline; cut its openings with holes on H.popup.
- Tall things (chimneys, towers, a smoke source) leave the top of a down-looking frame: keep them in the middle band or nearer.
- Smoke: createLife().puffs (paper discs cut in a spiral); dirty smoke takes dark colours, not another shape.
- Write your own pieces. Read the countryside example to see how a recipe becomes code; never rebuild another subject from its parts, colours or river.

### Before the code
Write a short brief at the top of the file (subject, palette, light, lens, ground, layout, motion, life, banned), with numbers. Ask: would I write the same brief for another subject? If so, push palette, prints and silhouettes toward this subject (a dome on Mars: rust cards with rivets; a reef: scalloped corals).

### Story, then the shot
- The story first, from the request: what happens from start to end, what changes, what it ends on. An overview where nothing happens is not a story. Say the story you chose in your reply.
- A shot of 4-8 s (a hook: 3-4 s): 0.5-1 s of flat printed ground (H.riseAt), then the cards unfold in 1-1.5 s, near to far, then at least 2 s of living world (createLife).
- One opening per film: only the first shot starts flat; later shots open already unfolded (start 2-3 s) and alive.
- One camera move per shot: still with its drift, a slow track, or a slow pull-back; a slide from one framing to another takes ~0.9 s.
- Cuts between shots are hard cuts. Folding a world away (end of film): H.setOpen(false) once in H.onStep at the right time (a flag, reset in H.onRestart).

### Check the stills
One flat, one mid-unfold, one settled, one holding:
- Ground past every edge; no sky or horizon; a sharp band on the subject, blur above and below.
- Groups of different pieces, no copies; colours of this subject, not the example; shadows in the world's colour, never grey.
- Every piece touches the ground; thin cut edge lit on one side only; no card seen edge-on.
- Each print is a collage (3 values, an ornament, an accent), never a flat fill.
- During the unfold, cards turn on their fold; nothing grows or fades in.
When in doubt, take something out: calmer, softer, less.`;

/** Pixel art: from REDACTED pixel-art/SKILL.md §0-§7, §9 and MOTEUR.md (the engine is in ./pixel). */
export const PIXEL_SKILL_TEXT = `## Pixel-art scenes

A pixel-art scene is drawn by code on a fine grid. Four choices make the look; all four together, or it looks like a blurred image blown up:
1. One fine grid only: everything is drawn at about 640 dots on the long side (360 × 640 vertical, 640 × 360 landscape), then scaled up with sharp pixels. Text, lines and moves land on that grid. Never big pixels beside small ones.
2. A short palette: one world = one colour family, near-black to light (5 to 6 tones), plus one warm accent kept for what gives light.
3. Dither instead of gradients: shadows, skies, halos and reflections are checkerboard dots, never a smooth fade.
4. Steps: 12 poses a second, moves of whole dots, no blur.
Signs of sloppy pixel art: squares too big (a grid 90 dots wide), flat fills with no shadow, a light with no halo, smoothed text on top, smooth motion.

### The engine (./pixel)
\`\`\`tsx
import {z, color} from './kit';
import {PixelCanvas, usePose, rgb, mix, dot, pixelFont, type Pix} from './pixel';
import type {SceneBase} from './types';
export const schema = z.object({sky: color('Sky, top'), sea: color('Sea'), lamp: color('Lamp')});
export const defaultProps: z.infer<typeof schema> = {sky: '#1b1f3a', sea: '#2d3f6b', lamp: '#ffb347'};
export default function Scene(p: z.infer<typeof schema> & SceneBase) {
  const {pose} = usePose();
  const ramp = [rgb(p.sky), rgb(p.sea)];
  return <PixelCanvas draw={(g: Pix) => {
    g.paint(0, 0, g.w, g.h, (x, y) => mix(ramp, y / g.h, x, y));
    const cx = Math.round(g.w * 0.7), cy = Math.round(g.h * 0.3), r = 40;
    g.paint(cx - r, cy - r, 2 * r, 2 * r, (x, y) => {const d = Math.hypot(x - cx, y - cy); return d < r && dot(x, y, (1 - d / r) ** 2) ? rgb(p.lamp) : null;});
    if (pose % 9 < 5) g.px(20, 20, rgb('#ffffff'));
  }} />;
}
\`\`\`
- Never draw in CSS (no border-radius, gradient, filter, opacity or transform on the canvas): everything goes through the canvas.
- Pix g: g.w, g.h (grid size), px, rect, paint(x, y, w, h, f) (dot by dot; with dot and mix: dithers, halos, volumes), line (dash), sprite(rows, x, y, colors, flip) (a drawing as rows of letters), text(s, x, y, {font, size, color, align, shadow}) (no smoothing), erase(a) (dithered exit), mirror(horizon, depth, shift, keep) (reflections).
- Place everything from g.w and g.h, never from 360 × 640 written in. Never scale a pixel scene in CSS: a dot would be 1.46 pixels and moiré the dither.
- Each colour is a prop (color('Sky, top')), and so is the subject's place (x, y).
- Randomness: random('star-' + i) from ./kit, never Math.random.

### Palette
- Darkest to lightest: ink (silhouettes, hard shadows), 3 background tones, a half-light, a light. Plus one warm accent for what gives light (lamp, sun, screen, fire). A second accent only if it means something else.
- Background and subject do not share their lightest tone: the subject stands out by value, not by outline.
- A new place or time = a new palette. Changing palette inside a scene is an event (night falling, an eclipse).
- Text takes the world's light tone, its shadow the ink, the key word the accent.

### Dither
- Where: a sky or sea (mix over 3 or 4 tones), the shadow side of a volume, the halo round a light (dense near it, fading with the square of distance), a beam, dust, a reflection.
- Never in text or in a drawing under about 20 dots: those stay flat.
- A halo stops at its radius (d < r && dot(…)): a squared dither computed past it draws the corners of its box.
- Light comes from one side in the whole film. A lit edge one dot wide on the light side makes the volume.

### The subject
- Silhouette first: in ink alone you must recognise the thing; if not, change pose or angle, not details.
- Big shapes by geometry in g.paint (disc, band, profile, cone); small things (boat, bird, figure, icon) as g.sprite.
- The subject takes real space: at least a quarter of the width.
- A walking figure: drive the limbs from the gesture. A step = a turning phase (8 poses a cycle); a leg is two strokes (hip, knee, foot), the foot lifts as it moves forward, the body drops one dot when the legs are apart, arms go against the legs. It moves forward by its stride each half-cycle, or the planted foot slides. A foot on a pedal, a hand on a bar: fix it to the object and solve the knee or elbow (two lengths, bent the right way).
- Size: a passer-by at least 55-60 dots tall, a hero (an animal on a bike) 150 dots wide. Frame the set to match: a street seen close, not a city from afar.
- Things that turn or scroll match the ground's speed: a wheel turns (speed ÷ radius) per pose; the background scrolls in planes, slower toward the distance.
- Water: g.mirror flips sky and set, offsets each row (ripples) and drops one in three; a few light glints under the light source.

### Motion
- Everything from usePose(): pose advances 12 times a second. Put events on twelfths of a second.
- A move is a whole number of dots (Math.round). An arrival keeps the pro rhythm (fast, then settling), sampled per pose: big steps, small steps, stop. Never MotionBlur or fades.
- A change of state happens at once, on one pose: a box filling, an object growing one dot, a lamp coming on. A change that matters can take a one-pose flash (the whole image dithered light).
- During a hold the world lives while the hero stays still: stars blinking, water rippling, a lamp turning, each on its own period (9, 5, 3 poses) so nothing beats together.
- A text exits with g.erase over its last 4 poses. A scene exits on a cut.

### Text
- The renderer ships Inter and JetBrains Mono, not a pixel font: pixelFont('JetBrains Mono', 700, size) drawn with g.text has no smoothing. Check in the stills that C does not read as O, nor 3 as 8: too bold and letters fill in.
- Sizes in grid dots: title 44-56, number 40-48, label 16-20. In vertical, nothing in the top 85 dots, the bottom 160 or the right 40 (app UI).
- Title: stacked capitals, left-aligned, typed 2 letters per pose with a block cursor; a pause at each line.
- Number: a label above, the number below, in a box with a 2-dot stroke and a hard shadow. It rolls (countSteps from ./kit) then lands on its real value.
- One text on screen at a time, beside the subject, never on it.

### Cuts
- Hard cuts. The best cut keeps a shape or pose in the same place from one world to the next (the Moon's disc becomes the one hiding the Sun).
- No mosaic wipes or filling cells.

### Check the stills
For each scene: one at the arrival, one holding, one at the text exit.
- The subject reads at a glance, and you know what to look at first.
- Nothing smooth: no soft edge, no continuous gradient, no smoothed letter.
- Every number and letter reads (C and O, 3 and 8).
- Text touches neither the subject nor the app-UI zones.`;

/** Text behind the speaker (place_graphic behindSubject). */
export const BEHIND_SUBJECT_SKILL_TEXT = `## Text behind the speaker
- place_graphic with behindSubject: true cuts the speaker out at export and draws them over the graphic: a big word that sits behind the head.
- Use it on a full-frame graphic that is see-through around its text, with the text large and partly behind the speaker, never so far behind that the word stops reading. Once or twice a video, on a line that matters.
- Not over b-roll (the speaker is not on screen there) or a pip shot.
- Needs the subject mask model; without it the graphic is drawn over the speaker and the render reports it. The stills you check do not show the cut-out: judge the overlap from the speaker's place in the frame.`;
