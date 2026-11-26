// Resolve hand-off: EditDoc → OpenTimelineIO JSON, plus SRT captions.
// Checked on Resolve Free 21 (spike 4, docs/agentic-video-editor-spike4.md):
// media refs must be plain absolute paths (file:// URLs fail), and sources
// with a start timecode need it in their ranges or Resolve won't link them.
import { fpsValue, toFrame, type Fps } from "./time";
import type { ClipItem, ClipRef, EditDoc, GraphicItem, Item, Transition } from "./schema";
import { soundSpans } from "./timeline";

export interface GraphicMedia {
  path: string;                       // ProRes 4444 .mov (alpha)
  duration: number;
  fps: Fps;
}
export interface OtioMedia {
  /** Absolute local path of a clip on the creator's machine. */
  clipPath(clip: ClipRef): string;
  /** Rendered alpha file for a graphic item; omit to leave graphics out. */
  graphicPath?(item: GraphicItem): GraphicMedia | undefined;
}

type Json = Record<string, unknown>;
const RT = (value: number, rate: number): Json => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const TR = (start: number, duration: number, rate: number): Json => ({ OTIO_SCHEMA: "TimeRange.1", start_time: RT(start, rate), duration: RT(duration, rate) });
const common = { effects: [], markers: [], enabled: true, metadata: {} };
/** OTIO has no picture fade; ours travel in metadata, as the custom transitions do. */
const fadeMeta = (item: object) => {
  const i = item as { fadeIn?: number; fadeOut?: number };
  return { ...(i.fadeIn ? { fadeIn: i.fadeIn } : {}), ...(i.fadeOut ? { fadeOut: i.fadeOut } : {}) };
};

interface Placed { name: string; path: string; rate: number; available: [number, number]; source: [number, number]; start: number; frames: number; meta: Json; transition?: Transition }

function track(name: string, kind: "Video" | "Audio", items: Placed[], rate: number): Json {
  const children: Json[] = [];
  let cursor = 0;
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    const gap = it.start - cursor;
    if (gap < 0) throw new Error(`Overlap on ${name} at ${it.name}`);
    if (gap > 0) children.push({ OTIO_SCHEMA: "Gap.1", name: "", source_range: TR(0, gap, rate), ...common });
    // A transition sits between two touching clips, half its length either side of the cut.
    // OTIO names only the dissolve; the other kinds travel as custom with our kind in metadata.
    const prev = children.at(-1);
    if (it.transition && gap === 0 && prev?.OTIO_SCHEMA === "Clip.2") {
      const half = Math.round((it.transition.duration * rate) / 2);
      children.push({
        OTIO_SCHEMA: "Transition.1", name: it.transition.kind,
        transition_type: it.transition.kind === "crossfade" ? "SMPTE_Dissolve" : "Custom_Transition",
        in_offset: RT(half, rate), out_offset: RT(half, rate), metadata: { voxtale: { kind: it.transition.kind } },
      });
    }
    children.push({
      OTIO_SCHEMA: "Clip.2", name: it.name, ...common, metadata: { voxtale: it.meta },
      source_range: TR(it.source[0], it.source[1], it.rate),
      active_media_reference_key: "DEFAULT_MEDIA",
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: "ExternalReference.1", name: it.path.split(/[\\/]/).pop(), target_url: it.path,
          available_range: TR(it.available[0], it.available[1], it.rate), available_image_bounds: null, metadata: {},
        },
      },
    });
    cursor = it.start + it.frames;
  }
  return { OTIO_SCHEMA: "Track.1", name, kind, children, source_range: null, ...common };
}

const live = <T extends Item>(items: T[]) => items.filter(i => i.status !== "suggested");

export function toOtio(doc: EditDoc, media: OtioMedia): Json {
  const rate = fpsValue(doc.fps);
  const clips = new Map(doc.clips.map(c => [c.id, c]));
  const place = (item: ClipItem): Placed => {
    const clip = clips.get(item.clipId);
    if (!clip) throw new Error(`Unknown clip ${item.clipId}`);
    const path = media.clipPath(clip);
    if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) throw new Error(`Clip path must be absolute: ${path}`);
    const mRate = clip.fps ? fpsValue(clip.fps) : rate;
    const f = (s: number) => Math.round(s * mRate);
    const tc = clip.timecodeStart;
    return {
      name: item.id, path, rate: mRate,
      available: [f(tc), f(clip.duration)],
      source: [f(tc + item.in), f(item.out - item.in)],
      start: toFrame(item.start, doc.fps), frames: toFrame(item.end, doc.fps) - toFrame(item.start, doc.fps),
      meta: { itemId: item.id, clipId: item.clipId, owner: item.owner, stage: item.stage ?? null, reason: item.reason ?? null, ...fadeMeta(item) },
      ...("transition" in item && item.transition ? { transition: item.transition } : {}),
    };
  };
  const graphics: Placed[] = [];
  for (const g of live(doc.tracks.graphics)) {
    const m = media.graphicPath?.(g);
    if (!m) continue;
    const gr = fpsValue(m.fps), len = (g.end - g.start);
    graphics.push({
      name: g.id, path: m.path, rate: gr, available: [0, Math.round(m.duration * gr)], source: [0, Math.round(Math.min(len, m.duration) * gr)],
      start: toFrame(g.start, doc.fps), frames: toFrame(g.end, doc.fps) - toFrame(g.start, doc.fps),
      meta: { itemId: g.id, assetId: g.assetId, assetRevision: g.assetRevision, ...fadeMeta(g) },
    });
  }
  const arollItems = live(doc.tracks["a-roll"]), aroll = arollItems.map(place);
  // -60 dB is the floor: a muted item (a shot placed without its sound) has no audio clip.
  const heard = new Set(arollItems.filter(i => i.gainDb > -60 && clips.get(i.clipId)?.hasAudio === true).map(i => i.id));
  // J/L cuts: each piece's sound where it is heard, picture cuts unchanged.
  const arollSound = soundSpans(arollItems, doc.fps).map(({ item, start, end, in: inn }): Placed => {
    const { transition: _, ...p } = place({ ...item, start, end, in: inn, out: inn + (end - start) });
    return p;
  });
  const video = [
    track("A-roll", "Video", aroll, rate),
    track("B-roll", "Video", live(doc.tracks["b-roll"]).map(place), rate),
    track("Graphics", "Video", graphics, rate),
  ];
  const audio = [
    // Sound cuts straight at a picture transition, as the render plays it.
    track("A-roll audio", "Audio", arollSound.filter(p => heard.has(p.meta.itemId as string)), rate),
    track("Voiceover", "Audio", live(doc.tracks.voiceover).map(place), rate),
    track("Music", "Audio", live(doc.tracks.music).map(place), rate),
    track("SFX", "Audio", live(doc.tracks.sfx).map(place), rate),
    track("B-roll audio", "Audio", live(doc.tracks["b-roll"]).filter(b => !b.muted).map(place), rate),
  ].filter(t => (t.children as Json[]).length > 0);

  const marker = (name: string, at: number, color: string, comment = ""): Json =>
    ({ OTIO_SCHEMA: "Marker.2", name, color, comment, metadata: {}, marked_range: TR(toFrame(at, doc.fps), 0, rate) });
  const markers = [
    ...doc.markers.filter(m => m.status === "applied").map(m => marker(m.title, m.time, m.kind === "chapter" ? "RED" : "BLUE")),
    // OTIO has no text layers; text items travel as markers the creator can rebuild from.
    ...live(doc.tracks.text).map(t => marker(t.text, t.start, "YELLOW", `${t.template}${t.subtext ? `: ${t.subtext}` : ""} (${(t.end - t.start).toFixed(2)}s)`)),
  ];
  return {
    OTIO_SCHEMA: "Timeline.1", name: doc.name, global_start_time: RT(0, rate),
    metadata: { voxtale: { editId: doc.id, revision: doc.revision } },
    tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", children: [...video, ...audio], source_range: null, ...common, markers },
  };
}

function srtStamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** Applied captions as SRT, in output time. */
export function toSrt(doc: EditDoc): string {
  return live(doc.tracks.captions).sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${srtStamp(c.start)} --> ${srtStamp(c.end)}\n${c.text}\n`).join("\n");
}
