// Track policy, enforced in code. A stage returns a patch for the tracks it
// owns; `applyStagePatch` refuses anything the policy or ownership forbids
// and turns changes into suggestions where the policy says so. The model
// never gets the final say on its own limits (plan §1).
import {
  ITEM_SCHEMAS, POLICY_KEYS, TRACK_KINDS, markerSchema, mixSchema, storyBriefSchema,
  type EditDoc, type Item, type ItemOf, type Marker, type MixSettings, type PolicyKey, type StageStamp,
  type StoryBriefInput, type TrackKind, type TrackMode, type TrackPolicy,
} from "./schema";
import { parseEditDoc, type DocIssue } from "./validate";
import { rippleClose } from "./timeline";

export const STAGES = ["structure", "assembly", "zoom", "b-roll", "text", "graphics", "audio", "review"] as const;
export type StageName = (typeof STAGES)[number];

/** Which policy keys each stage may write. Review repairs any track, still under policy. */
export const STAGE_TRACKS: Record<StageName, readonly PolicyKey[]> = {
  structure: ["markers"],
  assembly: ["a-roll", "voiceover"],
  zoom: ["zoom"],
  "b-roll": ["b-roll"],
  text: ["captions", "text"],
  graphics: ["graphics", "text"], // a graphic replaces the agent callouts it covers
  audio: ["music", "sfx"],
  review: POLICY_KEYS,
};

export function defaultPolicy(mode: TrackMode = "auto"): TrackPolicy {
  return Object.fromEntries(POLICY_KEYS.map(k => [k, mode])) as TrackPolicy;
}

export type TrackChange<K extends TrackKind> = { upsert?: ItemOf<K>[]; remove?: string[] };
export interface StagePatch {
  stage: StageName;
  tracks?: { [K in TrackKind]?: TrackChange<K> };
  markers?: { upsert?: Marker[]; remove?: string[] };
  brief?: StoryBriefInput;            // structure only
  mix?: Partial<MixSettings>;         // audio only
  stamp: Omit<StageStamp, "stage" | "revision">;
}

export class PolicyError extends Error {
  constructor(readonly violations: string[]) {
    super(`Stage patch refused: ${violations.join("; ")}`);
  }
}

export interface ApplyResult {
  doc: EditDoc;
  applied: string[];                  // item/marker ids changed as applied
  suggested: string[];                // ids that landed as suggestions
  removed: string[];
  warnings: DocIssue[];
}

type Entry = { id: string; owner: "agent" | "creator"; status: Item["status"]; confidence?: number; replaces?: string };

/** Markers have no `replaces`; strict schemas reject even an undefined key. */
function dropReplaces<T extends { replaces?: string }>(x: T): T {
  const { replaces: _, ...rest } = x;
  return rest as T;
}

/**
 * Apply one stage's output as a new revision. Throws PolicyError (nothing
 * applied) when the patch touches a track that is off, locked or not owned by
 * the stage, or changes a creator item.
 */
export function applyStagePatch(doc: EditDoc, patch: StagePatch): ApplyResult {
  const violations: string[] = [];
  const allowed = new Set(STAGE_TRACKS[patch.stage]);
  const touched: PolicyKey[] = [
    ...(Object.keys(patch.tracks ?? {}) as TrackKind[]),
    ...(patch.markers ? (["markers"] as const) : []),
  ];
  for (const key of touched) {
    if (!(POLICY_KEYS as readonly string[]).includes(key)) { violations.push(`unknown track ${key}`); continue; }
    if (!allowed.has(key)) violations.push(`stage ${patch.stage} does not own ${key}`);
    const mode = doc.policy[key];
    if (mode === "off" || mode === "locked") violations.push(`${key} is ${mode}`);
  }
  if (patch.brief && patch.stage !== "structure" && patch.stage !== "review") violations.push(`stage ${patch.stage} cannot change the brief`);
  if (patch.mix && patch.stage !== "audio" && patch.stage !== "review") violations.push(`stage ${patch.stage} cannot change the mix`);
  if (violations.length) throw new PolicyError(violations);

  const next = structuredClone(doc);
  const revision = doc.revision + 1;
  const threshold = doc.styleRef.snapshot.applyConfidence;
  const result: Omit<ApplyResult, "doc" | "warnings"> = { applied: [], suggested: [], removed: [] };

  function change<T extends Entry>(key: PolicyKey, list: T[], upsert: T[], remove: string[], parse: (x: unknown) => T): T[] {
    const mode = doc.policy[key];
    const byId = new Map(list.map(x => [x.id, x]));
    let out = [...list];
    for (const id of remove) {
      const current = byId.get(id);
      if (!current) { violations.push(`${key}: remove of unknown ${id}`); continue; }
      if (current.owner === "creator") { violations.push(`${key}: ${id} belongs to the creator`); continue; }
      if (mode === "suggest") {
        out = out.map(x => x.id === id ? { ...x, status: "remove-suggested" } : x);
        result.suggested.push(id);
      } else {
        out = out.filter(x => x.id !== id && x.replaces !== id);
        result.removed.push(id);
      }
    }
    for (const raw of upsert) {
      const incoming = parse({ ...raw, stage: (raw as { stage?: string }).stage ?? patch.stage });
      if (incoming.owner !== "agent") { violations.push(`${key}: stage items must be owner "agent" (${incoming.id})`); continue; }
      const current = byId.get(incoming.id);
      if (current?.owner === "creator") { violations.push(`${key}: ${incoming.id} belongs to the creator`); continue; }
      if (incoming.status === "remove-suggested") {
        // Kept and playing, flagged as a likely cut: accepting deletes it.
        out = current ? out.map(x => (x.id === incoming.id ? dropReplaces(incoming) : x)) : [...out, dropReplaces(incoming)];
        result.suggested.push(incoming.id);
        continue;
      }
      const unsure = incoming.confidence !== undefined && incoming.confidence < threshold;
      if (mode === "suggest" || unsure) {
        const suggestion = current && current.status === "applied"
          ? { ...incoming, id: `${incoming.id}~r${revision}`, replaces: incoming.id, status: "suggested" as const }
          : { ...incoming, status: "suggested" as const };
        out = out.filter(x => x.id !== suggestion.id);
        out.push(suggestion);
        result.suggested.push(suggestion.id);
      } else {
        const applied = { ...dropReplaces(incoming), status: "applied" as const };
        out = current ? out.map(x => (x.id === applied.id ? applied : x)) : [...out, applied];
        result.applied.push(applied.id);
      }
    }
    return out;
  }

  for (const kind of TRACK_KINDS) {
    const c = patch.tracks?.[kind] as TrackChange<TrackKind> | undefined;
    if (!c) continue;
    const schema = ITEM_SCHEMAS[kind];
    const updated = change(kind, next.tracks[kind] as Item[], (c.upsert ?? []) as Item[], c.remove ?? [],
      x => schema.parse(x) as Item);
    (next.tracks as Record<TrackKind, Item[]>)[kind] = updated.sort((a, b) => a.start - b.start);
  }
  if (patch.markers) {
    next.markers = change("markers", next.markers, patch.markers.upsert ?? [], patch.markers.remove ?? [],
      x => markerSchema.parse(x)).sort((a, b) => a.time - b.time);
  }
  if (violations.length) throw new PolicyError(violations);
  if (patch.brief) next.brief = storyBriefSchema.parse(patch.brief);
  if (patch.mix) next.mix = mixSchema.parse({ ...next.mix, ...patch.mix });
  next.revision = revision;
  next.provenance = [...next.provenance, { ...patch.stamp, stage: patch.stage, revision }];
  const { doc: parsed, warnings } = parseEditDoc(next);
  return { doc: parsed, ...result, warnings };
}

/**
 * The patch that takes `before` to `target` on the tracks `stage` owns: new or
 * changed items upserted, missing agent items removed. For stages computed
 * as a whole new timeline (v1 bridge, replans) rather than as edits.
 */
export function stagePatchBetween(before: EditDoc, target: EditDoc, stage: StageName, stamp: StagePatch["stamp"]): StagePatch {
  const patch: StagePatch = { stage, stamp };
  const diff = <T extends { id: string; owner: string }>(prev: T[], next: T[]) => {
    const old = new Map(prev.map(x => [x.id, JSON.stringify(x)]));
    const keep = new Set(next.map(x => x.id));
    return {
      upsert: next.filter(x => old.get(x.id) !== JSON.stringify(x)),
      remove: prev.filter(x => !keep.has(x.id) && x.owner === "agent").map(x => x.id),
    };
  };
  for (const key of STAGE_TRACKS[stage]) {
    if (key === "markers") {
      const d = diff(before.markers, target.markers);
      if (d.upsert.length || d.remove.length) patch.markers = d;
      continue;
    }
    const d = diff(before.tracks[key] as Item[], target.tracks[key] as Item[]);
    if (d.upsert.length || d.remove.length) (patch.tracks ??= {})[key] = d as never;
  }
  return patch;
}

/** Creator accepts a suggestion: it becomes applied, replacing what it targeted. */
export function acceptSuggestion(doc: EditDoc, id: string): EditDoc {
  return resolveSuggestion(doc, id, true);
}
/** Creator rejects a suggestion: it is dropped (or a suggested removal is undone). */
export function rejectSuggestion(doc: EditDoc, id: string): EditDoc {
  return resolveSuggestion(doc, id, false);
}

function resolveSuggestion(doc: EditDoc, id: string, accept: boolean): EditDoc {
  const next = structuredClone(doc);
  let found = false;
  let ripple: { start: number; end: number } | undefined;
  const speech = new Set([...doc.tracks["a-roll"], ...doc.tracks.voiceover].map(x => x.id));
  const isSpeech = (x: { id: string }) => speech.has(x.id);
  const apply = <T extends Entry>(list: T[]): T[] => {
    const target = list.find(x => x.id === id);
    if (!target) return list;
    found = true;
    if (target.status === "remove-suggested") {
      if (accept && isSpeech(target)) { const t = target as unknown as Item; ripple = { start: t.start, end: t.end }; }
      return accept ? list.filter(x => x.id !== id) : list.map(x => (x.id === id ? { ...x, status: "applied" } : x));
    }
    if (target.status !== "suggested") throw new Error(`${id} is not a suggestion`);
    if (!accept) return list.filter(x => x.id !== id);
    const originalId = target.replaces;
    const accepted = { ...dropReplaces(target), status: "applied" as const, id: originalId ?? target.id };
    return [...list.filter(x => x.id !== id && x.id !== originalId), accepted];
  };
  for (const kind of TRACK_KINDS)
    (next.tracks as Record<TrackKind, Item[]>)[kind] = apply(next.tracks[kind] as Item[]).sort((a, b) => a.start - b.start);
  next.markers = apply(next.markers).sort((a, b) => a.time - b.time);
  if (!found) throw new Error(`Unknown item ${id}`);
  next.revision = doc.revision + 1;
  // A removed speech item would leave black and silence: close the gap.
  return parseEditDoc(ripple ? rippleClose(next, ripple.start, ripple.end) : next).doc;
}

/**
 * Policy for a replan: tracks where the creator owns at least `share` of the
 * items default to locked, so a replan does not fight the creator's work.
 */
export function replanPolicy(doc: EditDoc, share = 0.5): TrackPolicy {
  const policy = { ...doc.policy };
  for (const kind of TRACK_KINDS) {
    const items = doc.tracks[kind] as Item[];
    const creator = items.filter(i => i.owner === "creator").length;
    if (items.length && creator / items.length >= share && policy[kind] !== "off") policy[kind] = "locked";
  }
  return policy;
}
