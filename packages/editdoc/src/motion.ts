// Auto reframe and motion tracking, the pure parts (v8): smoothing a
// speaker's path into crop keys, clamping the crop inside the frame, reading
// a motion track, and mapping a point of a clip's frame onto the canvas the
// way the render draws it (cover fit, reframe crop, zoom). No I/O.
import { zoomAt } from "./render";
import type { ARollItem, EditDoc, MotionTrack, Reframe, ReframeSpeed } from "./schema";

type Size = { width: number; height: number };

/** One sampled frame of a subject path: source second, centre x, y and size w, h (fractions), or nulls when nobody is seen. */
export type SubjectFrame = [number, number | null, number | null, number | null, number | null];

// Smoothing time and dead zone per speed, like Premiere's Motion Tracking presets.
/** Seconds of Gaussian smoothing on the subject's path. */
export const REFRAME_SIGMA: Record<ReframeSpeed, number> = { slower: 0.9, default: 0.45, faster: 0.15 };
/** How far the subject may drift (fraction of the clip's width) before the crop follows. */
export const REFRAME_DEAD: Record<ReframeSpeed, number> = { slower: 0.06, default: 0.03, faster: 0.01 };

/**
 * The subject's centre x, smoothed, at each sampled frame: gaps filled (the
 * last place holds, the first seen place stands for the frames before it), a
 * dead zone so small moves leave the crop still, then a Gaussian blur, which
 * has no lag. Null when nobody is seen at all.
 */
export function smoothCenters(frames: SubjectFrame[], speed: ReframeSpeed): number[] | null {
  const seen = frames.findIndex((f) => f[1] !== null);
  if (seen < 0) return null;
  const raw: number[] = [];
  let last = frames[seen]![1]!;
  for (const f of frames) raw.push(last = f[1] ?? last);
  // Dead zone: the crop only moves once the subject really leaves where it looks.
  const held: number[] = [];
  let aim = raw[0]!;
  for (const x of raw) {
    if (Math.abs(x - aim) > REFRAME_DEAD[speed]) aim = x - Math.sign(x - aim) * REFRAME_DEAD[speed];
    held.push(aim);
  }
  const dt = frames.length > 1 ? (frames.at(-1)![0] - frames[0]![0]) / (frames.length - 1) : 1;
  const sigma = REFRAME_SIGMA[speed] / Math.max(dt, 1e-6), r = Math.ceil(3 * sigma);
  return held.map((_, i) => {
    let s = 0, w = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(held.length - 1, i + r); k++) {
      const g = Math.exp(-((k - i) ** 2) / (2 * sigma * sigma));
      s += g * held[k]!;
      w += g;
    }
    return s / w;
  });
}

/** The keys that matter: a straight line between two kept keys passes within `tol` of every value between them. */
export function simplify(ts: number[], vs: number[][], tol: number[]): number[] {
  const keep = new Set([0, ts.length - 1]);
  const split = (a: number, b: number) => {
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const u = (ts[i]! - ts[a]!) / (ts[b]! - ts[a]! || 1);
      const d = Math.max(...vs[i]!.map((v, k) => Math.abs(v - (vs[a]![k]! + (vs[b]![k]! - vs[a]![k]!) * u)) / tol[k]!));
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > 1) { keep.add(at); split(a, at); split(at, b); }
  };
  if (ts.length > 2) split(0, ts.length - 1);
  return [...keep].filter((k) => k >= 0 && k < ts.length).sort((a, b) => a - b);
}

/** Keys within this of the line through their neighbours go (fraction of the clip's width: ~1 px at 1920). */
export const REFRAME_TOLERANCE = 0.0006;

/** A subject path as reframe keys (source seconds, centre x), or null when nobody is seen. */
export function reframeFromFrames(frames: SubjectFrame[], speed: ReframeSpeed = "default"): Reframe | null {
  const xs = smoothCenters(frames, speed);
  if (!xs) return null;
  const ts = frames.map((f) => f[0]);
  const kept = simplify(ts, xs.map((x) => [x]), [REFRAME_TOLERANCE]);
  return { speed, keys: kept.map((k) => ({ t: Math.round(ts[k]! * 1000) / 1000, x: Math.round(xs[k]! * 1e4) / 1e4 })) };
}

/** Straight-line value of keyed `v` at `t`; the end keys hold outside. */
export function lerpKeys<K extends { t: number }>(keys: K[], t: number, v: (k: K) => number): number {
  const first = keys[0]!, last = keys.at(-1)!;
  if (t <= first.t) return v(first);
  if (t >= last.t) return v(last);
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m]!.t <= t) lo = m; else hi = m; }
  const a = keys[lo]!, b = keys[hi]!;
  return v(a) + (v(b) - v(a)) * ((t - a.t) / (b.t - a.t || 1));
}

/**
 * The shown width of a clip covering `canvas`, as a fraction of the clip's
 * width; under 1 when the canvas is narrower (16:9 into 9:16 or 1:1), so the
 * crop has room to move sideways. 1 when it has none.
 */
export function cropWidth(src: Size, canvas: Size): number {
  const k = Math.max(canvas.width / src.width, canvas.height / src.height);
  return Math.min(1, canvas.width / (src.width * k));
}

/** Left edge of the crop (fraction of the clip's width) at source second `t`: centred on the path, never past the frame. */
export function reframeLeft(reframe: Reframe, t: number, width: number): number {
  const x = lerpKeys(reframe.keys, t, (k) => k.x);
  return Math.min(1 - width, Math.max(0, x - width / 2));
}

/** The canvas aspect of a ratio such as "9:16", "1:1", "4:5" or "16:9". */
export function parseAspect(aspect: string): number {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect.trim());
  if (!m || !Number(m[1]) || !Number(m[2])) throw new Error(`aspect must look like 9:16, got "${aspect}"`);
  return Number(m[1]) / Number(m[2]);
}

/**
 * Canvas for `aspect` from a clip of `src` size: the long side stays the
 * clip's long side (1920x1080 into 9:16 gives 1080x1920), both even.
 */
export function canvasFor(src: Size, aspect: number): Size {
  const long = Math.max(src.width, src.height);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return aspect >= 1 ? { width: even(long), height: even(long / aspect) } : { width: even(long * aspect), height: even(long) };
}

/** Motion track offset and scale at `t` seconds from the item's start. */
export function trackAt(track: MotionTrack, t: number): { dx: number; dy: number; s: number } {
  return { dx: lerpKeys(track.keys, t, (k) => k.dx), dy: lerpKeys(track.keys, t, (k) => k.dy), s: lerpKeys(track.keys, t, (k) => k.s ?? 1) };
}

/** The a-roll piece on screen at output second `t`, or undefined. */
export function pieceAt(doc: Pick<EditDoc, "tracks">, t: number): ARollItem | undefined {
  return doc.tracks["a-roll"].find((i) => i.status !== "suggested" && i.start <= t + 1e-6 && t < i.end - 1e-6);
}

/**
 * Where point `p` of a piece's frame (fractions of the clip) lands on the
 * canvas (fractions) at output second `t`, and the picture's scale there, as
 * the render draws it: cover fit, the reframe crop, then the zoom track.
 */
export function sourceToCanvas(doc: Pick<EditDoc, "canvas" | "clips" | "tracks">, piece: Pick<ARollItem, "clipId" | "in" | "start">, t: number, p: { x: number; y: number }): { x: number; y: number; scale: number } {
  const clip = doc.clips.find((c) => c.id === piece.clipId);
  if (!clip?.width || !clip.height) throw new Error(`clip ${piece.clipId} has no size`);
  const src = { width: clip.width, height: clip.height }, W = doc.canvas.width, H = doc.canvas.height;
  const k = Math.max(W / src.width, H / src.height), sw = src.width * k, sh = src.height * k;
  const width = cropWidth(src, doc.canvas);
  const left = clip.reframe && width < 1 ? reframeLeft(clip.reframe, piece.in + (t - piece.start), width) * sw : (sw - W) / 2;
  const x = (p.x * sw - left) / W, y = (p.y * sh - (sh - H) / 2) / H;
  const z = zoomAt(doc.tracks.zoom, t);
  return { x: (x - 0.5) * z.scale + 0.5 + z.dx, y: (y - 0.5) * z.scale + 0.5 + z.dy, scale: k * z.scale };
}

/** The canvas point (fractions) back in the piece's frame (fractions) at output second `t`. */
export function canvasToSource(doc: Pick<EditDoc, "canvas" | "clips" | "tracks">, piece: Pick<ARollItem, "clipId" | "in" | "start">, t: number, q: { x: number; y: number }): { x: number; y: number } {
  const a = sourceToCanvas(doc, piece, t, { x: 0, y: 0 }), b = sourceToCanvas(doc, piece, t, { x: 1, y: 1 });
  return { x: (q.x - a.x) / (b.x - a.x), y: (q.y - a.y) / (b.y - a.y) };
}

/** One frame of a point track: source second, place (fractions of the clip), scale and rotation of the set against the anchor. */
export type TrackFrame = [number, number, number, number, number];

/** Keys within this of the line through their neighbours go, in canvas pixels. */
export const TRACK_TOLERANCE_PX = 0.5;

/**
 * A point track on the piece under an item as the item's motion track: each
 * tracked frame inside the item and the piece becomes how far the spot moved
 * on the canvas from the anchor, and its scale against it, cut to the keys
 * that matter. `at` is the anchor's output second.
 */
export function trackFromFrames(doc: Pick<EditDoc, "canvas" | "clips" | "tracks" | "fps">, item: { start: number; end: number }, piece: ARollItem, frames: TrackFrame[], at: number, point: { x: number; y: number }): MotionTrack {
  if (!frames.length) throw new Error("no tracked frames");
  const outAt = (src: number) => piece.start + (src - piece.in);
  const anchorSrc = piece.in + (at - piece.start);
  const anchor = frames.reduce((b, f) => (Math.abs(f[0] - anchorSrc) < Math.abs(b[0] - anchorSrc) ? f : b));
  const a = sourceToCanvas(doc, piece, outAt(anchor[0]), { x: anchor[1], y: anchor[2] });
  const fps = doc.fps.num / doc.fps.den;
  const rows = frames.map((f) => {
    const t = outAt(f[0]);
    const o = sourceToCanvas(doc, piece, Math.min(Math.max(t, piece.start), piece.end - 1e-6), { x: f[1], y: f[2] });
    return { t: Math.round((t - item.start) * fps) / fps, dx: o.x - a.x, dy: o.y - a.y, s: (o.scale * f[3]) / (a.scale * anchor[3]) };
  }).filter((r) => r.t >= -1e-6 && r.t <= item.end - item.start + 1e-6 && r.t + item.start <= piece.end + 1e-6 && r.t + item.start >= piece.start - 1e-6);
  if (!rows.length) throw new Error("the item and the footage under it do not overlap: nothing to follow");
  const ts = rows.map((r) => r.t), W = doc.canvas.width, H = doc.canvas.height;
  const pos = simplify(ts, rows.map((r) => [r.dx * W, r.dy * H]), [TRACK_TOLERANCE_PX, TRACK_TOLERANCE_PX]);
  const sc = simplify(ts, rows.map((r) => [r.s]), [0.002]);
  const flat = rows.every((r) => Math.abs(r.s - 1) < 0.002);
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  const keep = [...new Set([...pos, ...(flat ? [] : sc)])].sort((x, y) => x - y);
  return {
    clipId: piece.clipId, at: Math.round(anchorSrc * 1000) / 1000, anchor: Math.round(Math.max(0, at - item.start) * 1000) / 1000, point: { x: r5(point.x), y: r5(point.y) },
    keys: keep.map((k) => ({ t: Math.max(0, ts[k]!), dx: r5(rows[k]!.dx), dy: r5(rows[k]!.dy), ...(flat ? {} : { s: r5(rows[k]!.s) }) })),
  };
}

/**
 * Why an item's motion track no longer fits the cut, or null when it does:
 * the footage under its anchor is another clip, or the same clip at another
 * second (a recut moved it).
 */
export function trackStale(doc: Pick<EditDoc, "tracks">, item: { start: number; track?: MotionTrack | undefined }): string | null {
  const tr = item.track;
  if (!tr) return null;
  const piece = pieceAt(doc, item.start + tr.anchor);
  if (!piece || piece.clipId !== tr.clipId) return "the footage under it changed";
  const src = piece.in + (item.start + tr.anchor - piece.start);
  return Math.abs(src - tr.at) > 0.1 ? "the cut moved the footage under it" : null;
}
