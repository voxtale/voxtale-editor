// The creator's work survives the agent. An agent tool rebuilds whole tracks
// from its own plan; `keepCreatorItems` lays the creator's items back over
// that build: items they added or changed by hand stay as they are (moved
// with their words when the cut changes), locked tracks stay untouched, and
// agent items that would collide with a creator item are dropped. An agent
// call that names a creator item (same id) may change it, but the fields the
// creator set by hand stay theirs. Pure: no I/O.
import { POLICY_KEYS, TRACK_KINDS, type ARollItem, type EditDoc, type Item, type Marker, type PolicyKey, type TrackKind } from "./schema";
import { frameToSeconds, toFrame, type Fps } from "./time";
import { parseEditDoc } from "./validate";

export interface KeepOptions {
  /** Item ids this agent call names explicitly (re-placed or removed by id). */
  named?: (id: string) => boolean;
  /** Item ids the agent removed by name: gone even when the creator owned them. */
  drop?: ReadonlySet<string>;
  /** Fields the creator set by hand, by item id: a named rewrite keeps them. */
  hand?: Readonly<Record<string, readonly string[]>>;
  /** This call replaced the cut: take the new a-roll even over hand trims. */
  cutChanged?: boolean;
}

export interface KeepReport {
  /** Creator items laid back over the build. */
  kept: string[];
  /** Creator items the agent changed by name; `fields` stayed the creator's. */
  merged: { id: string; fields: string[] }[];
  /** Agent items left out, and why. */
  dropped: { id: string; why: string }[];
  /** Agent items cut short where a creator item already sits on that layer. */
  trimmed: { id: string; start: number; end: number; by: string }[];
  /** Creator items that could not stay, and why (their words were cut, removed by name). */
  lost: { id: string; why: string }[];
  /** Tracks the creator locked (or turned off): the agent's changes there were not applied. */
  locked: PolicyKey[];
}

/** Tracks whose items may not overlap (the doc check refuses it), plus tracks where a second item at once would clash. */
const EXCLUSIVE: readonly TrackKind[] = ["a-roll", "b-roll", "captions", "voiceover", "zoom", "text", "graphics", "music"];
const SINGLE_LAYER: readonly TrackKind[] = ["a-roll", "b-roll", "captions", "voiceover", "zoom"];
const SPEECH: readonly TrackKind[] = ["a-roll", "voiceover"];
/**
 * Tracks with no source time, so an agent item that only grazes a creator one
 * can be cut short instead of dropped. Not footage: shortening b-roll would
 * shift its source in-point.
 */
const TRIMMABLE: readonly TrackKind[] = ["zoom"];
/** Shortest trimmed zoom worth keeping: under a second it reads as a twitch, not a punch-in. */
const MIN_TRIMMED = 1;
/** Chapters closer than this to a creator chapter are the same chapter. */
const CHAPTER_NEAR = 1;

const frozen = (doc: EditDoc, key: PolicyKey) => doc.policy[key] === "locked" || doc.policy[key] === "off";
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end - 1e-6 && b.start < a.end - 1e-6;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Where output second `t` of cut `from` plays in cut `to`: the same source
 * moment of the same clip. `side` "end" reads an item's end (the moment just
 * before t). Undefined when that moment is no longer in `to`.
 */
export function retime(t: number, from: readonly ARollItem[], to: readonly ARollItem[], side: "start" | "end" = "start"): number | undefined {
  const inside = (i: { start: number; end: number }, x: number) => side === "start" ? i.start <= x + 1e-6 && x < i.end - 1e-6 : i.start < x - 1e-6 && x <= i.end + 1e-6;
  const a = from.find(i => inside(i, t));
  if (!a) {
    // Past the end of the old cut: the end of the new one.
    const endFrom = Math.max(0, ...from.map(i => i.end)), endTo = Math.max(0, ...to.map(i => i.end));
    return t >= endFrom - 1e-6 ? endTo : undefined;
  }
  const src = a.in + (t - a.start);
  const hits = to.filter(i => i.clipId === a.clipId && (side === "start" ? i.in <= src + 1e-6 && src < i.out - 1e-6 : i.in < src - 1e-6 && src <= i.out + 1e-6));
  if (!hits.length) return undefined;
  // A line that plays twice (a teaser): the copy nearest where it was.
  const best = hits.reduce((p, i) => Math.abs(i.start + (src - i.in) - t) < Math.abs(p.start + (src - p.in) - t) ? i : p);
  return best.start + (src - best.in);
}

type Timed = { id: string; start: number; end: number };

/** An item moved from cut `from` to cut `to` by its source moment; undefined when its start was cut. */
function moveItem<T extends Timed>(item: T, from: readonly ARollItem[], to: readonly ARollItem[], cutEnd: number, fps: Fps): T | undefined {
  if (same(from, to)) return item;
  const at = retime(item.start, from, to, "start");
  if (at === undefined) return undefined;
  const snap = (t: number) => frameToSeconds(toFrame(t, fps), fps);
  const start = snap(at);
  const len = item.end - item.start;
  // A file plays at its own pace: keep its length. An overlay ends with its last word when it can.
  const plays = "clipId" in item;
  const mapped = plays ? undefined : retime(item.end, from, to, "end");
  const end = snap(Math.min(cutEnd, mapped !== undefined && mapped > start ? mapped : start + len));
  if (end - start <= 1e-6) return undefined;
  if (!plays) return { ...item, start, end };
  // Clipped at the end of the cut: play that much less of the file.
  const p = item as unknown as { in: number; out: number; speed?: number };
  return { ...item, start, end, out: p.in + (end - start) * (p.speed ?? 1) };
}

function moveMarker(m: Marker, from: readonly ARollItem[], to: readonly ARollItem[], fps: Fps): Marker | undefined {
  if (same(from, to)) return m;
  const time = retime(m.time, from, to, "start");
  return time === undefined ? undefined : { ...m, time: frameToSeconds(toFrame(time, fps), fps) };
}

/**
 * `built` (a fresh agent build) with the creator's work from `prev` laid back
 * over it. Without `prev` there is nothing to keep.
 */
export function keepCreatorItems(prev: EditDoc | undefined, built: EditDoc, o: KeepOptions = {}): { doc: EditDoc; report: KeepReport } {
  const report: KeepReport = { kept: [], merged: [], dropped: [], trimmed: [], lost: [], locked: [] };
  if (!prev) return { doc: built, report };
  const named = o.named ?? (() => false);
  const drop = o.drop ?? new Set<string>();
  const declined = new Set([...prev.declined, ...built.declined]);
  const out: EditDoc = structuredClone(built);
  out.policy = { ...prev.policy };
  out.declined = [...declined].slice(-5000);
  out.declinedText = [...new Set([...prev.declinedText, ...built.declinedText])].slice(-500);
  if (prev.editorExtras !== undefined) out.editorExtras = prev.editorExtras;

  // Items on a clip this edit no longer has cannot stay.
  const clipIds = new Set(built.clips.map(c => c.id));
  const gone = (i: Item) => "clipId" in i && !clipIds.has(i.clipId);

  // 1. The cut. A locked cut, or hand trims on a call that did not recut, stay as the creator left them.
  const prevRoll = prev.tracks["a-roll"], builtRoll = built.tracks["a-roll"];
  for (const kind of SPEECH) {
    const before = prev.tracks[kind] as Item[], fresh = built.tracks[kind] as Item[];
    const hand = before.some(i => i.owner === "creator");
    if (before.some(gone)) {
      for (const i of before) if (i.owner === "creator") report.lost.push({ id: i.id, why: "its clip left the edit" });
    } else if (frozen(prev, kind)) {
      if (!same(before, fresh)) report.locked.push(kind);
      (out.tracks as Record<TrackKind, Item[]>)[kind] = before;
    } else if (hand && !o.cutChanged) {
      (out.tracks as Record<TrackKind, Item[]>)[kind] = before;
      report.kept.push(...before.filter(i => i.owner === "creator").map(i => i.id));
    } else if (hand) {
      for (const i of before) if (i.owner === "creator" && !fresh.some(f => f.id === i.id)) report.lost.push({ id: i.id, why: "the new cut replaced it" });
    }
  }
  const roll = out.tracks["a-roll"], fps = out.fps;
  const cutEnd = Math.max(0, ...roll.map(i => i.end), ...out.tracks.voiceover.map(i => i.end));

  // 2. Every other track: creator items back, moved with their words; agent items onto the cut that won.
  for (const kind of TRACK_KINDS) {
    if (SPEECH.includes(kind)) continue;
    const before = prev.tracks[kind] as Item[];
    const fresh = (built.tracks[kind] as Item[]).flatMap(i => {
      const m = moveItem(i, builtRoll, roll, cutEnd, fps);
      return m ? [m] : [];
    });
    if (frozen(prev, kind)) {
      if (!same(before, built.tracks[kind])) report.locked.push(kind);
      (out.tracks as Record<TrackKind, Item[]>)[kind] = before.filter(i => !gone(i)).flatMap(i => {
        const m = moveItem(i, prevRoll, roll, cutEnd, fps);
        if (!m) report.lost.push({ id: i.id, why: "its words were cut" });
        return m ? [m] : [];
      });
      continue;
    }
    const kept: Item[] = [];
    for (const c of before.filter(i => i.owner === "creator")) {
      if (drop.has(c.id)) { report.lost.push({ id: c.id, why: "removed by name" }); continue; }
      if (gone(c)) { report.lost.push({ id: c.id, why: "its clip left the edit" }); continue; }
      const moved = moveItem(c, prevRoll, roll, cutEnd, fps);
      if (!moved) { report.lost.push({ id: c.id, why: "its words were cut" }); continue; }
      const mine = fresh.find(f => f.id === c.id);
      if (mine && named(c.id)) {
        // Named: the agent's version, with what the creator set by hand over it.
        const fields = (o.hand?.[c.id] ?? []).filter(f => f !== "owner" && f !== "status" && f in moved);
        const merged = { ...mine, ...Object.fromEntries(fields.map(f => [f, (moved as Record<string, unknown>)[f]])), owner: "creator" } as Item;
        kept.push(merged);
        report.merged.push({ id: c.id, fields });
      } else {
        kept.push(moved);
        report.kept.push(c.id);
      }
    }
    const taken = new Set(kept.map(i => i.id));
    const agent = fresh.map(i => {
      if (!TRIMMABLE.includes(kind) || taken.has(i.id)) return i;
      const hits = kept.filter(k => overlaps(k, i));
      if (!hits.length) return i;
      // Free stretch left after the creator items at either edge; none inside it.
      const start = Math.max(i.start, ...hits.filter(k => k.start <= i.start + 1e-6).map(k => k.end));
      const end = Math.min(i.end, ...hits.filter(k => k.end >= i.end - 1e-6).map(k => k.start));
      if (end - start < MIN_TRIMMED || hits.some(k => overlaps(k, { start, end }))) return i;
      report.trimmed.push({ id: i.id, start, end, by: hits.map(k => k.id).join(", ") });
      const z = { ...i, start, end } as Item & { easeIn?: number; easeOut?: number };
      if (z.easeIn !== undefined) z.easeIn = Math.min(z.easeIn, end - start);
      if (z.easeOut !== undefined) z.easeOut = Math.min(z.easeOut, end - start - (z.easeIn ?? 0));
      return z as Item;
    }).filter(i => {
      if (taken.has(i.id)) return false;
      if (drop.has(i.id)) return false;
      if (declined.has(i.id) && !named(i.id)) { report.dropped.push({ id: i.id, why: "the creator deleted it" }); return false; }
      if (EXCLUSIVE.includes(kind)) {
        const hit = kept.find(k => overlaps(k, i));
        // Named items may share a layered track with the creator's; never a single-layer one.
        if (hit && (SINGLE_LAYER.includes(kind) || !named(i.id))) { report.dropped.push({ id: i.id, why: `overlaps creator item ${hit.id}` }); return false; }
      }
      return true;
    });
    (out.tracks as Record<TrackKind, Item[]>)[kind] = [...kept, ...agent].sort((a, b) => a.start - b.start);
  }

  // 3. Chapters and notes, the same way.
  const freshMarkers = built.markers.flatMap(m => { const x = moveMarker(m, builtRoll, roll, fps); return x ? [x] : []; });
  if (frozen(prev, "markers")) {
    if (!same(prev.markers, built.markers)) report.locked.push("markers");
    out.markers = prev.markers.flatMap(m => { const x = moveMarker(m, prevRoll, roll, fps); return x ? [x] : []; });
  } else {
    const kept = prev.markers.filter(m => m.owner === "creator" && !drop.has(m.id)).flatMap(m => {
      const x = moveMarker(m, prevRoll, roll, fps);
      if (!x) report.lost.push({ id: m.id, why: "its words were cut" });
      else report.kept.push(m.id);
      return x ? [x] : [];
    });
    const taken = new Set(kept.map(m => m.id));
    const agent = freshMarkers.filter(m => {
      if (taken.has(m.id) || drop.has(m.id)) return false;
      if (declined.has(m.id) && !named(m.id)) { report.dropped.push({ id: m.id, why: "the creator deleted it" }); return false; }
      const hit = kept.find(k => k.kind === m.kind && Math.abs(k.time - m.time) < CHAPTER_NEAR);
      if (hit) { report.dropped.push({ id: m.id, why: `next to creator ${hit.kind} ${hit.id}` }); return false; }
      return true;
    });
    out.markers = [...kept, ...agent].sort((a, b) => a.time - b.time);
  }
  report.locked = [...new Set(report.locked)].filter(k => (POLICY_KEYS as readonly string[]).includes(k));
  return { doc: parseEditDoc(out).doc, report };
}

/** Top-level fields of `a` and `b` that differ (owner and status aside). */
function changedFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => k !== "owner" && k !== "status" && !same(a[k], b[k]));
}

export interface HandEdits {
  /** `disk` with every item the creator added or changed owned by the creator. */
  doc: EditDoc;
  /** Fields the creator changed, by item id ("*" = the creator made the item). */
  hand: Record<string, string[]>;
  /** Agent items the creator deleted (now in `doc.declined`). */
  deleted: string[];
}

/**
 * What the creator did by hand to the agent's last save: `written` is the doc
 * as the agent wrote it, `disk` as it stands now. Items added or changed
 * become the creator's; agent items deleted are declined, so the agent does
 * not bring them back.
 */
export function handEdits(written: EditDoc, disk: EditDoc): HandEdits {
  const hand: Record<string, string[]> = {};
  const deleted: string[] = [];
  const doc = structuredClone(disk);
  const claim = <T extends { id: string; owner: "agent" | "creator" }>(was: T[], now: T[]): T[] => {
    const before = new Map(was.map(i => [i.id, i]));
    const ids = new Set(now.map(i => i.id));
    for (const w of was) if (w.owner === "agent" && !ids.has(w.id)) deleted.push(w.id);
    return now.map(i => {
      const w = before.get(i.id);
      if (!w) { hand[i.id] = ["*"]; return { ...i, owner: "creator" }; }
      const fields = changedFields(w as Record<string, unknown>, i as Record<string, unknown>);
      if (fields.length || (i.owner === "creator" && w.owner === "agent")) { hand[i.id] = fields; return { ...i, owner: "creator" }; }
      return i;
    });
  };
  for (const kind of TRACK_KINDS)
    (doc.tracks as Record<TrackKind, Item[]>)[kind] = claim(written.tracks[kind] as Item[], disk.tracks[kind] as Item[]);
  doc.markers = claim(written.markers, disk.markers);
  doc.declined = [...new Set([...disk.declined, ...deleted])].slice(-5000);
  return { doc, hand, deleted };
}

/** The report in a few lines for a tool result; empty when nothing was kept or dropped. */
export function keepText(r: KeepReport): string {
  const lines: string[] = [];
  if (r.kept.length) lines.push(`kept the creator's own items as they are: ${[...new Set(r.kept)].join(", ")}`);
  for (const m of r.merged) lines.push(`changed creator item ${m.id} as asked; kept their hand-set ${m.fields.length ? m.fields.join(", ") : "nothing (no hand fields recorded)"}`);
  if (r.lost.length) lines.push(`creator items gone: ${r.lost.map(l => `${l.id} (${l.why})`).join(", ")}`);
  for (const t of r.trimmed) lines.push(`your ${t.id} cut to ${t.start.toFixed(2)}-${t.end.toFixed(2)}s: creator item ${t.by} holds the rest`);
  if (r.dropped.length) lines.push(`your items left out: ${r.dropped.map(d => `${d.id} (${d.why})`).join(", ")}`);
  if (r.locked.length) lines.push(`locked by the creator, not changed: ${r.locked.join(", ")}`);
  return lines.join("\n");
}
