// Creator changes from the editor, and the decision log they produce.
// Creators are not bound by the track policy; whatever they touch becomes
// theirs, and the agent never modifies it again.
import { ITEM_SCHEMAS, TRACK_KINDS, markerSchema, mixSchema, type EditDoc, type Item, type Marker, type MixSettings, type PolicyKey, type TrackKind } from "./schema";
import { editStyleSchema, type CaptionStyle, type EditStyle } from "./style";
import { acceptSuggestion, rejectSuggestion, type TrackChange } from "./policy";
import { parseEditDoc } from "./validate";

export interface CreatorPatch {
  tracks?: { [K in TrackKind]?: TrackChange<K> };
  markers?: { upsert?: Marker[]; remove?: string[] };
  editorExtras?: unknown;
  /** Look changes made in the editor: they land in the doc's style snapshot. */
  style?: StylePatch;
  mix?: Partial<MixSettings>;
}

/** The parts of the edit style a creator can change by hand. */
export interface StylePatch {
  brand?: {
    colors?: Partial<EditStyle["brand"]["colors"]>;
    fonts?: Partial<EditStyle["brand"]["fonts"]>;
    captionStyle?: Partial<CaptionStyle>;
    logoAssetId?: string | null;
    safeMargins?: number;
  };
  pace?: { captions?: EditStyle["pace"]["captions"] };
  audio?: { musicLevelDb?: number };
}

/** `style` with `patch` laid over it; throws when a value is out of range. */
export function patchStyle(style: EditStyle, patch: StylePatch): EditStyle {
  const b = patch.brand ?? {};
  const brand = {
    ...style.brand,
    colors: { ...style.brand.colors, ...b.colors },
    fonts: { ...style.brand.fonts, ...b.fonts },
    captionStyle: { ...style.brand.captionStyle, ...b.captionStyle },
    ...(b.safeMargins !== undefined ? { safeMargins: b.safeMargins } : {}),
  };
  if (b.logoAssetId === null) delete brand.logoAssetId;
  else if (b.logoAssetId !== undefined) brand.logoAssetId = b.logoAssetId;
  return editStyleSchema.parse({
    ...style,
    brand,
    pace: { ...style.pace, ...patch.pace },
    audio: { ...style.audio, ...patch.audio },
  });
}

export function applyCreatorPatch(doc: EditDoc, patch: CreatorPatch): EditDoc {
  const next = structuredClone(doc);
  const merge = <T extends { id: string }>(list: T[], upsert: T[], remove: string[]): T[] => {
    const drop = new Set(remove);
    let out = list.filter(x => !drop.has(x.id));
    for (const item of upsert) {
      out = out.filter(x => x.id !== item.id && (x as { replaces?: string }).replaces !== item.id);
      out.push(item);
    }
    return out;
  };
  for (const kind of TRACK_KINDS) {
    const c = patch.tracks?.[kind] as TrackChange<TrackKind> | undefined;
    if (!c) continue;
    // Released clients built on v2 still send a-roll items with their old zoom keys; zooms now live on their own track.
    const fit = (x: object) => (kind === "a-roll" && "zoom" in x ? (({ zoom: _, ...rest }) => rest)(x as { zoom?: unknown }) : x);
    const upsert = (c.upsert ?? []).map(x => ITEM_SCHEMAS[kind].parse({ ...fit(x), owner: "creator", status: "applied", replaces: undefined }) as Item);
    (next.tracks as Record<TrackKind, Item[]>)[kind] = merge(next.tracks[kind] as Item[], upsert, c.remove ?? []).sort((a, b) => a.start - b.start);
  }
  if (patch.markers) {
    const upsert = (patch.markers.upsert ?? []).map(m => markerSchema.parse({ ...m, owner: "creator", status: "applied" }));
    next.markers = merge(next.markers, upsert, patch.markers.remove ?? []).sort((a, b) => a.time - b.time);
  }
  if ("editorExtras" in patch) next.editorExtras = patch.editorExtras;
  // A hand-tuned look is the creator's: a new cut keeps it (story-edit reuses the snapshot).
  if (patch.style) next.styleRef = { ...next.styleRef, snapshot: patchStyle(next.styleRef.snapshot, patch.style) };
  if (patch.mix) next.mix = mixSchema.parse({ ...next.mix, ...patch.mix });
  next.revision = doc.revision + 1;
  return parseEditDoc(next).doc;
}

export type DecisionAction = "kept" | "changed" | "deleted" | "accepted" | "rejected";
export interface Decision {
  itemId: string;
  track: PolicyKey;
  stage?: string;
  action: DecisionAction;
  fromRevision: number;
  toRevision: number;
  changedFields?: string[];
  /** Prompt versions of the stage run that made the item, as `id@version`. */
  prompts?: string[];
}

const IGNORED = new Set(["owner", "status", "replaces"]);

/**
 * What happened to each agent item between two revisions. This is the
 * decision log (plan §7): the future eval set and v2 style-learning input.
 */
export function decisionsBetween(before: EditDoc, after: EditDoc): Decision[] {
  const out: Decision[] = [];
  const base = { fromRevision: before.revision, toRevision: after.revision };
  const lists: Array<[PolicyKey, Array<Item | Marker>, Array<Item | Marker>]> = [
    ...TRACK_KINDS.map(k => [k, before.tracks[k] as Item[], after.tracks[k] as Item[]] as [PolicyKey, Item[], Item[]]),
    ["markers", before.markers, after.markers],
  ];
  for (const [track, prev, curr] of lists) {
    const now = new Map(curr.map(x => [x.id, x]));
    for (const item of prev) {
      if (item.owner !== "agent") continue;
      const later = now.get(item.id);
      const prompts = promptsOf(before, item.stage);
      const d = { itemId: item.id, track, stage: item.stage, ...(prompts.length ? { prompts } : {}), ...base };
      if (item.status === "suggested") {
        const target = now.get((item as Item).replaces ?? item.id);
        const acceptedAs = target && target.status === "applied" && same(item, target);
        if (acceptedAs) out.push({ ...d, action: "accepted" });
        else if (!later) out.push({ ...d, action: "rejected" });
        continue;
      }
      if (item.status === "remove-suggested") {
        out.push({ ...d, action: later ? "rejected" : "accepted" });
        continue;
      }
      if (!later) { out.push({ ...d, action: "deleted" }); continue; }
      const fields = diffFields(item, later);
      out.push(fields.length || later.owner === "creator" ? { ...d, action: "changed", changedFields: fields } : { ...d, action: "kept" });
    }
  }
  return out;
}

function promptsOf(doc: EditDoc, stage: string | undefined): string[] {
  const stamp = stage ? [...doc.provenance].reverse().find(p => p.stage === stage) : undefined;
  return stamp ? Object.entries(stamp.prompts).map(([id, p]) => `${id}@${p.version}`).sort() : [];
}

function diffFields(a: object, b: object): string[] {
  const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
  return [...new Set([...Object.keys(ra), ...Object.keys(rb)])]
    .filter(k => !IGNORED.has(k) && k !== "id" && JSON.stringify(ra[k]) !== JSON.stringify(rb[k])).sort();
}
function same(a: object, b: object): boolean {
  return diffFields(a, b).length === 0;
}

export interface CreatorRevision {
  accept?: string[];
  reject?: string[];
  patch?: CreatorPatch;
}

/**
 * One creator save: review answers first (accepting a suggested removal
 * closes the gap), then hand edits. The result is exactly one revision past
 * `doc`, with the decisions it made (unchanged items left out).
 */
export function applyCreatorRevision(doc: EditDoc, change: CreatorRevision): { doc: EditDoc; decisions: Decision[] } {
  let next = doc;
  for (const id of change.accept ?? []) next = acceptSuggestion(next, id);
  for (const id of change.reject ?? []) next = rejectSuggestion(next, id);
  if (change.patch) next = applyCreatorPatch(next, change.patch);
  const decisions = decisionsBetween({ ...doc, revision: doc.revision }, { ...next, revision: doc.revision + 1 }).filter(d => d.action !== "kept");
  const gone = decisions.filter(d => d.action === "deleted" || d.action === "rejected" && !isRemoval(doc, d.itemId) || d.action === "accepted" && isRemoval(doc, d.itemId));
  // Items the creator took off count too when they had made them their own
  // first: the log skips those, but a new cut must not bring them back.
  const kept = new Set(allIds(next));
  const removed = allIds(doc).filter(id => !kept.has(id));
  const declined = [...new Set([...next.declined, ...gone.map(d => d.itemId), ...removed])].slice(-5000);
  // New cuts make fresh ids, so on-screen text is also declined by its words.
  const dropped = new Set([...removed, ...gone.map(d => d.itemId)]);
  const words = doc.tracks.text.filter(t => dropped.has(t.id)).map(t => t.text);
  const declinedText = [...new Set([...next.declinedText, ...words])].slice(-500);
  next = parseEditDoc({ ...next, revision: doc.revision + 1, declined, declinedText }).doc;
  return { doc: next, decisions };
}

/** True when `text` says what one of `declined` says: most of the shorter one's words match. */
export function repeatsDeclined(text: string, declined: readonly string[]): boolean {
  const words = (s: string) => new Set(s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean));
  const a = words(text);
  return declined.some(d => {
    const b = words(d);
    const small = Math.min(a.size, b.size);
    if (small < 2) return a.size === b.size && [...a].every(w => b.has(w));
    return [...a].filter(w => b.has(w)).length / small >= 0.75;
  });
}

function allIds(doc: EditDoc): string[] {
  return [...TRACK_KINDS.flatMap(k => (doc.tracks[k] as Item[]).map(i => i.id)), ...doc.markers.map(m => m.id)];
}

function isRemoval(doc: EditDoc, id: string): boolean {
  return [...TRACK_KINDS.flatMap(k => doc.tracks[k] as Item[]), ...doc.markers].some(x => x.id === id && x.status === "remove-suggested");
}
