// Adapter: export timeline → OpenTimelineIO JSON (generic; Resolve reads it).
// Checked on Resolve Free 21 (spike 4, docs/agentic-video-editor-spike4.md):
// media refs must be plain absolute paths (file:// URLs fail), and sources
// with a start timecode need it in their ranges or Resolve won't link them.
// OTIO carries cuts, tracks, dissolves and markers; boxes, zoom, gain and
// fades travel in `metadata.voxtale` only.
import { fpsValue } from "./time";
import type { EditDoc } from "./schema";
import { buildExportTimeline, titleMarkers, type ExportMedia, type ExportTimeline, type ExportTrack } from "./export-model";

type Json = Record<string, unknown>;
const RT = (value: number, rate: number): Json => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const TR = (start: number, duration: number, rate: number): Json => ({ OTIO_SCHEMA: "TimeRange.1", start_time: RT(start, rate), duration: RT(duration, rate) });
const common = { effects: [], markers: [], enabled: true, metadata: {} };

function track(t: ExportTimeline, tr: ExportTrack): Json {
  const rate = fpsValue(t.fps);
  const src = new Map(t.sources.map(s => [s.id, s]));
  const children: Json[] = [];
  let cursor = 0;
  for (const c of tr.clips) {
    const gap = c.start - cursor;
    if (gap < 0) throw new Error(`Overlap on ${tr.name} at ${c.itemId}`);
    if (gap > 0) children.push({ OTIO_SCHEMA: "Gap.1", name: "", source_range: TR(0, gap, rate), ...common });
    // A transition sits between two touching clips, half its length either side of the cut.
    // OTIO names only the dissolve; the other kinds travel as custom with our kind in metadata.
    if (c.transition && gap === 0 && children.at(-1)?.OTIO_SCHEMA === "Clip.2") {
      const half = Math.round(c.transition.frames / 2);
      children.push({
        OTIO_SCHEMA: "Transition.1", name: c.transition.kind,
        transition_type: c.transition.kind === "crossfade" ? "SMPTE_Dissolve" : "Custom_Transition",
        in_offset: RT(half, rate), out_offset: RT(half, rate), metadata: { voxtale: { kind: c.transition.kind } },
      });
    }
    const s = src.get(c.sourceId)!;
    const mRate = s.fps ? fpsValue(s.fps) : rate;
    const f = (x: number) => Math.round(x * mRate);
    const frames = c.end - c.start;
    const p = c.picture, a = c.sound;
    const meta: Json = {
      itemId: c.itemId, clipId: s.kind === "graphic" ? null : s.id, owner: c.note.owner ?? null, stage: c.note.stage ?? null, reason: c.note.reason ?? null,
      ...(p?.fadeIn ? { fadeIn: p.fadeIn } : {}), ...(p?.fadeOut ? { fadeOut: p.fadeOut } : {}),
      ...(c.note.angle ? { angle: c.note.angle } : {}), ...(c.note.mic ? { mic: c.note.mic } : {}),
      ...(c.layout ? { layout: c.layout } : {}), ...(p?.box ? { box: p.box } : {}), ...(p?.crop ? { crop: p.crop } : {}),
      ...(p && p.fit !== "cover" ? { fit: p.fit } : {}), ...(p && p.opacity < 1 ? { opacity: p.opacity } : {}),
      ...(p?.zoom.length ? { zoom: p.zoom } : {}), ...(c.speed !== 1 ? { speed: c.speed } : {}),
      ...(a && a.gainDb ? { gainDb: a.gainDb } : {}), ...(a?.fadeIn ? { audioFadeIn: a.fadeIn } : {}), ...(a?.fadeOut ? { audioFadeOut: a.fadeOut } : {}),
      ...(a?.duck ? { duck: a.duck } : {}), ...(s.look ? { look: s.look } : {}),
    };
    children.push({
      OTIO_SCHEMA: "Clip.2", name: c.itemId, ...common,
      // A layout layer would cover the whole frame: off until placed by hand.
      enabled: !c.layout, metadata: { voxtale: meta },
      source_range: TR(f(s.timecodeStart + c.in), Math.round((frames / rate) * mRate), mRate),
      active_media_reference_key: "DEFAULT_MEDIA",
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: "ExternalReference.1", name: s.path.split(/[\\/]/).pop(), target_url: s.path,
          available_range: TR(f(s.timecodeStart), f(s.duration), mRate), available_image_bounds: null, metadata: {},
        },
      },
    });
    cursor = c.end;
  }
  return { OTIO_SCHEMA: "Track.1", name: tr.name, kind: tr.kind === "video" ? "Video" : "Audio", children, source_range: null, ...common };
}

/** OTIO from an export timeline. */
export function otioFromTimeline(t: ExportTimeline): Json {
  const rate = fpsValue(t.fps);
  const marker = (name: string, frame: number, color: string, comment = ""): Json =>
    ({ OTIO_SCHEMA: "Marker.2", name, color, comment, metadata: {}, marked_range: TR(frame, 0, rate) });
  const markers = [
    ...t.markers.map(m => marker(m.name, m.frame, m.kind === "chapter" ? "RED" : "BLUE", m.note)),
    // OTIO has no text layers; text items travel as markers the creator can rebuild from.
    ...titleMarkers(t).map(m => marker(m.name, m.frame, "YELLOW", m.note)),
  ];
  return {
    OTIO_SCHEMA: "Timeline.1", name: t.name, global_start_time: RT(0, rate),
    metadata: { voxtale: { editId: t.editId, revision: t.revision } },
    tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", children: [...t.video, ...t.audio].map(tr => track(t, tr)), source_range: null, ...common, markers },
  };
}

/** EditDoc → OTIO (kept for callers; same as the "otio" exporter). */
export function toOtio(doc: EditDoc, media: ExportMedia): Json {
  return otioFromTimeline(buildExportTimeline(doc, media));
}
