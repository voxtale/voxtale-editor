// Log and HDR footage to Rec.709, like Premiere's colour management (Direct
// 709 SDR): the maker's published formula takes the signal back to scene
// light, the camera gamut goes to Rec.709, then out-of-gamut colours and
// highlights are squeezed gently (gamut compression that keeps luminance,
// tone mapping that keeps hue half way, as "Hue Preservation" at Highlight
// Saturation 0.5). HLG and PQ (phones, HDR cameras) take the same road from
// BT.2020. DJI consumer D-Log M has no published formula: REDACTED ships
// DJI's own LUT; here the creator passes it as `inputLut`.
// Formulas and primaries: colour-science (BSD-3-Clause, (c) 2013 Colour
// Developers), checked against its test values. Pure.
import { activeGrade, applyGrade, LUT_SIZE, sampleCube, type Cube, type Grade, type RGB } from "./grade";
import type { ClipRef } from "./schema";

type XY = readonly [number, number];
type Gamut = readonly [XY, XY, XY];

const S_GAMUT: Gamut = [[0.73, 0.28], [0.14, 0.855], [0.1, -0.05]]; // also S-Gamut3
const S_GAMUT3_CINE: Gamut = [[0.766, 0.275], [0.225, 0.8], [0.089, -0.087]];
const V_GAMUT: Gamut = [[0.73, 0.28], [0.165, 0.84], [0.1, -0.03]];
const CINEMA_GAMUT: Gamut = [[0.74, 0.27], [0.17, 1.14], [0.08, -0.1]];
const D_GAMUT: Gamut = [[0.71, 0.31], [0.21, 0.88], [0.09, -0.08]];
const BT2020: Gamut = [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]]; // Apple Log, F-Gamut, N-Gamut, HLG, PQ
const BT709: Gamut = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]];
const D65: XY = [0.3127, 0.329];

// Decode: code value / 1023 (10-bit, video range) -> scene light, 18% grey = 0.18.
const SLOG_BLACK = 0.432699 * Math.log10(0.037584) + 0.616596 + 0.03;
const slog2 = (y: number) => {
  const x = (y * 1023 - 64) / 876; // S-Log and S-Log2 are written in video range (0 = black)
  return (x >= SLOG_BLACK ? 10 ** ((x - 0.616596 - 0.03) / 0.432699) - 0.037584 : (x - 0.030001222851889303) / 5) * 0.9 * 219 / 155;
};
const slog3 = (y: number) => (y >= 171.2102946929 / 1023 ? 10 ** ((y * 1023 - 420) / 261.5) * 0.19 - 0.01 : ((y * 1023 - 95) * 0.01125) / (171.2102946929 - 95));
const vlog = (y: number) => (y < 0.181 ? (y - 0.125) / 5.6 : 10 ** ((y - 0.598206) / 0.241514) - 0.00873);
const clog2 = (y: number) => (y < 0.092864125 ? -(10 ** ((0.092864125 - y) / 0.24136077) - 1) : 10 ** ((y - 0.092864125) / 0.24136077) - 1) / 87.09937546 * 0.9;
const clog3 = (y: number) => 0.9 * (y < 0.097465473 ? -(10 ** ((0.12783901 - y) / 0.36726845) - 1) / 14.98325
  : y <= 0.15277891 ? (y - 0.12512219) / 1.9754798 : (10 ** ((y - 0.12240537) / 0.36726845) - 1) / 14.98325);
const flog = (k: { cut2: number; a: number; b: number; c: number; d: number; e: number; f: number }) => (y: number) =>
  (y < k.cut2 ? (y - k.f) / k.e : 10 ** ((y - k.d) / k.c) / k.a - k.b / k.a);
const nlog = (y: number) => (y < 452 / 1023 ? (y / (650 / 1023)) ** 3 - 0.0075 : Math.exp((y - 619 / 1023) / (150 / 1023)));
const APPLE_PT = 47.28711236 * (0.01 + 0.05641088) ** 2;
const appleLog = (y: number) => (y >= APPLE_PT ? 2 ** ((y - 0.69336945) / 0.08550479) - 0.00964052 : y >= 0 ? Math.sqrt(y / 47.28711236) - 0.05641088 : -0.05641088);
const dlog = (y: number) => (y <= 0.14 ? (y - 0.0929) / 6.025 : (10 ** (3.89616 * y - 2.27752) - 0.0108) / 0.9892);

// HDR, video range. HLG (BT.2100 inverse OETF): reference white sits at 75%
// signal, scene light 0.265; scaled so it lands where log profiles put 90%
// reflectance white (0.9), which puts 38% signal skin-grey near 0.18.
const video = (y: number) => (y * 1023 - 64) / 876;
const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073 };
const hlgScene = (e: number) => (e <= 0.5 ? (e * e) / 3 : (Math.exp((e - HLG.c) / HLG.a) + HLG.b) / 12);
const HLG_SCALE = 0.9 / hlgScene(0.75);
const hlg = (y: number) => hlgScene(Math.max(0, video(y))) * HLG_SCALE;
// PQ (SMPTE ST 2084) to nits; HDR reference white is 203 nits (BT.2408), taken to 0.9.
const PQ = { m1: 2610 / 16384, m2: (2523 / 4096) * 128, c1: 3424 / 4096, c2: (2413 / 4096) * 32, c3: (2392 / 4096) * 32 };
const pqNits = (e: number) => {
  const p = Math.max(0, e) ** (1 / PQ.m2);
  return 10000 * (Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p)) ** (1 / PQ.m1);
};
const pq = (y: number) => (pqNits(video(y)) / 203) * 0.9;

/** Log profiles we convert (Premiere's names): formula and camera gamut. */
export const FORMULAS: Record<string, { decode: (y: number) => number; gamut: Gamut }> = {
  "Sony S-Log3/S-Gamut3.Cine": { decode: slog3, gamut: S_GAMUT3_CINE },
  "Sony S-Log3/S-Gamut3": { decode: slog3, gamut: S_GAMUT },
  "Sony S-Log2/S-Gamut": { decode: slog2, gamut: S_GAMUT },
  "DJI D-Log/D-Gamut": { decode: dlog, gamut: D_GAMUT }, // DJI cinema cameras (Inspire, Ronin 4D, Zenmuse)
  "Apple Log/Rec. 2020": { decode: appleLog, gamut: BT2020 },
  "Panasonic V-Log/V-Gamut": { decode: vlog, gamut: V_GAMUT },
  "Canon Log 2/Cinema Gamut": { decode: clog2, gamut: CINEMA_GAMUT },
  "Canon Log 3/Cinema Gamut": { decode: clog3, gamut: CINEMA_GAMUT },
  "Fuji F-Log/F-Gamut": { decode: flog({ cut2: 0.100537775223865, a: 0.555556, b: 0.009468, c: 0.344676, d: 0.790453, e: 8.735631, f: 0.092864 }), gamut: BT2020 },
  "Fuji F-Log2/F-Gamut": { decode: flog({ cut2: 0.100686685370811, a: 5.555556, b: 0.064829, c: 0.245281, d: 0.384316, e: 8.799461, f: 0.092864 }), gamut: BT2020 },
  "Nikon N-Log/Rec. 2020": { decode: nlog, gamut: BT2020 },
  hlg: { decode: hlg, gamut: BT2020 },
  pq: { decode: pq, gamut: BT2020 },
};
/** No conversion (already Rec.709): what to pick when detection got it wrong. */
export const REC709 = "Rec.709";
/** Profiles DJI ships only as a LUT (no published formula): pass DJI's .cube as the clip's `inputLut`. */
export const LUT_ONLY_PROFILES = ["DJI D-Log M", "DJI D-Log (Osmo Pocket 4)"] as const;
export const COLOR_SPACES = [REC709, ...Object.keys(FORMULAS)] as const;

/** Scene light of code value / 1023, for tests and checks. */
export const decode = (profile: string, y: number) => FORMULAS[profile]!.decode(y);

/* ───────── camera gamut -> Rec.709 ───────── */
type M3 = number[][];
const mul = (a: M3, b: M3): M3 => a.map(r => b[0]!.map((_, j) => r.reduce((s, x, k) => s + x * b[k]![j]!, 0)));
function inv(m: M3): M3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m as [[number, number, number], [number, number, number], [number, number, number]];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A, c * h - b * i, b * f - c * e], [B, a * i - c * g, c * d - a * f], [C, b * g - a * h, a * e - b * d]].map(r => r.map(x => x / det));
}
/** RGB -> XYZ of a gamut (xy primaries, D65 white). */
function toXYZ(p: Gamut): M3 {
  const xyz = ([x, y]: XY) => [x / y, 1, (1 - x - y) / y];
  const m = [0, 1, 2].map(r => p.map(c => xyz(c)[r]!));
  const w = xyz(D65), s = mul(inv(m), w.map(v => [v]));
  return m.map(r => r.map((v, j) => v * s[j]![0]!));
}
const TO_709 = inv(toXYZ(BT709));

/* ───────── to the Rec.709 picture ───────── */
const oetf = (l: number) => (l < 0.018 ? 4.5 * l : 1.099 * l ** 0.45 - 0.099); // BT.709
const oetfInv = (v: number) => (v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45));
// Above the knee, highlights round off toward white instead of clipping (same
// slope at the knee). 0.45 matches makers' LUTs on greys; 100% white lands near 80%.
const KNEE = 0.45;
const roll = (v: number) => (v <= KNEE ? v : KNEE + (1 - KNEE) * (1 - Math.exp(-(v - KNEE) / (1 - KNEE))));

/**
 * A profile's conversion: a source colour (0 = video black, 1 = white, as
 * ffmpeg hands RGB to lut3d) -> Rec.709, in place; null when unknown.
 * `fullRange`: the file is tagged full range, so the value is already code / 1023.
 */
export function converter(name: string, fullRange = false): ((c: RGB) => void) | null {
  const f = FORMULAS[name];
  if (!f) return null;
  const m = mul(TO_709, toXYZ(f.gamut));
  return c => {
    const l = c.map(v => f.decode(fullRange ? v : (876 * v + 64) / 1023));
    let r = m[0]![0]! * l[0]! + m[0]![1]! * l[1]! + m[0]![2]! * l[2]!;
    let g = m[1]![0]! * l[0]! + m[1]![1]! * l[1]! + m[1]![2]! * l[2]!;
    let b = m[2]![0]! * l[0]! + m[2]![1]! * l[1]! + m[2]![2]! * l[2]!;
    // Outside Rec.709: toward the grey of equal luminance, just enough (Luminance Preserving).
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b, lo = Math.min(r, g, b);
    if (y <= 0) r = g = b = 0;
    else if (lo < 0) { const t = y / (y - lo); r = y + (r - y) * t; g = y + (g - y) * t; b = y + (b - y) * t; }
    // Tone mapping: half per channel (desaturates highlights), half on the strongest channel (keeps hue).
    const top = Math.max(r, g, b), s = top > 0 ? oetfInv(roll(oetf(top))) / top : 1;
    c[0] = (roll(oetf(r)) + oetf(r * s)) / 2;
    c[1] = (roll(oetf(g)) + oetf(g * s)) / 2;
    c[2] = (roll(oetf(b)) + oetf(b * s)) / 2;
  };
}

/**
 * The colour space a clip converts from: the one the creator set, else the
 * one detected; undefined for Rec.709 or when a creator LUT replaces it
 * (as Premiere's Input LUT does).
 */
export function clipColorSpace(clip: Pick<ClipRef, "colorSpace" | "color" | "inputLut">): string | undefined {
  if (clip.inputLut) return undefined;
  const cs = clip.colorSpace ?? clip.color?.log ?? clip.color?.hdr;
  return cs && cs !== REC709 && FORMULAS[cs] ? cs : undefined;
}

/** The clip's input conversion, or null when it needs none. */
export function clipConversion(clip: Pick<ClipRef, "colorSpace" | "color" | "inputLut">): ((c: RGB) => void) | null {
  const cs = clipColorSpace(clip);
  return cs ? converter(cs, clip.color?.fullRange) : null;
}

/**
 * One LUT for a clip, in order: input (creator cube, else the log/HDR
 * conversion), then the grade. Null when the clip needs nothing.
 */
export function clipLut(clip: Pick<ClipRef, "colorSpace" | "color" | "inputLut" | "grade">, inputCube?: Cube | null, size = LUT_SIZE): Float32Array | null {
  const convert = inputCube ? (c: RGB) => { const o = sampleCube(inputCube, c); c[0] = o[0]; c[1] = o[1]; c[2] = o[2]; } : clipConversion(clip);
  const g: Grade | undefined = activeGrade(clip.grade);
  if (!convert && !g) return null;
  const out = new Float32Array(size ** 3 * 3), s = size - 1;
  let k = 0;
  for (let b = 0; b < size; b++) for (let gg = 0; gg < size; gg++) for (let r = 0; r < size; r++) {
    const c: RGB = [r / s, gg / s, b / s];
    convert?.(c);
    const o = g ? applyGrade(g, [clamp(c[0]), clamp(c[1]), clamp(c[2])]) : c;
    out[k++] = clamp(o[0]); out[k++] = clamp(o[1]); out[k++] = clamp(o[2]);
  }
  return out;
}

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
