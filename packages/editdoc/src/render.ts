// How an EditDoc looks and sounds once rendered. VoxTale Desktop (through its
// editor adapter) and the cloud renderer both read these, so one doc gives the
// same picture and mix wherever it renders. Pure: no I/O.
import type { EditDoc, TextItem, ZoomCurve, ZoomItem } from "./schema";
import type { CaptionAnimation } from "./style";

export type Span = [number, number];

const MAX_VOLUME = 4;
const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** Decibels to a linear gain, capped at 4× (+12 dB). */
export function dbToVolume(db: number): number {
  return Math.min(MAX_VOLUME, Math.max(0, Math.round(10 ** (db / 20) * 10000) / 10000));
}

/**
 * Where someone speaks, in output seconds: a-roll with sound and voiceover.
 * Pauses shorter than `join` stay ducked, so music does not pump between words.
 */
export function speechSpans(doc: EditDoc, join: number): Span[] {
  const sounding = new Set(doc.clips.filter((c) => c.hasAudio).map((c) => c.id));
  const spans = [...doc.tracks["a-roll"], ...doc.tracks.voiceover]
    .filter((i) => i.status !== "suggested" && i.end > i.start && i.gainDb > -60 && sounding.has(i.clipId))
    .map((i): Span => [i.start, i.end])
    .sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last && s[0] - last[1] < join) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/** Speech spans with the join the mix settings imply. */
export function mixSpeech(doc: EditDoc): Span[] {
  return speechSpans(doc, Math.max(1, doc.mix.duckAttack + doc.mix.duckRelease));
}

/**
 * Ducking as volume points for a clip at [start, start + duration): `base` in
 * the gaps, `ducked` under speech, ramping over `attack` before speech starts
 * and `release` after it ends. Empty when no speech touches the clip.
 */
export function duckPoints(spans: Span[], start: number, duration: number, base: number, ducked: number, attack: number, release: number): { time: number; value: number }[] {
  const end = start + duration;
  const curve: { time: number; value: number }[] = [];
  for (const [s, e] of spans) {
    if (e + release <= start || s - attack >= end) continue;
    curve.push({ time: s - attack, value: base }, { time: s, value: ducked }, { time: e, value: ducked }, { time: e + release, value: base });
  }
  if (!curve.length) return [];
  const at = (t: number) => {
    if (t <= curve[0]!.time) return curve[0]!.value;
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1]!, b = curve[i]!;
      if (t <= b.time) return b.time === a.time ? b.value : a.value + ((b.value - a.value) * (t - a.time)) / (b.time - a.time);
    }
    return curve.at(-1)!.value;
  };
  const points = [{ time: 0, value: at(start) }];
  for (const p of curve) if (p.time > start && p.time < end) points.push({ time: p.time - start, value: p.value });
  points.push({ time: duration, value: at(end) });
  return points
    .map((p) => ({ time: round4(p.time), value: round4(p.value) }))
    .filter((p, i, all) => i === 0 || p.time > all[i - 1]!.time);
}

/** A clip's audio envelope: linear fade in and out, as the editor plays it. */
export function fadeGain(t: number, duration: number, fadeIn: number, fadeOut: number): number {
  const a = fadeIn > 0 ? Math.min(1, Math.max(0, t / fadeIn)) : 1;
  const b = fadeOut > 0 ? Math.min(1, Math.max(0, (duration - t) / fadeOut)) : 1;
  return Math.min(a, b);
}

/** Seconds of fade at each end of an a-roll item: the mix's cut fade, at most half the item. */
export function cutFade(doc: EditDoc, duration: number): number {
  return doc.mix.cutFades > 0 ? Math.min(doc.mix.cutFades, duration / 2) : 0;
}

// ---- picture ---------------------------------------------------------------

export type Easing = "linear" | "ease-in-out" | "hold" | "snap" | "build" | "settle";

/** Overshoot of the "settle" curve: 1.2 peaks about 5% past the target. Our own pick, tuned by eye. */
export const SETTLE_BACK = 1.2;

/** Progress 0..1 through a key-to-key move, shaped by the earlier key's easing. */
export function ease(easing: Easing, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (easing) {
    case "hold": return x >= 1 ? 1 : 0;
    case "ease-in-out": return x < 0.5 ? 2 * x * x : -1 + (4 - 2 * x) * x;
    case "snap": return 1 - (1 - x) ** 3;
    case "build": return x ** 3;
    case "settle": { const u = x - 1; return 1 + (SETTLE_BACK + 1) * u ** 3 + SETTLE_BACK * u ** 2; }
    default: return x;
  }
}

/** The easing a zoom curve name plays as. */
export const curveEasing = (c: ZoomCurve | undefined): Easing => (!c || c === "smooth" ? "ease-in-out" : c);

/**
 * The a-roll's zoom at one moment: scale about the frame centre, then a shift
 * as a fraction of the frame. A zoom about focus f has shift (f - 0.5)(1 - s);
 * keeping it as a shift lets two zooms blend linearly without the crop ever
 * leaving the frame.
 */
export interface ZoomState { scale: number; dx: number; dy: number }
export const WIDE: ZoomState = { scale: 1, dx: 0, dy: 0 };

type ZoomSpan = Pick<ZoomItem, "start" | "end" | "scale" | "x" | "y" | "easeIn" | "easeOut" | "panTo" | "status"> & Partial<Pick<ZoomItem, "curveIn" | "curveOut">>;
/** Two zooms this close count as touching: the first glides into the second. */
const TOUCH = 1e-3;

const about = (scale: number, x: number, y: number): ZoomState => ({ scale, dx: (x - 0.5) * (1 - scale), dy: (y - 0.5) * (1 - scale) });
const blend = (a: ZoomState, b: ZoomState, p: number): ZoomState =>
  ({ scale: a.scale + (b.scale - a.scale) * p, dx: a.dx + (b.dx - a.dx) * p, dy: a.dy + (b.dy - a.dy) * p });

/** Fully zoomed state of `z` at `t` (focus part-way along its pan). */
function held(z: ZoomSpan, t: number): ZoomState {
  if (!z.panTo) return about(z.scale, z.x, z.y);
  const p = ease("ease-in-out", (t - z.start) / (z.end - z.start));
  return about(z.scale, z.x + (z.panTo.x - z.x) * p, z.y + (z.panTo.y - z.y) * p);
}

function zoomPhase(items: ZoomSpan[], t: number): { state: ZoomState; ramp: Easing | false } {
  const live = shown(items).sort((a, b) => a.start - b.start);
  const k = live.findIndex((z) => z.start <= t && t < z.end);
  if (k < 0) return { state: WIDE, ramp: false };
  const z = live[k]!, prev = live[k - 1], next = live[k + 1];
  const into = prev && Math.abs(prev.end - z.start) < TOUCH ? held(prev, prev.end) : WIDE;
  const outOf = !(next && Math.abs(next.start - z.end) < TOUCH);
  const local = t - z.start;
  // Curves shape each move in time order: in from wide (or the zoom before), out to wide.
  if (local < z.easeIn) { const c = curveEasing(z.curveIn); return { state: blend(into, held(z, t), ease(c, local / z.easeIn)), ramp: c }; }
  if (outOf && z.end - t < z.easeOut) { const c = curveEasing(z.curveOut); return { state: blend(held(z, t), WIDE, ease(c, 1 - (z.end - t) / z.easeOut)), ramp: c }; }
  return { state: held(z, t), ramp: false };
}

/**
 * Zoom at output time `t` from the zoom track. A zoom eases in from the wide
 * frame (or glides from the zoom it touches), holds, and eases out unless the
 * next zoom starts where it ends. Desktop preview, desktop export and the
 * cloud render all read this.
 */
export function zoomAt(items: ZoomSpan[], t: number): ZoomState {
  return zoomPhase(items, t).state;
}

export type ZoomProperty = "scale" | "position.x" | "position.y";
export interface ZoomKey { time: number; property: ZoomProperty; value: number; easing: Easing }

/** Pan samples per second inside a zoom whose focus moves. */
const PAN_STEP = 0.25;

/**
 * The zoom track over output [from, to) as keys from `from`: scale about the
 * centre and a shift in canvas pixels, for renderers that interpolate keys.
 * Positions are left out when nothing shifts. A cut-in zoom shows as two keys
 * at the same time.
 */
export function zoomKeysBetween(items: ZoomSpan[], from: number, to: number, canvas: { width: number; height: number }): ZoomKey[] {
  const live = shown(items).filter((z) => z.end > from && z.start < to);
  if (!live.length) return [];
  const marks = new Set([from, to]);
  for (const z of live) {
    for (const m of [z.start, z.start + z.easeIn, z.end - z.easeOut, z.end]) marks.add(m);
    if (z.panTo) for (let m = z.start; m < z.end; m += PAN_STEP) marks.add(m);
  }
  const times = [...marks].filter((m) => m >= from && m <= to).sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const states: { time: number; state: ZoomState; easing: Easing }[] = [];
  const differ = (a: ZoomState, b: ZoomState) => Math.abs(a.scale - b.scale) + Math.abs(a.dx - b.dx) + Math.abs(a.dy - b.dy) > 1e-4;
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!, next = times[i + 1];
    const at = zoomAt(live, t);
    if (i > 0) {
      const before = zoomAt(live, t - 1e-4);
      if (next === undefined) { states.push({ time: t, state: before, easing: "linear" }); break; }
      // A cut-in or cut-out: close the last stretch on its own value, then jump.
      if (differ(before, at)) states.push({ time: t, state: before, easing: "linear" });
    }
    if (next === undefined) break;
    states.push({ time: t, state: at, easing: zoomPhase(live, (t + next) / 2).ramp || "linear" });
  }
  const shifted = states.some((s) => Math.abs(s.state.dx) > 1e-6 || Math.abs(s.state.dy) > 1e-6);
  return states.flatMap(({ time, state, easing }) => [
    { time: r(time - from), property: "scale" as const, value: r(state.scale), easing },
    ...(shifted ? [
      { time: r(time - from), property: "position.x" as const, value: r(state.dx * canvas.width), easing },
      { time: r(time - from), property: "position.y" as const, value: r(state.dy * canvas.height), easing },
    ] : []),
  ]);
}

/** One property's value at `t`, as the editor interpolates it. */
export function keyValue(keys: ZoomKey[], property: ZoomProperty, t: number, fallback: number): number {
  const ks = keys.filter((k) => k.property === property).sort((a, b) => a.time - b.time);
  if (!ks.length) return fallback;
  if (t <= ks[0]!.time) return ks[0]!.value;
  const last = ks.at(-1)!;
  if (t >= last.time) return last.value;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!, b = ks[i + 1]!;
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      return a.value + (b.value - a.value) * ease(a.easing, span > 0 ? (t - a.time) / span : 0);
    }
  }
  return last.value;
}

type Brand = EditDoc["styleRef"]["snapshot"]["brand"];

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Share of frame height each template's text takes, and where it sits when captions are clear of it. */
const TEXT_SIZE: Record<string, number> = { title: 0.09, chapter: 0.06, lowerThird: 0.045, callout: 0.05 };
const TEXT_Y: Record<string, number> = { title: 0.5, chapter: 0.14, lowerThird: 0.84, callout: 0.26 };
/** Captions fill this band of the frame, by caption position. */
const CAPTION_BAND: Record<string, [number, number]> = { bottom: [0.74, 0.96], middle: [0.4, 0.6], top: [0.04, 0.26] };

export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
export type TextOverrides = NonNullable<TextItem["look"]>;

export interface TextLook {
  fontFamily: string;
  fontSize: number;
  fontWeight: FontWeight;
  textAlign: "center";
  color: string;
  backgroundColor?: string;
  shadowColor?: string;
  shadowBlur?: number;
}

/** Template look in the creator's brand: colours, heading font; `look` is the creator's override. */
export function textLook(template: string, brand: Brand, height: number, look?: TextOverrides): TextLook {
  const out = templateLook(template, brand, height);
  if (!look) return out;
  if (look.fontFamily) out.fontFamily = look.fontFamily;
  if (look.fontSize) out.fontSize = Math.round((look.fontSize * height) / 1080);
  if (look.fontWeight) out.fontWeight = look.fontWeight as FontWeight;
  if (look.color) out.color = look.color;
  if (look.backgroundColor === "none") delete out.backgroundColor;
  else if (look.backgroundColor) out.backgroundColor = look.backgroundColor;
  return out;
}

function templateLook(template: string, brand: Brand, height: number): TextLook {
  const base = {
    fontFamily: brand.fonts.heading,
    fontSize: Math.round(height * (TEXT_SIZE[template] ?? TEXT_SIZE.title!)),
    fontWeight: 700 as FontWeight,
    textAlign: "center" as const,
  };
  switch (template) {
    case "lowerThird":
      return { ...base, fontFamily: brand.fonts.body, color: brand.colors.text, backgroundColor: rgba(brand.colors.primary, 0.88) };
    case "callout":
      return { ...base, color: brand.colors.background, backgroundColor: rgba(brand.colors.accent, 0.95) };
    default:
      return { ...base, fontWeight: 800, color: brand.colors.text, shadowColor: "rgba(0,0,0,0.65)", shadowBlur: 14 };
  }
}

/** Centre of the text in frame fractions: inside the safe margins and clear of the caption band. */
export function textPosition(
  template: string,
  position: string,
  o: { text: string; brand: Brand; captions: string | null; width: number; height: number; fontSize?: number },
): { x: number; y: number } {
  const m = o.brand.safeMargins;
  const size = o.fontSize ?? o.height * (TEXT_SIZE[template] ?? TEXT_SIZE.title!);
  const lines = o.text.split("\n");
  const halfW = Math.min(0.5 - m, (Math.max(...lines.map((l) => l.length)) * size * 0.56 + 20) / o.width / 2);
  const halfH = (lines.length * size * 1.2) / o.height / 2;
  let x = 0.5;
  let y = TEXT_Y[template] ?? 0.5;
  if (position === "top") y = 0.14;
  else if (position === "bottom") y = 0.84;
  else if (position === "center") y = 0.5;
  if (position === "left" || (position === "auto" && template === "lowerThird")) x = m + halfW;
  else if (position === "right") x = 1 - m - halfW;
  const band = o.captions ? CAPTION_BAND[o.captions] : undefined;
  if (band && y + halfH > band[0] && y - halfH < band[1]) {
    // Move to whichever side of the captions has room, nearest first.
    const above = band[0] - halfH - 0.02;
    const below = band[1] + halfH + 0.02;
    y = below <= 1 - m - halfH && (above < m + halfH || below - y < y - above) ? below : above;
  }
  const clamp = (v: number, h: number) => Math.min(1 - m - h, Math.max(m + h, v));
  return { x: Math.round(clamp(x, halfW) * 1000) / 1000, y: Math.round(clamp(y, halfH) * 1000) / 1000 };
}

/** Text an item shows: its line, and the subline under it. */
export function textContent(item: { text: string; subtext?: string | undefined }): string {
  return item.subtext ? `${item.text}\n${item.subtext}` : item.text;
}

/** Where captions sit when the doc shows any, else null. */
export function captionPlacement(doc: EditDoc): string | null {
  const { brand, pace } = doc.styleRef.snapshot;
  return pace.captions !== "off" && doc.tracks.captions.length ? brand.captionStyle.position : null;
}

export interface CaptionLook {
  fontFamily: string;
  fontSize: number;
  color: string;
  highlightColor: string;
  /** Behind the whole line; "none" when the look has no box. */
  backgroundColor: string;
  position: "bottom" | "center" | "top";
  fontWeight: number;
  uppercase: boolean;
  strokeColor: string;
  /** Canvas px; 0 = no outline. */
  strokeWidth: number;
  /** Canvas px of blur; 0 = no shadow. */
  shadow: number;
  animation: CaptionAnimation;
}

/** How far the spoken word grows in the "pop" look, and how long it takes. */
export const CAPTION_POP = { scale: 1.14, seconds: 0.08 } as const;
/** Opacity of words not yet said in the "karaoke" look. */
export const CAPTION_DIM = 0.45;

export interface CaptionWordState {
  text: string;
  /** Being said now. */
  active: boolean;
  /** Already said. */
  spoken: boolean;
}

/**
 * The words of a caption at `t` seconds after its start, for looks that
 * follow the voice. Undefined when the caption has no usable word times, so
 * the renderer shows the line whole. A word stays active until the next one
 * starts: the highlight never drops out between words.
 */
export function captionWords(c: { text: string; wordStarts?: number[] }, t: number): CaptionWordState[] | undefined {
  const texts = c.text.split(/\s+/).filter(Boolean);
  const at = c.wordStarts;
  if (!at || at.length !== texts.length || !texts.length) return undefined;
  let active = 0;
  for (let k = 0; k < at.length; k++) if (at[k]! <= t + 1e-6) active = k;
  return texts.map((text, k) => ({ text, active: k === active, spoken: k < active }));
}

/** Caption text as the look shows it. */
export const captionText = (text: string, look: Pick<CaptionLook, "uppercase">): string => (look.uppercase ? text.toUpperCase() : text);

/**
 * Caption sizes are px on a 1080 canvas, measured on its short side: the
 * same type fills the same share of the width upright and on its side.
 */
export const captionScale = (canvas: { width: number; height: number }): number => Math.min(canvas.width, canvas.height) / 1080;

/** How captions look, from the edit style. */
export function captionLook(doc: EditDoc): CaptionLook {
  const { brand } = doc.styleRef.snapshot;
  const c = brand.captionStyle;
  return {
    fontFamily: c.font ?? brand.fonts.body,
    fontSize: Math.round(c.size * captionScale(doc.canvas)),
    color: c.color,
    highlightColor: c.highlight,
    backgroundColor: c.box === "none" ? "none" : c.background,
    position: c.position === "middle" ? "center" : c.position,
    fontWeight: c.weight,
    uppercase: c.case === "upper",
    strokeColor: c.strokeColor,
    strokeWidth: c.strokeWidth * captionScale(doc.canvas),
    shadow: c.shadow * captionScale(doc.canvas),
    animation: c.animation,
  };
}

/** Items the render shows: suggestions and empty items stay off. */
export function shown<T extends { status: string; start: number; end: number }>(items: T[]): T[] {
  return items.filter((i) => i.status !== "suggested" && i.end - i.start > 0);
}

/**
 * Hashes of the clips a render reads: every shown picture on a-roll and
 * b-roll, and every shown sound whose clip has audio. The cloud render needs
 * these files uploaded whole.
 */
export function renderClipHashes(doc: EditDoc): string[] {
  const clips = new Map(doc.clips.map((c) => [c.id, c]));
  const out = new Set<string>();
  const add = (clipId: string, sound: boolean) => {
    const c = clips.get(clipId);
    if (c && (!sound || (c.hasAudio && c.kind !== "image"))) out.add(c.hash);
  };
  for (const i of [...shown(doc.tracks["a-roll"]), ...shown(doc.tracks["b-roll"])]) add(i.clipId, false);
  for (const i of [...shown(doc.tracks.music), ...shown(doc.tracks.sfx), ...shown(doc.tracks.voiceover)]) add(i.clipId, true);
  return [...out];
}

/**
 * Lane per item so overlapping items on one track sit on separate lanes; lane 0
 * draws on top. Items keep their order in `items`.
 */
export function lanes<T extends { start: number; end: number }>(items: T[]): number[] {
  const ends: number[] = [];
  const order = items.map((item, i) => ({ item, i })).sort((a, b) => a.item.start - b.item.start);
  const lane: number[] = new Array(items.length);
  for (const { item, i } of order) {
    let l = ends.findIndex((end) => end <= item.start + 1e-6);
    if (l < 0) l = ends.push(0) - 1;
    ends[l] = item.end;
    lane[i] = l;
  }
  return lane;
}

// ---- loudness ----------------------------------------------------------------

export interface LoudnessLevel { lufs: number; truePeakDb: number }

/** Within this many LU the mix is left alone. */
export const LOUDNESS_TOLERANCE = 1;
const MAX_LOUDNESS_GAIN = 24;

/** dB to add to land on the target, or 0 when the mix is close enough. */
export function loudnessGain(measured: LoudnessLevel, target: LoudnessLevel): number {
  const gain = target.lufs - measured.lufs;
  if (Math.abs(gain) < LOUDNESS_TOLERANCE && measured.truePeakDb <= target.truePeakDb) return 0;
  return Math.round(Math.max(-MAX_LOUDNESS_GAIN, Math.min(MAX_LOUDNESS_GAIN, gain)) * 10) / 10;
}

/** Sample-peak limit, linear, half a dB under the true-peak target. */
export function limiterCeiling(truePeakDb: number): number {
  return Math.min(1, 10 ** ((truePeakDb - 0.5) / 20));
}

/** Integrated loudness and peak from ffmpeg's `ebur128=peak=true` summary; undefined for silence. */
export function parseLoudness(stderr: string): LoudnessLevel | undefined {
  const tail = stderr.slice(stderr.lastIndexOf("Summary:"));
  const lufs = /I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(tail)?.[1];
  const peak = /Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(tail)?.[1];
  // ebur128 reports silence as -70 LUFS, its gate floor.
  if (!lufs || !peak || lufs === "-inf" || Number(lufs) <= -69.9) return undefined;
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  return { lufs: clamp(Number(lufs), -70, 10), truePeakDb: peak === "-inf" ? -70 : clamp(Number(peak), -70, 20) };
}

/** Share of the canvas width the speaker's corner picture takes, and its gap from the edges. */
export const PIP = { scale: 0.28, tallScale: 0.36, margin: 0.03 } as const;

/**
 * Where the speaker's corner picture sits, in canvas pixels: the canvas
 * shape, scaled down. Preview, export and the cloud render all read this.
 */
export function pipBox(canvas: { width: number; height: number }, corner: "top-left" | "top-right" | "bottom-left" | "bottom-right"): { x: number; y: number; width: number; height: number } {
  const s = canvas.height > canvas.width ? PIP.tallScale : PIP.scale;
  const even = (n: number) => 2 * Math.round(n / 2);
  const width = even(canvas.width * s), height = even(canvas.height * s), m = Math.round(canvas.width * PIP.margin);
  return { x: corner.endsWith("left") ? m : canvas.width - m - width, y: corner.startsWith("top") ? m : canvas.height - m - height, width, height };
}

/** Split layout: left and right halves, or top and bottom on a tall canvas. Preview, render and export read this. */
export function splitBoxes(c: { width: number; height: number }): [{ x: number; y: number; width: number; height: number }, { x: number; y: number; width: number; height: number }] {
  if (c.height > c.width) {
    const h = Math.round(c.height / 2 / 2) * 2;
    return [{ x: 0, y: 0, width: c.width, height: h }, { x: 0, y: h, width: c.width, height: c.height - h }];
  }
  const w = Math.round(c.width / 2 / 2) * 2;
  return [{ x: 0, y: 0, width: w, height: c.height }, { x: w, y: 0, width: c.width - w, height: c.height }];
}

/**
 * Stack layout (v9): the top band takes `split` of the canvas height, the
 * bottom band the rest; even pixel sizes. Preview, render and export read this.
 */
export function stackBoxes(c: { width: number; height: number }, split: number): [{ x: number; y: number; width: number; height: number }, { x: number; y: number; width: number; height: number }] {
  const h = Math.max(2, Math.min(c.height - 2, Math.round(c.height * split / 2) * 2));
  return [{ x: 0, y: 0, width: c.width, height: h }, { x: 0, y: h, width: c.width, height: c.height - h }];
}

/**
 * A source region that fills a box without stretching: the region, trimmed
 * about its centre to the box's shape. Fractions of the source.
 */
export function coverRegion(src: { width: number; height: number }, r: { x: number; y: number; w: number; h: number }, box: { width: number; height: number }): { x: number; y: number; w: number; h: number } {
  const want = box.width / box.height, have = (r.w * src.width) / (r.h * src.height);
  let { x, y, w, h } = r;
  if (have > want) { const nw = w * want / have; x += (w - nw) / 2; w = nw; }
  else if (have < want) { const nh = h * have / want; y += (h - nh) / 2; h = nh; }
  return { x, y, w, h };
}
