// Hard-cut detection from small RGB frames. Port of voxtale_native
// video_pacing (HSV 8x8x8 histogram, Pearson correlation between neighbours),
// but fed every frame so cuts land on exact frames. Pure: the caller decodes
// (desktop: bundled FFmpeg `-vf scale=96:54 -pix_fmt rgb24 -f rawvideo`).

export const SHOT_SAMPLE_WIDTH = 96;
export const SHOT_SAMPLE_HEIGHT = 54;
// Same threshold the Python detector calibrated on real footage (2026-07-17).
export const CUT_CORRELATION = 0.75;
export const MIN_SHOT_SECONDS = 0.5;

const BINS = 8;

/** 512-bin HSV histogram of one RGB24 frame, OpenCV conventions (H 0..180). */
export function hsvHistogram(rgb: Uint8Array): Float64Array {
  const hist = new Float64Array(BINS * BINS * BINS);
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const r = rgb[i]!, g = rgb[i + 1]!, b = rgb[i + 2]!;
    const v = Math.max(r, g, b);
    const d = v - Math.min(r, g, b);
    const s = v === 0 ? 0 : (255 * d) / v;
    let h = 0;
    if (d !== 0) {
      if (v === r) h = (60 * (g - b)) / d;
      else if (v === g) h = 120 + (60 * (b - r)) / d;
      else h = 240 + (60 * (r - g)) / d;
      if (h < 0) h += 360;
    }
    const hb = Math.min(BINS - 1, Math.floor((h / 2) / (180 / BINS)));
    const sb = Math.min(BINS - 1, Math.floor(s / (256 / BINS)));
    const vb = Math.min(BINS - 1, Math.floor(v / (256 / BINS)));
    hist[(hb * BINS + sb) * BINS + vb]! += 1;
  }
  return hist;
}

/** Pearson correlation, as cv2.HISTCMP_CORREL. */
export function histogramCorrelation(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma, y = b[i]! - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 1 : num / den;
}

export interface ShotCut {
  frame: number;       // first frame of the new shot
  time: number;        // frame / fps
  correlation: number; // lower = harder cut
}

/**
 * Streaming detector: push frames in order, read cuts at the end. Keeps one
 * histogram in memory, so an hour of footage costs nothing extra.
 */
export class ShotDetector {
  private previous: Float64Array | null = null;
  private frame = 0;
  private lastCutAt = -Infinity;
  readonly cuts: ShotCut[] = [];

  constructor(private readonly fps: number, private readonly threshold = CUT_CORRELATION, private readonly minShotSeconds = MIN_SHOT_SECONDS) {
    if (!(fps > 0)) throw new Error("fps must be positive");
  }

  push(rgb: Uint8Array): void {
    const hist = hsvHistogram(rgb);
    if (this.previous) {
      const correlation = histogramCorrelation(this.previous, hist);
      const time = this.frame / this.fps;
      if (correlation < this.threshold && time - this.lastCutAt >= this.minShotSeconds) {
        this.cuts.push({ frame: this.frame, time, correlation });
        this.lastCutAt = time;
      }
    }
    this.previous = hist;
    this.frame += 1;
  }

  get framesSeen(): number { return this.frame; }
}
