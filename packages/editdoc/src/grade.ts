// Colour grade of one source clip, on Lumetri's scales, compiled to a 3D LUT
// (33 points a side) that the render applies to every frame of the clip.
// Correction first (white balance, exposure), then at most a light look.
// A subset of REDACTED's grade: no curves, hue mixer, secondaries, input
// LUTs, vignette or grain. Pure: no I/O.
import { z } from "zod";

export type RGB = [number, number, number];

/** Each setting's range and neutral value, Lumetri's. */
export const GRADE_RANGES = {
  intensity: [0, 100, 100], temperature: [-100, 100, 0], tint: [-100, 100, 0], exposure: [-5, 5, 0],
  contrast: [-100, 100, 0], highlights: [-100, 100, 0], shadows: [-100, 100, 0], whites: [-100, 100, 0], blacks: [-100, 100, 0],
  saturation: [0, 200, 100], vibrance: [-100, 100, 0], fade: [0, 100, 0],
} as const satisfies Record<string, readonly [number, number, number]>;
type Range = readonly [min: number, max: number, neutral: number];
const WHEEL = { hue: [0, 360, 0], amount: [0, 100, 0], luma: [-100, 100, 0] } as const satisfies Record<string, Range>;

/** Ready looks: settings applied as one step, scaled by `intensity`. */
export const GRADE_LOOKS = {
  "clean-contrast": { contrast: 22, whites: 8, blacks: -8, saturation: 106, vibrance: 12 },
  warm: { temperature: 22, tint: 4, saturation: 104, gain: { hue: 35, amount: 10 } },
  cool: { temperature: -22, tint: -3, saturation: 97, lift: { hue: 205, amount: 12 } },
  "teal-orange": { contrast: 14, saturation: 106, lift: { hue: 190, amount: 32 }, gain: { hue: 32, amount: 22 } },
  "faded-film": { fade: 55, contrast: -12, saturation: 80, highlights: -15, gain: { hue: 45, amount: 12 }, lift: { hue: 200, amount: 10 } },
  "black-white": { saturation: 0, contrast: 18, blacks: -6 },
} as const;
export const GRADE_LOOK_IDS = Object.keys(GRADE_LOOKS) as [keyof typeof GRADE_LOOKS, ...(keyof typeof GRADE_LOOKS)[]];
export type GradeLookId = keyof typeof GRADE_LOOKS;

const n = (r: Range) => z.number().min(r[0]).max(r[1]).optional();
const wheel = z.object({ hue: n(WHEEL.hue), amount: n(WHEEL.amount), luma: n(WHEEL.luma) }).strict();
export const gradeSchema = z.object({
  /** false: switched off (before/after); the settings stay. */
  enabled: z.boolean().optional(),
  look: z.enum(GRADE_LOOK_IDS).optional(),
  intensity: n(GRADE_RANGES.intensity), temperature: n(GRADE_RANGES.temperature), tint: n(GRADE_RANGES.tint),
  exposure: n(GRADE_RANGES.exposure), contrast: n(GRADE_RANGES.contrast), highlights: n(GRADE_RANGES.highlights),
  shadows: n(GRADE_RANGES.shadows), whites: n(GRADE_RANGES.whites), blacks: n(GRADE_RANGES.blacks),
  saturation: n(GRADE_RANGES.saturation), vibrance: n(GRADE_RANGES.vibrance), fade: n(GRADE_RANGES.fade),
  lift: wheel.optional(), gamma: wheel.optional(), gain: wheel.optional(),
}).strict();
export type Grade = z.infer<typeof gradeSchema>;
type Settings = Omit<Grade, "enabled" | "look"> & { look?: GradeLookId };

const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const val = (v: unknown, [min, max, neutral]: Range) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : neutral);
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); // sRGB → light
const gam = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
export const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };

function hue([r, g, b]: RGB): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 1e-9) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
function hslToRgb([h, s, l]: RGB): RGB {
  const k = (x: number) => (x + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (x: number) => l - a * Math.max(-1, Math.min(k(x) - 3, 9 - k(x), 1));
  return [f(0), f(8), f(4)];
}
/** A hue's direction at equal brightness: what a wheel adds to each channel (largest = 1). */
function tintOf(h: number): RGB {
  const c = hslToRgb([h, 1, 0.5]), y = luma(c);
  const d: RGB = [c[0] - y, c[1] - y, c[2] - y];
  const m = Math.max(...d.map(Math.abs));
  return [d[0] / m, d[1] / m, d[2] / m];
}
function curve(points: [number, number][]): (x: number) => number {
  // Monotone cubic (Fritsch–Carlson): never overshoots its points.
  const p = points, k = p.length, d: number[] = [], m: number[] = [];
  for (let i = 0; i < k - 1; i++) d.push((p[i + 1]![1] - p[i]![1]) / (p[i + 1]![0] - p[i]![0] || 1e-6));
  m.push(d[0]!);
  for (let i = 1; i < k - 1; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[k - 2]!);
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i]! / d[i]!, b = m[i + 1]! / d[i]!, s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]!; m[i + 1] = t * b * d[i]!; }
  }
  return x => {
    if (x <= p[0]![0]) return p[0]![1];
    if (x >= p[k - 1]![0]) return p[k - 1]![1];
    let i = 0;
    while (x > p[i + 1]![0]) i++;
    const h = p[i + 1]![0] - p[i]![0], t = (x - p[i]![0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p[i]![1] + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * p[i + 1]![1] + (t3 - t2) * h * m[i + 1]!;
  };
}

/** ±100 temperature or tint = ±1 stop on red and blue (or green). */
const WB = 1;
/** ±100 highlights, shadows, whites or blacks = ±0.15 on that point of the curve. */
const TONE = 0.15;

type Step = (c: RGB) => void;
function compile(g: Settings): Step[] {
  const v = (k: keyof typeof GRADE_RANGES) => val(g[k], GRADE_RANGES[k]);
  const steps: Step[] = [];
  // Look: scaled by its intensity.
  const look = g.look ? compile(GRADE_LOOKS[g.look] as Settings) : null;
  const k = v("intensity") / 100;
  if (look && k > 0) steps.push(c => {
    const o: RGB = [c[0], c[1], c[2]];
    for (const s of look) s(o);
    for (let i = 0; i < 3; i++) c[i] = c[i]! + (o[i]! - c[i]!) * k;
  });
  // White balance: gains in light on red and blue (temperature), green (tint), at equal brightness.
  const t = v("temperature") / 100, m = v("tint") / 100;
  if (t || m) {
    const gains: RGB = [2 ** (WB * t), 2 ** (-WB * m), 2 ** (-WB * t)];
    const y = luma(gains);
    steps.push(c => { for (let i = 0; i < 3; i++) c[i] = gam(lin(c[i]!) * gains[i]! / y); });
  }
  // Exposure: x2 a stop, in light; going up, whites roll off instead of clipping at once.
  const e = v("exposure");
  if (e) {
    const s = 2 ** e, knee = 0.6, p = (s - knee) / (1 - knee);
    const shoulder = (x: number) => (s <= 1 || x <= knee ? x : knee + (1 - knee) * (1 - (1 - Math.min(1, (x - knee) / (s - knee))) ** p));
    steps.push(c => { for (let i = 0; i < 3; i++) c[i] = gam(shoulder(lin(Math.max(0, c[i]!)) * s)); });
  }
  // Tone: contrast about mid grey, then highlights, shadows, whites and blacks as points of a curve.
  const C = v("contrast") / 100, H = v("highlights") / 100, S = v("shadows") / 100, W = v("whites") / 100, B = v("blacks") / 100;
  if (C || H || S || W || B) {
    const kc = C >= 0 ? 1 + 0.8 * C : 1 / (1 - 0.8 * C);
    const contrast = (x: number) => (x < 0.5 ? 0.5 * (2 * x) ** kc : 1 - 0.5 * (2 - 2 * x) ** kc);
    let ys = [B > 0 ? TONE * B : 0, 0.25 + TONE * S, 0.5, 0.75 + TONE * H, W < 0 ? 1 + TONE * W : 1];
    ys = ys.map((y, i) => Math.max(y, ...ys.slice(0, i))); // never a curve that goes back down
    const xs = [B < 0 ? -TONE * B : 0, 0.25, 0.5, 0.75, W > 0 ? 1 - TONE * W : 1];
    const zones = H || S || W || B ? curve(xs.map((x, i) => [x, ys[i]!] as [number, number])) : null;
    steps.push(c => { for (let i = 0; i < 3; i++) { let x = clamp(c[i]!); if (C) x = contrast(x); if (zones) x = zones(x); c[i] = x; } });
  }
  // Saturation about brightness; vibrance lifts dull colours first and spares skin.
  const sat = v("saturation") / 100, vib = v("vibrance") / 100;
  if (sat !== 1 || vib) steps.push(c => {
    const y = luma(c);
    let f = sat;
    if (vib) {
      const mx = Math.max(...c), mn = Math.min(...c), s = mx > 1e-6 ? (mx - mn) / mx : 0;
      const skin = 1 - smooth(10, 35, Math.abs(hue(c) - 25));
      f *= Math.max(0, 1 + vib * (1 - s) * (1 - 0.5 * skin));
    }
    for (let i = 0; i < 3; i++) c[i] = y + (c[i]! - y) * f;
  });
  // Fade: lifts the blacks (washed-out film black).
  const fade = v("fade") / 100;
  if (fade) steps.push(c => { for (let i = 0; i < 3; i++) { const x = clamp(c[i]!); c[i] = x + fade * 0.25 * (1 - x) ** 3; } });
  // Wheels: lift moves black (white stays), gamma the middle, gain white (black stays).
  const w = (x: Grade["lift"], color: number, light: number): RGB | null => {
    const a = val(x?.amount, WHEEL.amount) / 100, y = val(x?.luma, WHEEL.luma) / 100;
    if (!a && !y) return null;
    const d = tintOf(val(x?.hue, WHEEL.hue));
    return [y * light + a * color * d[0], y * light + a * color * d[1], y * light + a * color * d[2]];
  };
  const lift = w(g.lift, 0.15, 0.2), gamma = w(g.gamma, 0.5, 0.8), gain = w(g.gain, 0.3, 0.5);
  if (lift || gamma || gain) steps.push(c => {
    for (let i = 0; i < 3; i++) {
      let x = c[i]!;
      if (lift) x += lift[i]! * (1 - x);
      if (gain) x *= 1 + gain[i]!;
      if (gamma) x = Math.max(0, x) ** (1 / 2 ** gamma[i]!);
      c[i] = x;
    }
  });
  return steps;
}

/** The grade in force: none, or one switched off, changes nothing. */
export const activeGrade = (g: Grade | undefined): Grade | undefined => (g && g.enabled !== false ? g : undefined);

/** A colour through the grade. */
export function applyGrade(g: Grade | undefined, c: RGB): RGB {
  const a = activeGrade(g);
  const o: RGB = [c[0], c[1], c[2]];
  if (a) for (const s of compile(a as Settings)) s(o);
  return [clamp(o[0]), clamp(o[1]), clamp(o[2])];
}

export const LUT_SIZE = 33;
/** The grade as a 3D LUT (red fastest, as in a .cube); null when it changes no colour. */
export function lutFor(g: Grade | undefined, size = LUT_SIZE): Float32Array | null {
  const a = activeGrade(g);
  const steps = a ? compile(a as Settings) : [];
  if (!steps.length) return null;
  const out = new Float32Array(size ** 3 * 3), s = size - 1;
  let k = 0;
  for (let b = 0; b < size; b++) for (let gg = 0; gg < size; gg++) for (let r = 0; r < size; r++) {
    const o = applyGrade(a, [r / s, gg / s, b / s]);
    out[k++] = o[0]; out[k++] = o[1]; out[k++] = o[2];
  }
  return out;
}

/** A 3D LUT as a .cube file (ffmpeg lut3d, Premiere, Resolve, Final Cut). */
export function writeCube(lut: Float32Array, size: number, title: string): string {
  const lines = [`TITLE "${title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"];
  for (let i = 0; i < lut.length; i += 3) lines.push(`${lut[i]!.toFixed(6)} ${lut[i + 1]!.toFixed(6)} ${lut[i + 2]!.toFixed(6)}`);
  return lines.join("\n") + "\n";
}

/** Temperature and tint that turn colour `c` grey (the white balance pipette). Null for near black. */
export function whiteBalanceFor(c: RGB): { temperature: number; tint: number } | null {
  const [r, g, b] = c.map(x => lin(clamp(x))) as RGB;
  if (Math.min(r, g, b) < 1e-4) return null;
  const t = Math.log2(b / r) / (2 * WB), m = -t - Math.log2(r / g) / WB;
  return { temperature: Math.round(clamp(t * 100, -100, 100)), tint: Math.round(clamp(m * 100, -100, 100)) };
}

/** Drop settings back at neutral; undefined when nothing is left. */
export function pruneGrade(g: Grade | undefined): Grade | undefined {
  if (!g) return undefined;
  const o: Record<string, unknown> = { ...g };
  for (const [k, r] of Object.entries(GRADE_RANGES)) if (typeof o[k] === "number" && Math.abs((o[k] as number) - r[2]) < 1e-9) delete o[k];
  if (o.enabled !== false) delete o.enabled;
  if (!o.look) { delete o.look; delete o.intensity; }
  for (const w of ["lift", "gamma", "gain"]) {
    const x = o[w] as { amount?: number; luma?: number } | undefined;
    if (x && !x.amount && !x.luma) delete o[w];
  }
  return Object.keys(o).length ? (o as Grade) : undefined;
}

/** Linear light of an sRGB value (0–1), for measuring exposure in stops. */
export const toLinear = lin;
