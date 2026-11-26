// Frame math. Every time in an EditDoc is seconds on the output or source
// clock; these helpers keep them on frame boundaries of a rational rate.
import { z } from "zod";

export const fpsSchema = z.object({
  num: z.number().int().positive().max(240_000),
  den: z.number().int().positive().max(1001),
}).strict();
export type Fps = z.infer<typeof fpsSchema>;

export const FPS_30: Fps = { num: 30, den: 1 };

export function fpsValue(fps: Fps): number {
  return fps.num / fps.den;
}

/** Nearest frame index for a time in seconds. */
export function toFrame(seconds: number, fps: Fps): number {
  return Math.round((seconds * fps.num) / fps.den);
}

export function frameToSeconds(frame: number, fps: Fps): number {
  return (frame * fps.den) / fps.num;
}

/** Snap seconds to the nearest frame boundary. */
export function snap(seconds: number, fps: Fps): number {
  return frameToSeconds(toFrame(seconds, fps), fps);
}

/** Float noise a time may carry and still count as on its frame. */
const FRAME_EPS = 1e-6;

/** The frame boundary at or before `seconds`: an in-point rounded this way never loses sound it meant to keep. */
export function snapDown(seconds: number, fps: Fps): number {
  return frameToSeconds(Math.floor((seconds * fps.num) / fps.den + FRAME_EPS), fps);
}

/** The frame boundary at or after `seconds`: an out-point rounded this way never cuts sound it meant to keep. */
export function snapUp(seconds: number, fps: Fps): number {
  return frameToSeconds(Math.ceil((seconds * fps.num) / fps.den - FRAME_EPS), fps);
}

/** Same frame at this rate (tolerates float noise). */
export function sameFrame(a: number, b: number, fps: Fps): boolean {
  return toFrame(a, fps) === toFrame(b, fps);
}

/** Parse "30000/1001", "29.97", "30" into a rational rate. */
export function parseFps(value: string | number): Fps {
  const text = String(value).trim();
  const ratio = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (ratio) return fpsSchema.parse({ num: Number(ratio[1]), den: Number(ratio[2]) });
  const n = Number(text);
  if (!(n > 0)) throw new Error(`Invalid frame rate: ${value}`);
  for (const [num, den] of [[24000, 1001], [30000, 1001], [60000, 1001]] as const)
    if (Math.abs(n - num / den) < 0.005) return { num, den };
  if (Number.isInteger(n)) return { num: n, den: 1 };
  return fpsSchema.parse({ num: Math.round(n * 1000), den: 1000 });
}
