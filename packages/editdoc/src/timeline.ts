// Timeline helpers: output time from clip ranges, captions that follow cuts.
import { snap, toFrame, type Fps } from "./time";
import {
  CLIP_TRACKS, TRACK_KINDS, type ARollItem, type BRollItem, type CaptionItem, type ClipItem, type EditDoc, type Item,
  type TrackKind, type Transition, type VoiceoverItem, type WordFix,
} from "./schema";
import type { CaptionStyle } from "./style";

export function isClipTrack(kind: TrackKind): kind is (typeof CLIP_TRACKS)[number] {
  return (CLIP_TRACKS as readonly TrackKind[]).includes(kind);
}

/** End of the last item on any track. */
export function docDuration(doc: EditDoc): number {
  let end = 0;
  for (const kind of TRACK_KINDS) for (const item of doc.tracks[kind]) end = Math.max(end, item.end);
  return end;
}

export function allItems(doc: EditDoc): Array<{ kind: TrackKind; item: Item }> {
  return TRACK_KINDS.flatMap(kind => (doc.tracks[kind] as Item[]).map(item => ({ kind, item })));
}

export function findItem(doc: EditDoc, id: string): { kind: TrackKind; item: Item } | undefined {
  return allItems(doc).find(x => x.item.id === id);
}

/**
 * Lay clip items end to end from `from`, in the given order. Output times are
 * derived from source ranges, frame-snapped. Used after assembly reorders or
 * trims the a-roll.
 */
export function packSequence<T extends ClipItem>(items: T[], fps: Fps, from = 0): T[] {
  let cursor = snap(from, fps);
  return items.map(item => {
    const inS = snap(item.in, fps), outS = snap(item.out, fps);
    const next = { ...item, in: inS, out: outS, start: cursor, end: snap(cursor + (outS - inS), fps) };
    cursor = next.end;
    return next;
  });
}

export interface TransitionJoin<T> {
  from: T;
  to: T;
  /** Output second of the join: the transition's middle. */
  at: number;
  transition: Transition;
}

/**
 * Transitions on one picture track as joins: each piece that asks for one and
 * starts where the piece before it ends (within half a frame). A piece whose
 * neighbour moved away keeps its field but plays as a hard cut.
 */
export function transitionJoins<T extends ARollItem | BRollItem>(items: T[], fps: Fps): TransitionJoin<T>[] {
  const live = items.filter(i => i.status !== "suggested").sort((a, b) => a.start - b.start);
  const out: TransitionJoin<T>[] = [];
  for (let i = 1; i < live.length; i++) {
    const to = live[i]!, from = live[i - 1]!;
    if (!to.transition || toFrame(to.start, fps) !== toFrame(from.end, fps)) continue;
    out.push({ from, to, at: to.start, transition: to.transition });
  }
  return out;
}

/** Where one a-roll piece is heard: its picture span moved by J/L cuts at its joins. */
export interface SoundSpan { item: ARollItem; start: number; end: number; in: number }

/**
 * Sound spans of the a-roll. A piece's \`audioLead\` starts its sound early and
 * stops the touching piece before it there; its \`audioLag\` runs its sound on
 * and starts the touching piece after it late. A lead or lag with no touching
 * neighbour does nothing. Spans never overlap: the sound cut just moves.
 */
export function soundSpans(items: ARollItem[], fps: Fps): SoundSpan[] {
  const live = items.filter(i => i.status !== "suggested").sort((a, b) => a.start - b.start);
  const touches = (a?: ARollItem, b?: ARollItem) => !!a && !!b && toFrame(a.end, fps) === toFrame(b.start, fps);
  return live.map((item, i) => {
    const prev = live[i - 1], next = live[i + 1];
    const early = touches(prev, item) ? (item.audioLead ?? 0) - (prev!.audioLag ?? 0) : 0;
    const late = touches(item, next) ? (item.audioLag ?? 0) - (next!.audioLead ?? 0) : 0;
    return { item, start: item.start - early, end: item.end + late, in: item.in - early };
  });
}

/** A transition length the schema takes: an even number of frames (so the middle is a frame edge), 0.2–1 s. */
export function transitionLength(seconds: number, fps: Fps): number {
  const rate = fps.num / fps.den;
  const lo = Math.ceil((0.2 * rate - 1e-6) / 2) * 2, hi = Math.floor((rate + 1e-6) / 2) * 2;
  const frames = Math.min(hi, Math.max(lo, Math.round((seconds * rate) / 2) * 2));
  return (frames * fps.den) / fps.num;
}

type SpeechItem = ARollItem | VoiceoverItem;
function speechItems(doc: EditDoc): SpeechItem[] {
  return [...doc.tracks["a-roll"], ...doc.tracks.voiceover].filter(i => i.status !== "suggested");
}

/**
 * Output times where a source instant plays. A source moment can play more
 * than once (a repeated range) or not at all (cut).
 */
export function outputTimes(doc: EditDoc, clipId: string, source: number): number[] {
  return speechItems(doc)
    .filter(i => i.clipId === clipId && source >= i.in && source < i.out)
    .map(i => i.start + (source - i.in));
}

/** Source clip and time at an output instant on the speech tracks. */
export function sourceAt(doc: EditDoc, t: number): { clipId: string; time: number; itemId: string } | undefined {
  const item = speechItems(doc).find(i => t >= i.start && t < i.end);
  return item && { clipId: item.clipId, time: item.in + (t - item.start), itemId: item.id };
}

export interface SourceWord {
  clipId: string;
  id: number;          // transcript word id
  text: string;
  start: number;       // source seconds
  end: number;
}

export function wordRef(w: Pick<SourceWord, "clipId" | "id">): string {
  return `${w.clipId}:${w.id}`;
}

/**
 * Captions from kept speech: only words whose middle plays inside a speech item,
 * grouped by pauses, sentence ends and the style's size limits, never across
 * an item boundary. Returns agent items; ids are stable for the same words.
 */
/**
 * A word as captions show it: no punctuation at the edges ("dramatically,"
 * → "dramatically"). Inner marks stay (it's, 3.5, U.S), as do $ % # +.
 */
export function captionWord(text: string): string {
  return text.replace(/^[^\p{L}\p{N}$#+]+|[^\p{L}\p{N}%+]+$/gu, "");
}

/** How far a fix's time may sit before its word's start and still hold it (transcripts shift starts by a few ms). Our pick. */
export const WORD_FIX_REACH = 0.05;
/** The word a fix holds: same clip, playing at its time (or starting just after). */
export function fixedWord<T extends { clipId: string; start: number; end: number }>(words: T[], fix: WordFix): T | undefined {
  const hits = words.filter(w => w.clipId === fix.clipId && fix.at >= w.start - WORD_FIX_REACH && fix.at < w.end);
  return hits.sort((a, b) => Math.abs(a.start - fix.at) - Math.abs(b.start - fix.at))[0];
}
/** Source words with the fixes applied. */
export function fixWords<T extends { clipId: string; start: number; end: number; text: string }>(words: T[], fixes: WordFix[]): T[] {
  if (!fixes.length) return words;
  const swap = new Map<T, string>();
  for (const f of fixes) { const w = fixedWord(words, f); if (w) swap.set(w, f.text); }
  return words.map(w => swap.has(w) ? { ...w, text: swap.get(w)! } : w);
}

export function buildCaptions(doc: EditDoc, source: SourceWord[], style: CaptionStyle, stage = "text"): CaptionItem[] {
  const out: CaptionItem[] = [];
  const words = fixWords(source, doc.wordFixes ?? []);
  const fps = doc.fps;
  // A line must fit the frame: about 0.55 of the type size per letter (0.65 in capitals), inside 86% of the width.
  const px = style.size * Math.min(doc.canvas.width, doc.canvas.height) / 1080;
  const maxChars = Math.max(8, Math.min(style.maxChars, Math.floor((0.86 * doc.canvas.width) / (px * (style.case === "upper" ? 0.65 : 0.55)))));
  for (const item of [...speechItems(doc)].sort((a, b) => a.start - b.start)) {
    // By midpoint: in/out snap to frames, so a kept word can start a few ms before `in`.
    const inside = words.filter(w => w.clipId === item.clipId && (w.start + w.end) / 2 >= item.in && (w.start + w.end) / 2 <= item.out);
    let group: SourceWord[] = [];
    const flush = () => {
      if (!group.length) return;
      const first = group[0]!, last = group.at(-1)!;
      const start = snap(item.start + Math.max(0, first.start - item.in), fps);
      const end = snap(Math.min(item.end, item.start + (last.end - item.in)), fps);
      const said = group.map(w => ({ text: captionWord(w.text), at: Math.max(0, item.start + (w.start - item.in) - start) })).filter(w => w.text);
      if (toFrame(end, fps) > toFrame(start, fps)) out.push({
        id: `cap-${item.id}-${first.id}`,
        start, end, owner: "agent", stage, status: "applied",
        text: said.map(w => w.text).join(" "),
        words: group.map(wordRef),
        wordStarts: said.map(w => +w.at.toFixed(3)),
      });
      group = [];
    };
    for (const w of inside) {
      const prev = group.at(-1);
      const joined = group.map(x => x.text).join(" ").length + 1 + w.text.length;
      if (prev && (w.start - prev.end > 0.5 || group.length >= style.maxWords || joined > maxChars)) flush();
      group.push(w);
      if (/[.!?]$/.test(w.text)) flush();
    }
    flush();
  }
  return out;
}

/** Words per second of each caption, for the reading-speed check. */
export function captionReadingSpeed(c: CaptionItem): number {
  return c.words.length / Math.max(0.001, c.end - c.start);
}

/**
 * Remove output time [start, end) and pull everything after it left. Items
 * inside the range go; items across an edge are trimmed (clip items keep
 * source and output lengths equal). Markers inside move to `start`.
 */
export function rippleClose(doc: EditDoc, start: number, end: number): EditDoc {
  const fps = doc.fps;
  const a = snap(start, fps), b = snap(end, fps), d = b - a;
  if (d <= 0) return doc;
  const next = structuredClone(doc);
  const tol = 0.5 / (fps.num / fps.den);
  for (const kind of TRACK_KINDS) {
    const items = next.tracks[kind] as Item[];
    const out: Item[] = [];
    for (const item of items) {
      if (item.start >= a - tol && item.end <= b + tol) continue;
      if (item.start >= b - tol) { out.push({ ...item, start: snap(item.start - d, fps), end: snap(item.end - d, fps) }); continue; }
      if (item.end <= a + tol) { out.push(item); continue; }
      const cutFrom = Math.max(item.start, a), cutTo = Math.min(item.end, b);
      const s = item.start < a ? item.start : a;
      const e = snap(item.end - (cutTo - cutFrom), fps);
      if (e - s < tol * 2) continue;
      const moved = { ...item, start: s, end: e } as Item;
      if (isClipTrack(kind)) {
        const c = moved as ClipItem;
        // Left part kept: shorten the source end. Starts inside: skip the cut source.
        if (item.start < a) c.out = snap(c.in + (e - s), fps);
        else { c.in = snap(c.in + (cutTo - item.start), fps); c.out = snap(c.in + (e - s), fps); }
      }
      out.push(moved);
    }
    (next.tracks as Record<TrackKind, Item[]>)[kind] = out;
  }
  next.markers = next.markers.map(m => m.time >= b - tol ? { ...m, time: snap(m.time - d, fps) } : m.time > a ? { ...m, time: a } : m);
  return next;
}
