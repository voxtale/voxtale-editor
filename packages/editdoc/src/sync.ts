// Sync groups: clips recorded together (cameras, mics, a screen) on one clock.
// A member's file starts `start` seconds into the group's clock, so
// member time = group time - start. A piece keeps its source range in its
// own clip's time (words, captions, zooms hold); its angle, mic and
// companions are read at the same moment, through the group. Pure.
import type { ARollItem, ClipRef, EditDoc, SyncGroup } from "./schema";
import { soundSpans } from "./timeline";

/** Sound matches at or above this peak-over-noise are sure. */
export const SYNC_CONFIDENCE_MIN = 8;

export function groupOf(groups: readonly SyncGroup[], clipId: string): SyncGroup | undefined {
  return groups.find(g => g.members.some(m => m.clipId === clipId));
}

/** `t` seconds into clip `from` as seconds into clip `to`; undefined when they are not in one group. */
export function syncTime(groups: readonly SyncGroup[], from: string, t: number, to: string): number | undefined {
  if (from === to) return t;
  const g = groupOf(groups, from);
  const a = g?.members.find(m => m.clipId === from), b = g?.members.find(m => m.clipId === to);
  return a && b ? t + a.start - b.start : undefined;
}

/** Offset for a companion or a job sync: `to` time = `from` time + offset. */
export const syncOffset = (groups: readonly SyncGroup[], from: string, to: string) => syncTime(groups, from, 0, to);

/** The source range [in, out) of `from` read from `to`, when `to` holds all of it. */
export function syncRange(groups: readonly SyncGroup[], clips: readonly Pick<ClipRef, "id" | "duration">[], from: string, inn: number, out: number, to: string, slack = 0.05): { in: number; out: number } | undefined {
  const a = syncTime(groups, from, inn, to), b = syncTime(groups, from, out, to);
  const c = clips.find(x => x.id === to);
  if (a === undefined || b === undefined || !c) return undefined;
  if (a < -slack || b > c.duration + slack) return undefined;
  return { in: Math.max(0, a), out: Math.min(c.duration, b) };
}

/** Where a piece's picture comes from: its angle when that clip covers the piece, else its own clip. */
export function pictureSource(doc: Pick<EditDoc, "groups" | "clips">, item: Pick<ARollItem, "clipId" | "in" | "out" | "angle">): { clipId: string; in: number; out: number; fellBack: boolean } {
  if (!item.angle || item.angle === item.clipId) return { clipId: item.clipId, in: item.in, out: item.out, fellBack: false };
  const r = syncRange(doc.groups, doc.clips, item.clipId, item.in, item.out, item.angle);
  return r ? { clipId: item.angle, ...r, fellBack: false } : { clipId: item.clipId, in: item.in, out: item.out, fellBack: true };
}

/** Where a piece's sound comes from: its mic when that clip covers the piece, else its own clip. */
export function soundSource(doc: Pick<EditDoc, "groups" | "clips">, item: Pick<ARollItem, "clipId" | "in" | "out" | "mic">): { clipId: string; in: number; out: number; fellBack: boolean } {
  if (!item.mic || item.mic === item.clipId) return { clipId: item.clipId, in: item.in, out: item.out, fellBack: false };
  const r = syncRange(doc.groups, doc.clips, item.clipId, item.in, item.out, item.mic);
  return r ? { clipId: item.mic, ...r, fellBack: false } : { clipId: item.clipId, in: item.in, out: item.out, fellBack: true };
}

/**
 * A group from each file's start on a shared clock, earliest at 0. Files
 * whose match falls under `min` confidence stay out; null when fewer than
 * two are left.
 */
// t0 = earliest member; doubtful under 8.
export function groupFromStarts(id: string, placed: readonly { clipId: string; start: number; confidence?: number }[], min = SYNC_CONFIDENCE_MIN): SyncGroup | null {
  const sure = placed.filter(p => p.confidence === undefined || p.confidence >= min);
  if (sure.length < 2) return null;
  const t0 = Math.min(...sure.map(p => p.start));
  return {
    id, via: "sound",
    members: sure.map(p => ({ clipId: p.clipId, start: Math.round((p.start - t0) * 10000) / 10000, ...(p.confidence !== undefined ? { confidence: Math.min(999, Math.round(p.confidence * 10) / 10) } : {}) })),
  };
}

/**
 * Seconds where two members both run, on the group clock: a match that
 * barely overlaps is likely chance.
 */
export function overlapSeconds(g: SyncGroup, clips: readonly Pick<ClipRef, "id" | "duration">[], a: string, b: string): number {
  const span = (id: string) => {
    const m = g.members.find(x => x.clipId === id), c = clips.find(x => x.id === id);
    return m && c ? [m.start, m.start + c.duration] as const : null;
  };
  const x = span(a), y = span(b);
  return x && y ? Math.max(0, Math.min(x[1], y[1]) - Math.max(x[0], y[0])) : 0;
}

/**
 * The member that sounds most active over [from, to) of the group clock:
 * each member's level (dB, one value per `step` seconds of its own file)
 * above its own median, so a hot mic does not win by gain alone. The lav of
 * whoever speaks, or the camera nearest them, comes out on top. Undefined
 * when no candidate has levels there.
 */
export function activeMember(g: SyncGroup, levels: Readonly<Record<string, readonly number[]>>, step: number, from: number, to: number, candidates?: readonly string[]): string | undefined {
  let best: string | undefined, top = -Infinity;
  for (const m of g.members) {
    if (candidates && !candidates.includes(m.clipId)) continue;
    const l = levels[m.clipId];
    if (!l?.length) continue;
    const a = Math.max(0, Math.floor((from - m.start) / step)), b = Math.min(l.length, Math.ceil((to - m.start) / step));
    if (b <= a) continue;
    const above = mean(l.slice(a, b)) - median(l);
    if (above > top) { top = above; best = m.clipId; }
  }
  return best;
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

/** Problems with the groups: unknown clips, a clip in two groups. */
export function groupIssues(doc: Pick<EditDoc, "groups" | "clips">): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const ids = new Set(doc.clips.map(c => c.id)), seen = new Map<string, string>();
  doc.groups.forEach((g, i) => g.members.forEach((m, k) => {
    const at = `groups.${i}.members.${k}`;
    if (!ids.has(m.clipId)) out.push({ path: at, message: `Unknown clip ${m.clipId}` });
    const other = seen.get(m.clipId);
    if (other) out.push({ path: at, message: `Clip ${m.clipId} is in groups ${other} and ${g.id}` });
    seen.set(m.clipId, g.id);
  }));
  return out;
}

/**
 * A piece's companions with their source in-point: through the sync group
 * when both clips are in one (it beats a stored offset), else the stored
 * offset. Companions that do not hold the whole piece drop out; so does the
 * clip already shown (`shown`, the angle on multicam).
 */
export function companionSources(doc: Pick<EditDoc, "groups" | "clips">, a: Pick<ARollItem, "clipId" | "in" | "out" | "companions">, shown: string): { clipId: string; in: number }[] {
  const out: { clipId: string; in: number }[] = [];
  for (const m of a.companions ?? []) {
    if (m.clipId === shown) continue;
    const r = syncRange(doc.groups, doc.clips, a.clipId, a.in, a.out, m.clipId);
    if (r) { out.push({ clipId: m.clipId, in: r.in }); continue; }
    const c = doc.clips.find(x => x.id === m.clipId), inn = a.in + m.offset;
    if (c && inn >= -0.05 && a.out + m.offset <= c.duration + 0.05) out.push({ clipId: m.clipId, in: Math.max(0, inn) });
  }
  return out;
}

/** One a-roll piece as heard: output span, the file it plays (its mic) and the source second at `start`. */
/** `span`: the heard length before a negative avOffset trimmed its head (cut fades size from it). */
export interface HeardSpeech { item: ARollItem; clipId: string; start: number; end: number; in: number; span: number; fellBack: boolean }

/**
 * Where each shown a-roll piece is heard: J/L cuts move the span, the mic
 * gives the file (read in step through the group), and that file's avOffset
 * moves its sound later. A piece muted to the -60 dB floor, or whose clip has
 * no sound, plays nothing. Render and export both read this.
 */
export function speechSounds(doc: Pick<EditDoc, "groups" | "clips" | "tracks" | "fps">): HeardSpeech[] {
  const clips = new Map(doc.clips.map(c => [c.id, c]));
  const sounding = (id: string) => { const c = clips.get(id); return !!c && c.hasAudio && c.kind !== "image"; };
  const out: HeardSpeech[] = [];
  const shownItems = doc.tracks["a-roll"].filter(i => i.status !== "suggested" && i.end - i.start > 0);
  for (const { item: a, start, end, in: inn } of soundSpans(shownItems, doc.fps)) {
    if (!sounding(a.clipId) || a.gainDb <= -60) continue;
    const mic = soundSource(doc, { clipId: a.clipId, in: inn, out: inn + (end - start), mic: a.mic });
    const id = mic.fellBack ? a.clipId : mic.clipId;
    const shifted = mic.in - (clips.get(id)?.avOffset ?? 0), late = Math.max(0, -shifted);
    if (late >= end - start) continue;
    out.push({ item: a, clipId: id, start: start + late, end, in: shifted + late, span: end - start, fellBack: mic.fellBack });
  }
  return out;
}
