// Debug view of a cut: each speaking clip's source time split into what the
// cut kept and what it removed, and why (pause, retake, false start, off
// topic, trimmed for length). Built from the EditDoc plus the take stage's
// removals; pure, so the trace stores it and any viewer can draw it.
import type { EditDoc } from "@voxtale/editdoc";

export type CutKind = "kept" | "unsure" | "pause" | "retake" | "false-start" | "setup" | "off-topic" | "length" | "cut";

export interface CutSegment {
  start: number;
  end: number;
  kind: CutKind;
  text?: string;
  reason?: string;
  confidence?: number;
  /** A-roll item, for kept and unsure parts. */
  itemId?: string;
  /** Where a kept part starts in the cut. */
  outStart?: number;
}
export interface CutWord { id: number; text: string; start: number; end: number; kind: CutKind; reason?: string }
export interface CutClip { clipId: string; name: string; duration: number; segments: CutSegment[]; words: CutWord[]; shots: number[] }
/** A join in the cut where source time was skipped. */
export interface CutJoin { at: number; seconds: number; kinds: CutKind[]; label: string }
export interface CutMap { clips: CutClip[]; joins: CutJoin[]; totals: Partial<Record<CutKind, number>> }

export interface TakeRemoval { startWord: number; endWord: number; kind: string; confidence: number; reason: string; applied: boolean }
export interface CutMapClip {
  clipId: string; name: string; duration: number;
  words: { id: number; text: string; start: number; end: number }[];
  shots?: { start: number }[];
}

/** Gaps under this between removed words of one reason stay one part. */
const JOIN_GAP = 0.5;
/** Shorter holes are frame rounding, not pauses. */
const MIN_PART = 0.05;
const round = (t: number) => Math.round(t * 1000) / 1000;

type Removed = { kind: CutKind; reason?: string; confidence?: number };

export function cutMap(doc: Pick<EditDoc, "tracks" | "brief">, clips: CutMapClip[], takes: ReadonlyMap<string, TakeRemoval[]> = new Map()): CutMap {
  const items = [...doc.tracks["a-roll"]].sort((a, b) => a.start - b.start);
  const dropped = doc.brief?.dropped ?? [];
  const out: CutClip[] = [];
  for (const c of clips) {
    const removals = takes.get(c.clipId) ?? [];
    const take = (id: number) => removals.find(r => id >= r.startWord && id <= r.endWord);
    const why = (w: CutMapClip["words"][number]): Removed => {
      const r = take(w.id);
      if (r?.applied) return { kind: r.kind as CutKind, reason: r.reason, confidence: r.confidence };
      const mid = (w.start + w.end) / 2;
      const d = dropped.find(x => x.clipId === c.clipId && mid >= x.in && mid <= x.out);
      if (d) return { kind: d.kind, reason: d.reason };
      return { kind: "cut" };
    };
    const mine = items.filter(i => i.clipId === c.clipId);
    const keptAt = (t: number) => mine.find(i => t >= i.in && t <= i.out);
    const words: CutWord[] = c.words.map(w => {
      const item = keptAt((w.start + w.end) / 2);
      if (item) {
        const flag = take(w.id);
        if (item.status === "remove-suggested") return { ...w, kind: "unsure" as const, ...(item.reason ? { reason: item.reason } : {}) };
        return { ...w, kind: flag && !flag.applied ? "unsure" as const : "kept" as const, ...(flag && !flag.applied ? { reason: `${flag.kind}: ${flag.reason}` } : {}) };
      }
      const r = why(w);
      return { ...w, kind: r.kind, ...(r.reason ? { reason: r.reason } : {}) };
    });

    const segments: CutSegment[] = [];
    // Kept ranges, merged where items touch (zoom splits one run into several items).
    const ranges = [...mine].sort((a, b) => a.in - b.in).map(i => ({
      start: i.in, end: i.out, kind: (i.status === "remove-suggested" ? "unsure" : "kept") as CutKind, itemId: i.id, outStart: i.start,
      ...(i.status === "remove-suggested" && i.reason ? { reason: i.reason } : {}), ...(i.confidence !== undefined ? { confidence: i.confidence } : {}),
    }));
    const removedParts = (a: number, b: number) => {
      const inside = words.filter(w => w.kind !== "kept" && w.kind !== "unsure" && (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 <= b);
      const parts: CutSegment[] = [];
      for (const w of inside) {
        const meta = why(w);
        const last = parts.at(-1);
        if (last && last.kind === meta.kind && last.reason === meta.reason && w.start - last.end < JOIN_GAP) {
          last.end = Math.min(b, w.end);
          last.text = `${last.text} ${w.text}`;
        } else {
          parts.push({ start: Math.max(a, w.start), end: Math.min(b, w.end), kind: meta.kind, text: w.text,
            ...(meta.reason ? { reason: meta.reason } : {}), ...(meta.confidence !== undefined ? { confidence: meta.confidence } : {}) });
        }
      }
      // What no word covers is silence or noise the cut left out.
      const filled: CutSegment[] = [];
      let t = a;
      for (const p of parts) {
        if (p.start - t >= MIN_PART) filled.push({ start: t, end: p.start, kind: "pause" });
        filled.push(p);
        t = p.end;
      }
      if (b - t >= MIN_PART) filled.push({ start: t, end: b, kind: "pause" });
      return filled;
    };
    let t = 0;
    for (const r of ranges) {
      if (r.start > t) segments.push(...removedParts(t, r.start));
      const last = segments.at(-1);
      // Overlapping items (a reorder can reuse source time) stay as drawn.
      if (last && last.kind === r.kind && r.start <= last.end + 1e-3 && r.kind === "kept") last.end = Math.max(last.end, r.end);
      else segments.push({ ...r, start: Math.max(r.start, t) });
      t = Math.max(t, r.end);
    }
    if (c.duration > t) segments.push(...removedParts(t, c.duration));
    out.push({
      clipId: c.clipId, name: c.name, duration: c.duration,
      segments: segments.filter(s => s.end - s.start > 1e-3).map(s => ({ ...s, start: round(s.start), end: round(s.end) })),
      words, shots: (c.shots ?? []).map(s => s.start).filter(s => s > 0),
    });
  }

  const joins: CutJoin[] = [];
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!, cur = items[i]!;
    if (cur.clipId !== prev.clipId) { joins.push({ at: cur.start, seconds: 0, kinds: [], label: "clip change" }); continue; }
    const skipped = cur.in - prev.out;
    if (skipped < -MIN_PART) { joins.push({ at: cur.start, seconds: round(skipped), kinds: [], label: "reorder" }); continue; }
    if (skipped < MIN_PART) continue;
    const clip = out.find(c => c.clipId === cur.clipId);
    const parts = clip?.segments.filter(s => s.kind !== "kept" && s.kind !== "unsure" && s.end > prev.out + 1e-3 && s.start < cur.in - 1e-3) ?? [];
    const kinds = [...new Set(parts.map(p => p.kind))];
    joins.push({ at: cur.start, seconds: round(skipped), kinds, label: `${kinds.join(" + ") || "cut"} ${skipped.toFixed(1)} s` });
  }

  const totals: CutMap["totals"] = {};
  for (const c of out) for (const s of c.segments) totals[s.kind] = round((totals[s.kind] ?? 0) + s.end - s.start);
  return { clips: out, joins, totals };
}
