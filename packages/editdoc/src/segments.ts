// Index segments: our shot cuts plus a length cap own the times; the model
// only labels each segment (spike 2, docs/agentic-video-editor-spike2.md).

export const MAX_SEGMENT_SECONDS = 20;

export interface Segment {
  id: string;             // S001, S002, … in clip order
  start: number;
  end: number;
  stills: number[];       // times to grab frames at: 30% and 70%, one if short
}

/**
 * Split [0, duration) at shot cuts, then split long shots evenly so no
 * segment runs past `maxSeconds`.
 */
export function segmentsFromCuts(duration: number, cuts: number[], maxSeconds = MAX_SEGMENT_SECONDS): Segment[] {
  if (!(duration > 0)) return [];
  const bounds = [0, ...[...new Set(cuts)].filter(t => t > 0 && t < duration).sort((a, b) => a - b), duration];
  const out: Segment[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const a = bounds[i - 1]!, b = bounds[i]!;
    const parts = Math.max(1, Math.ceil((b - a) / maxSeconds - 1e-9));
    const step = (b - a) / parts;
    for (let p = 0; p < parts; p++) {
      const start = a + p * step, end = p === parts - 1 ? b : a + (p + 1) * step;
      const len = end - start;
      const r = (x: number) => Math.round(x * 1000) / 1000;
      out.push({
        id: `S${String(out.length + 1).padStart(3, "0")}`,
        start: r(start), end: r(end),
        stills: len < 2 ? [r(start + len / 2)] : [r(start + len * 0.3), r(start + len * 0.7)],
      });
    }
  }
  return out;
}
