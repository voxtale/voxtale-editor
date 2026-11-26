// Checks zod cannot express: references, frame snapping, overlaps, ranges.
// Errors make a document invalid; warnings go to the review list.
import { editDocSchema, upgradeEditDoc, OVERLAP_TRANSITIONS, TRACK_KINDS, type ARollItem, type BRollItem, type EditDoc, type EditDocInput, type Item, type TrackKind, type ZoomItem } from "./schema";
import { fpsValue, toFrame, frameToSeconds } from "./time";
import { groupIssues, groupOf } from "./sync";
import { WORD_FIX_REACH, captionReadingSpeed, isClipTrack, soundSpans, transitionJoins } from "./timeline";

export interface DocIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

/** Tracks whose items may not overlap each other. */
const SINGLE_LAYER: readonly TrackKind[] = ["a-roll", "b-roll", "captions", "voiceover", "zoom"];

export function checkEditDoc(doc: EditDoc): DocIssue[] {
  const issues: DocIssue[] = [];
  const err = (path: string, message: string) => issues.push({ severity: "error", path, message });
  const warn = (path: string, message: string) => issues.push({ severity: "warning", path, message });
  const fps = doc.fps;
  const onFrame = (t: number) => Math.abs(frameToSeconds(toFrame(t, fps), fps) - t) < 1e-6;
  const halfFrame = 0.5 / fpsValue(fps);

  const clips = new Map<string, EditDoc["clips"][number]>();
  doc.clips.forEach((c, i) => {
    if (clips.has(c.id)) err(`clips.${i}.id`, `Duplicate clip id ${c.id}`);
    clips.set(c.id, c);
  });

  const ids = new Set<string>();
  for (const kind of TRACK_KINDS) {
    const items = doc.tracks[kind] as Item[];
    items.forEach((item, i) => {
      const at = `tracks.${kind}.${i}`;
      if (ids.has(item.id)) err(`${at}.id`, `Duplicate item id ${item.id}`);
      ids.add(item.id);
      if (!onFrame(item.start) || !onFrame(item.end)) err(at, "Item times must sit on frame boundaries");
      if (toFrame(item.end, fps) <= toFrame(item.start, fps)) err(at, "Item must last at least one frame");
      if (isClipTrack(kind)) {
        const c = item as Item & { clipId: string; in: number; out: number };
        const clip = clips.get(c.clipId);
        if (!clip) err(`${at}.clipId`, `Unknown clip ${c.clipId}`);
        if (c.out <= c.in) err(at, "Source out must follow in");
        if (clip && c.out > clip.duration + halfFrame) err(at, `Source range ends after the clip (${clip.duration}s)`);
        const speed = kind === "b-roll" ? (item as BRollItem).speed ?? 1 : 1;
        if (Math.abs((c.out - c.in) - (item.end - item.start) * speed) > halfFrame * 2 * speed)
          err(at, speed === 1 ? "Output length must equal source length" : "Source length must equal output length x speed");
        if (clip && clip.kind === "audio" && (kind === "a-roll" || kind === "b-roll")) err(`${at}.clipId`, "Audio clip on a video track");
      }
      if (kind === "b-roll") {
        const b = item as BRollItem, speed = b.speed ?? 1;
        if (speed !== 1 && !b.muted) err(`${at}.speed`, "Sped-up footage must be muted");
        if (b.crop && (b.crop.x + b.crop.w > 1 + 1e-6 || b.crop.y + b.crop.h > 1 + 1e-6)) err(`${at}.crop`, "Crop reaches outside the frame");
        for (const [k, a] of ((item as BRollItem).alternatives ?? []).entries()) {
          const alt = clips.get(a.clipId);
          if (!alt || alt.kind === "audio") err(`${at}.alternatives.${k}`, `Unknown or audio clip ${a.clipId}`);
          else if (a.out <= a.in || a.out > alt.duration + halfFrame) err(`${at}.alternatives.${k}`, "Source range outside the clip");
          if (Math.abs((a.out - a.in) - (item.end - item.start) * speed) > halfFrame * 2 * speed) err(`${at}.alternatives.${k}`, "Alternative must match the item length");
        }
      }
      if (kind === "zoom") {
        const z = item as ZoomItem;
        if (z.easeIn + z.easeOut > z.end - z.start + halfFrame) err(at, "Zoom eases in and out for longer than it lasts");
      }
      if (kind === "captions") {
        const cap = item as Extract<Item, { words: string[] }>;
        for (const w of cap.words) if (!clips.has(w.split(":")[0]!)) err(`${at}.words`, `Caption word from unknown clip: ${w}`);
        if (captionReadingSpeed(cap) > doc.styleRef.snapshot.brand.captionStyle.maxWordsPerSecond)
          warn(at, "Caption faster than the reading-speed limit");
      }
    });
    if (SINGLE_LAYER.includes(kind)) {
      const sorted = items.filter(i => i.status !== "suggested").sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++)
        if (toFrame(sorted[i]!.start, fps) < toFrame(sorted[i - 1]!.end, fps))
          err(`tracks.${kind}`, `Items ${sorted[i - 1]!.id} and ${sorted[i]!.id} overlap`);
    }
  }

  // Picture fades fit inside their item.
  for (const kind of ["a-roll", "b-roll", "text", "graphics"] as const) {
    (doc.tracks[kind] as { start: number; end: number; fadeIn?: number; fadeOut?: number }[]).forEach((item, i) => {
      const f = (item.fadeIn ?? 0) + (item.fadeOut ?? 0);
      if (f > item.end - item.start + halfFrame) err(`tracks.${kind}.${i}`, `fadeIn + fadeOut (${f.toFixed(2)}s) is longer than the item (${(item.end - item.start).toFixed(2)}s)`);
    });
  }

  // Variants: each one differs from the version shown and from the others.
  doc.tracks.text.forEach((t, i) => {
    const key = (v: { template?: string; text: string; subtext?: string }) => `${v.template ?? t.template}|${v.text}|${v.subtext ?? ""}`;
    const seen = new Set([key(t)]);
    (t.variants ?? []).forEach((v, k) => { if (seen.has(key(v))) warn(`tracks.text.${i}.variants.${k}`, "Same as another version of this text"); seen.add(key(v)); });
  });
  doc.tracks.graphics.forEach((g, i) => {
    const seen = new Set([`${g.assetId}@${g.assetRevision}`]);
    (g.variants ?? []).forEach((v, k) => { const s = `${v.assetId}@${v.assetRevision}`; if (seen.has(s)) warn(`tracks.graphics.${i}.variants.${k}`, "Same graphic as another version"); seen.add(s); });
  });

  // Word fixes: a known clip, one fix per word.
  (doc.wordFixes ?? []).forEach((f, i) => {
    const clip = clips.get(f.clipId);
    if (!clip) err(`wordFixes.${i}`, `Unknown clip ${f.clipId}`);
    else if (f.at > clip.duration + halfFrame) warn(`wordFixes.${i}`, `${f.at.toFixed(2)}s is past the end of ${f.clipId}`);
    if ((doc.wordFixes ?? []).some((g, j) => j < i && g.clipId === f.clipId && Math.abs(g.at - f.at) < WORD_FIX_REACH))
      err(`wordFixes.${i}`, `Two fixes for the word at ${f.clipId} ${f.at.toFixed(2)}s`);
  });

  // Transitions: an even number of frames (the middle lands on the join), no longer than
  // either piece, and source past the join on both sides when both pieces show at once.
  for (const kind of ["a-roll", "b-roll"] as const) {
    const items = doc.tracks[kind] as (ARollItem | BRollItem)[];
    const joined = new Set(transitionJoins(items, fps).map(j => j.to.id));
    items.forEach((item, i) => {
      const tr = item.transition;
      if (!tr || item.status === "suggested") return;
      const at = `tracks.${kind}.${i}.transition`;
      const frames = tr.duration * fpsValue(fps);
      if (Math.abs(frames - Math.round(frames)) > 1e-6 || Math.round(frames) % 2) err(at, "Transition must last an even number of frames");
      const prev = items.filter(p => p.status !== "suggested" && p.end <= item.start + halfFrame && p.id !== item.id).sort((a, b) => b.end - a.end)[0];
      if (!joined.has(item.id) || !prev) { warn(at, `No piece ends where ${item.id} starts; plays as a hard cut`); return; }
      const half = tr.duration / 2;
      if (half > item.end - item.start + halfFrame || half > prev.end - prev.start + halfFrame) err(at, "Transition is longer than a piece it joins");
      if (!OVERLAP_TRANSITIONS.includes(tr.kind)) return;
      const speedOf = (p: ARollItem | BRollItem) => ("speed" in p && p.speed) || 1;
      const prevClip = clips.get(prev.clipId);
      if (item.in - half * speedOf(item) < -halfFrame) err(at, `${tr.kind} needs ${half.toFixed(2)}s of ${item.clipId} before ${item.id}; it has ${item.in.toFixed(2)}s`);
      if (prevClip && prevClip.kind === "video" && prev.out + half * speedOf(prev) > prevClip.duration + halfFrame)
        err(at, `${tr.kind} needs ${half.toFixed(2)}s of ${prev.clipId} after ${prev.id}; it has ${(prevClip.duration - prev.out).toFixed(2)}s`);
    });
  }

  // J/L cuts: whole frames, one per join, source enough for the moved sound,
  // and the neighbour keeps some of its own sound.
  {
    const live = doc.tracks["a-roll"].filter(i => i.status !== "suggested").sort((a, b) => a.start - b.start);
    const spans = new Map(soundSpans(live, fps).map(s => [s.item.id, s]));
    live.forEach((item, i) => {
      const at = `tracks.a-roll.${doc.tracks["a-roll"].indexOf(item)}`;
      for (const key of ["audioLead", "audioLag"] as const) {
        const v = item[key];
        if (v === undefined) continue;
        const frames = v * fpsValue(fps);
        if (Math.abs(frames - Math.round(frames)) > 1e-6) err(`${at}.${key}`, `${key} must be a whole number of frames`);
        const other = key === "audioLead" ? live[i - 1] : live[i + 1];
        if (!other || toFrame(key === "audioLead" ? other.end : other.start, fps) !== toFrame(key === "audioLead" ? item.start : item.end, fps)) {
          warn(`${at}.${key}`, `No piece touches ${item.id} on that side; ${key} does nothing`);
          continue;
        }
        if (key === "audioLead" && other.audioLag) err(`${at}.${key}`, `${other.id} has audioLag into the same join: use one`);
        if (v >= other.end - other.start - halfFrame) err(`${at}.${key}`, `${key} is as long as ${other.id}, which would have no sound left`);
      }
      const span = spans.get(item.id)!, clip = clips.get(item.clipId);
      if (span.in < -halfFrame) err(`${at}.audioLead`, `J-cut needs ${(item.in - span.in).toFixed(2)}s of ${item.clipId} before ${item.id}; it has ${item.in.toFixed(2)}s`);
      if (clip && span.in + (span.end - span.start) > clip.duration + halfFrame)
        err(`${at}.audioLag`, `L-cut needs ${(span.end - item.end).toFixed(2)}s of ${item.clipId} after ${item.id}; it has ${(clip.duration - item.out).toFixed(2)}s`);
    });
  }

  for (const s of doc.tracks.sfx) if (s.tiedTo && !ids.has(s.tiedTo)) warn(`tracks.sfx.${s.id}`, `Tied to missing item ${s.tiedTo}`);

  // A-roll gaps show as black; allowed, but surfaced.
  const aroll = doc.tracks["a-roll"].filter(i => i.status !== "suggested").sort((a, b) => a.start - b.start);
  if (aroll.length && toFrame(aroll[0]!.start, fps) > 0) warn("tracks.a-roll", "A-roll starts after 0:00");
  for (let i = 1; i < aroll.length; i++)
    if (toFrame(aroll[i]!.start, fps) > toFrame(aroll[i - 1]!.end, fps)) warn("tracks.a-roll", `Gap before ${aroll[i]!.id}`);

  // Sync groups: members exist, one group per clip; a piece's angle, mic and
  // companions must share its clip's group, and a mic clip must have sound.
  for (const g of groupIssues(doc)) err(g.path, g.message);
  doc.logos.forEach((l, i) => {
    const at = `logos.${i}`, clip = clips.get(l.clipId);
    if (ids.has(l.id)) err(`${at}.id`, `Duplicate item id ${l.id}`);
    ids.add(l.id);
    if (!clip || clip.kind !== "image") err(`${at}.clipId`, `Logo needs an image clip, not ${clip ? clip.kind : `unknown ${l.clipId}`}`);
    if (l.x + l.w > 1 + 1e-6) err(`${at}.w`, "Logo reaches past the right edge");
  });
  doc.tracks["a-roll"].forEach((item, i) => {
    const at = `tracks.a-roll.${i}`, g = groupOf(doc.groups, item.clipId);
    const same = (id: string) => !!g && g.members.some(m => m.clipId === id);
    for (const key of ["angle", "mic"] as const) {
      const id = item[key];
      if (!id || id === item.clipId) continue;
      if (!clips.has(id)) err(`${at}.${key}`, `Unknown clip ${id}`);
      else if (!same(id)) err(`${at}.${key}`, `${id} is not in a sync group with ${item.clipId}`);
    }
    if (item.mic && clips.get(item.mic) && !clips.get(item.mic)!.hasAudio) warn(`${at}.mic`, `${item.mic} may have no sound`);
    if ((item.layout === "split" || item.layout === "pip") && !item.companions?.length) warn(`${at}.layout`, `${item.layout} layout needs a companion clip`);
    if (item.layout === "stack" && !item.stack) err(`${at}.stack`, "stack layout needs its two regions");
    if (item.stack && item.layout !== "stack") warn(`${at}.stack`, "stack regions are ignored unless layout is stack");
  });

  const markerIds = new Set<string>();
  doc.markers.forEach((m, i) => {
    if (markerIds.has(m.id) || ids.has(m.id)) err(`markers.${i}.id`, `Duplicate id ${m.id}`);
    markerIds.add(m.id);
    if (!onFrame(m.time)) err(`markers.${i}`, "Marker must sit on a frame boundary");
  });
  const chapters = doc.markers.filter(m => m.kind === "chapter" && m.status === "applied").sort((a, b) => a.time - b.time);
  if (chapters.length) {
    if (toFrame(chapters[0]!.time, fps) !== 0) warn("markers", "First chapter must start at 0:00 for YouTube");
    if (chapters.length < 3) warn("markers", "YouTube needs at least 3 chapters");
    for (let i = 1; i < chapters.length; i++)
      if (chapters[i]!.time - chapters[i - 1]!.time < 10) warn("markers", `Chapter "${chapters[i - 1]!.title}" is under 10 s`);
  }
  return issues;
}

export class EditDocError extends Error {
  constructor(readonly issues: DocIssue[]) {
    super(`Invalid EditDoc: ${issues.filter(i => i.severity === "error").map(i => `${i.path}: ${i.message}`).join("; ")}`);
  }
}

/** Schema parse (older versions upgraded first) + semantic checks. Throws on errors; returns warnings. */
export function parseEditDoc(input: EditDocInput | unknown): { doc: EditDoc; warnings: DocIssue[] } {
  const doc = editDocSchema.parse(upgradeEditDoc(input));
  const issues = checkEditDoc(doc);
  if (issues.some(i => i.severity === "error")) throw new EditDocError(issues);
  return { doc, warnings: issues.filter(i => i.severity === "warning") };
}
