// Pixel-art kit for scenes: import from './pixel' only.
// this block into every film; here it is lib code, so agent scenes never touch document or ImageData themselves.
// Everything is drawn on a small grid (360 × 640 vertical, 640 × 360 at 16:9), scaled up with crisp pixels. A colour = [r, g, b].
import {useLayoutEffect, useRef} from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {fontFamily} from './kit';

export type RGB = readonly [number, number, number];
export const rgb = (c: string): RGB => {const n = parseInt(c.replace('#', '').slice(0, 6), 16) || 0; return [n >> 16, (n >> 8) & 255, n & 255];};
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Dither: true where a fill of intensity `a` (0 → 1) puts a dot. It replaces every gradient. */
export const dot = (x: number, y: number, a: number) => (BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16 < a;
/** Dithered gradient between the colours of a ramp (`t` from 0 to 1). */
export const mix = (ramp: RGB[], t: number, x: number, y: number): RGB => {
  const v = Math.min(1, Math.max(0, t)) * (ramp.length - 1), i = Math.min(ramp.length - 2, Math.floor(v));
  return (dot(x, y, v - i) ? ramp[i + 1] : ramp[i])!;
};
const glyphs = new Map<string, {w: number; h: number; on: Uint8Array}>();
/** A text as full or empty dots (alpha cut at 50 %): `w` = its width on the grid. `font`: the whole CSS font, e.g. pixelFont('Inter', 700, 16). */
export function glyph(s: string, font: string, size: number) {
  const key = `${font}|${s}`;
  let m = glyphs.get(key);
  if (!m) {
    const c = document.createElement('canvas'), g = c.getContext('2d', {willReadFrequently: true})!;
    g.font = font;
    const w = Math.ceil(g.measureText(s).width), h = Math.ceil(size * 1.5);
    c.width = w + 2; c.height = h;
    g.font = font; g.fillStyle = '#fff'; g.fillText(s, 1, size);
    const a = g.getImageData(0, 0, w + 2, h).data;
    m = {w, h, on: Uint8Array.from({length: (w + 2) * h}, (_, i) => (a[i * 4 + 3]! > 127 ? 1 : 0))};
    glyphs.set(key, m);
  }
  return m;
}
/** Font for g.text: a shipped font (Inter, JetBrains Mono) at grid size; small sizes with the 50 % cut read as pixel type. */
export const pixelFont = (name: string, weight: number, size: number) => ({font: `${weight} ${size}px ${fontFamily(name)}`, size});
export type TextStyle = {font: string; size: number; color: RGB; align?: 'left' | 'center' | 'right'; shadow?: RGB};

export class Pix {
  d: Uint8ClampedArray<ArrayBuffer>;
  constructor(readonly w: number, readonly h: number) {this.d = new Uint8ClampedArray(w * h * 4);}
  px(x: number, y: number, c: RGB) {
    x = Math.round(x); y = Math.round(y); // a fractional value lands on the nearest dot
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = 255;
  }
  rect(x: number, y: number, w: number, h: number, c: RGB) {for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, c);}
  /** An area painted dot by dot: `f` returns the dot's colour, or null to leave it. With `dot` and `mix`: dithers, halos, volumes. */
  paint(x: number, y: number, w: number, h: number, f: (x: number, y: number) => RGB | null) {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {const c = f(i, j); if (c) this.px(i, j, c);}
  }
  /** Pixel line; `dash`: dash length (0 = solid). */
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, dash = 0) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    for (let e = dx + dy, n = 0; ; n++) {
      if (!dash || n % (dash * 2) < dash) this.px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) {e += dy; x0 += sx;}
      if (e2 <= dx) {e += dx; y0 += sy;}
    }
  }
  /** A drawing written as rows of letters: each letter is a colour from `colors`, the rest is empty. */
  sprite(rows: string[], x: number, y: number, colors: Record<string, RGB>, flip = false) {
    rows.forEach((row, j) => [...row].forEach((ch, i) => {const c = colors[ch]; if (c) this.px(x + (flip ? row.length - 1 - i : i), y + j, c);}));
  }
  /** Text on the grid, no smoothing (`y` = top of the line). Returns its width. */
  text(s: string, x: number, y: number, o: TextStyle) {
    const m = glyph(s, o.font, o.size);
    const x0 = Math.round(x - (o.align === 'center' ? m.w / 2 : o.align === 'right' ? m.w : 0)) - 1;
    for (const [c, off] of [[o.shadow, 1], [o.color, 0]] as const) if (c)
      for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w + 2; i++) if (m.on[j * (m.w + 2) + i]) this.px(x0 + i + off, y + j + off, c);
    return m.w;
  }
  /** Undo the canvas in a dither: `a` = share erased (0 → 1). The exit of a text or a box. */
  erase(a: number) {for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (dot(x, y, a)) this.d[(y * this.w + x) * 4 + 3] = 0;}
  /** Reflection: what is above `horizon`, flipped below. `shift(row)` offsets each row (ripples), `keep(row)` the share kept, dithered. */
  mirror(horizon: number, depth: number, shift: (row: number) => number, keep: (row: number) => number) {
    for (let r = 0; r < depth && horizon + r < this.h && horizon - 1 - r >= 0; r++) {
      const dx = Math.round(shift(r)), a = keep(r), ys = horizon - 1 - r, yd = horizon + r;
      for (let x = 0; x < this.w; x++) {
        const sx = x - dx, i = (ys * this.w + sx) * 4;
        if (sx >= 0 && sx < this.w && this.d[i + 3] && dot(x, yd, a)) this.px(x, yd, [this.d[i]!, this.d[i + 1]!, this.d[i + 2]!]);
      }
    }
  }
}

/** Stepped timing: `pose` advances 12 times a second (each pose holds 2-3 frames), `t` = its time in seconds. Move everything from these. */
export function usePose(rate = 12) {
  const frame = useCurrentFrame(), {fps} = useVideoConfig();
  const hold = Math.max(1, Math.round(fps / rate)), pose = Math.floor(frame / hold);
  return {pose, t: (pose * hold) / fps};
}

let small: HTMLCanvasElement | undefined;
/**
 * The canvas: a grid of `cell` screen px per dot. `draw` redraws it every frame. Each dot is painted as `cell` × `cell`
 * real pixels, so the export is exact. Never `transform: scale` a pixel scene: give it its real size with `<Sequence width height>`.
 */
export function PixelCanvas({draw, ready = true}: {draw: (g: Pix) => void; ready?: boolean}) {
  const {width, height} = useVideoConfig();
  const cell = Math.max(1, Math.round(Math.max(width, height) / 640)), w = Math.ceil(width / cell), h = Math.ceil(height / cell);
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const g = new Pix(w, h), out = ref.current?.getContext('2d');
    if (!out) return;
    if (ready) draw(g);
    small ??= document.createElement('canvas');
    small.width = w; small.height = h;
    small.getContext('2d')!.putImageData(new ImageData(g.d, w, h), 0, 0);
    out.imageSmoothingEnabled = false;
    out.clearRect(0, 0, w * cell, h * cell);
    out.drawImage(small, 0, 0, w * cell, h * cell);
  });
  return <canvas ref={ref} width={w * cell} height={h * cell} style={{position: 'absolute', left: 0, top: 0, imageRendering: 'pixelated'}} />;
}
