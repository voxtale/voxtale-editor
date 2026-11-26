// Export domain: one timeline other editors can rebuild, built once from the
// EditDoc. Every edit rule (angle and mic picks through sync groups, avOffset,
// J/L cuts, split / pip layouts, speed, transitions, fades, ducking, graphics,
// titles, markers, look notes) is applied here; adapters (export-port.ts)
// only translate this model into an app's file. Pure: no I/O.
import { cutFade, duckPoints, mixSpeech, pipBox, shown, splitBoxes, stackBoxes, coverRegion, zoomKeysBetween, lanes, type ZoomKey } from "./render";
import { companionSources, pictureSource, speechSounds } from "./sync";
import { transitionJoins } from "./timeline";
import { toFrame, type Fps } from "./time";
import type { ClipRef, EditDoc, GraphicItem, TransitionKind } from "./schema";

// ---- media paths ---------------------------------------------------------------

export interface GraphicMedia {
  path: string;                       // rendered overlay with alpha (WebM or ProRes 4444 .mov)
  duration: number;
  fps: Fps;
}
/** Where the files are on the creator's machine. */
export interface ExportMedia {
  /** Absolute local path of a clip. */
  clipPath(clip: ClipRef): string;
  /** Rendered file for a graphic item; omit (or return undefined) to leave it out. */
  graphicPath?(item: GraphicItem): GraphicMedia | undefined;
}
/** Old name, kept for callers. */
export type OtioMedia = ExportMedia;

export function assertAbsolute(path: string): string {
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) throw new Error(`Clip path must be absolute: ${path}`);
  return path;
}

// ---- model --------------------------------------------------------------------

/** What an edit asks of the target app. An adapter lists the ones it carries; the rest are reported. */
export const EXPORT_FEATURES = [
  "layout",          // split / pip boxes, the speaker's corner over b-roll
  "zoom",            // a-roll zoom track as scale/position keys
  "crop",            // b-roll region of the source
  "fit",             // b-roll "contain" (letterboxed) instead of cover
  "opacity",
  "picture-fade",
  "speed",
  "dissolve",        // crossfade transitions
  "transition-other",// whip, dip, zoom transitions
  "gain",
  "audio-fade",
  "duck",            // music ducked under speech
  "titles",          // text items (lower thirds, callouts, cards)
  "graphics",        // rendered overlays
  "markers",
  "look",            // colour grade, log conversion, input LUT
  "behind-subject",  // graphic drawn behind the speaker (needs a person mask)
  "loudness",        // mix loudness target, speech cleanup
  "caption-look",    // styled captions; the text goes out as SRT
] as const;
export type ExportFeature = (typeof EXPORT_FEATURES)[number];

export interface Rect { x: number; y: number; width: number; height: number }

export interface ExportSource {
  id: string;                         // clip id, or "gfx:<item id>" for a rendered graphic
  name: string;
  path: string;
  kind: "video" | "audio" | "image" | "graphic";
  /** Own rate; undefined for stills and sound-only files (adapters use the sequence rate). */
  fps?: Fps;
  duration: number;                   // seconds
  timecodeStart: number;              // seconds
  width: number;                      // canvas size when the file did not say
  height: number;
  hasAudio: boolean;
  /** Colour work the render does that no adapter carries; for the report and clip notes. */
  look?: string;
}

export interface ExportPicture {
  /** Where the picture sits, canvas px; undefined = the whole canvas. */
  box?: Rect;
  fit: "cover" | "contain";
  /** Part of the source shown, as fractions of it. */
  crop?: { x: number; y: number; w: number; h: number };
  /** Zoom keys from the clip's start (render.zoomKeysBetween): scale about the centre, shift in canvas px. */
  zoom: ZoomKey[];
  opacity: number;
  fadeIn?: number;                    // seconds
  fadeOut?: number;
}
export interface ExportSound {
  gainDb: number;
  fadeIn: number;                     // seconds
  fadeOut: number;
  /** Ducking under speech: dB added to `gainDb` at seconds from the clip's start; linear between. */
  duck?: { time: number; db: number }[];
}

export interface ExportClip {
  id: string;                         // unique in the timeline
  itemId: string;                     // the EditDoc item it comes from
  sourceId: string;
  /** Sequence frames at the timeline rate, [start, end). */
  start: number;
  end: number;
  /** Source seconds from the file's first frame (not timecode); out - in = length x speed. */
  in: number;
  out: number;
  speed: number;
  picture?: ExportPicture;
  sound?: ExportSound;
  /** Into this clip from the one before on its track; centred on the cut. */
  transition?: { kind: TransitionKind; frames: number };
  /** Off: a layer an adapter cannot place (it would cover the picture below). Adapters that carry "layout" ignore it. */
  layout?: "split" | "pip" | "speaker-pip" | "stack";
  note: { owner?: string; stage?: string; reason?: string; angle?: string; mic?: string };
}

export type TrackRole = "a-roll" | "layout" | "b-roll" | "speaker-pip" | "graphics" | "speech" | "b-roll-audio" | "voiceover" | "music" | "sfx";
export interface ExportTrack { name: string; kind: "video" | "audio"; role: TrackRole; clips: ExportClip[] }

export interface ExportMarker { frame: number; kind: "chapter" | "note"; name: string; note?: string }
export interface ExportTitle { itemId: string; start: number; end: number; template: string; text: string; subtext?: string; position: string }
export interface ExportWarning { itemId: string; note: string }

export interface ExportTimeline {
  name: string;
  editId: string;
  revision: number;
  fps: Fps;
  canvas: { width: number; height: number };
  /** Frames. */
  duration: number;
  sources: ExportSource[];
  /** Bottom first. */
  video: ExportTrack[];
  audio: ExportTrack[];
  markers: ExportMarker[];
  titles: ExportTitle[];
  /** Output seconds; adapters write them as SRT next to the timeline. */
  captions: { start: number; end: number; text: string }[];
  /** Item ids per feature the edit uses. */
  uses: Partial<Record<ExportFeature, string[]>>;
  /** Things the edit asked for that the render itself fell back on (an angle that does not cover a piece). */
  warnings: ExportWarning[];
}

// ---- geometry -------------------------------------------------------------------

/**
 * Where the whole source frame lands on the canvas (`rect`, px, may run past
 * the canvas) and the part of the canvas it shows through (`view`), for a
 * picture at zoom 1. Adapters turn these into their own scale, position and
 * crop units.
 */
export function placePicture(src: { width: number; height: number }, canvas: { width: number; height: number }, p: Pick<ExportPicture, "box" | "fit" | "crop">): { rect: Rect; view: Rect } {
  const box = p.box ?? { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const c = p.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const rw = c.w * src.width, rh = c.h * src.height;
  const k = p.fit === "cover" ? Math.max(box.width / rw, box.height / rh) : Math.min(box.width / rw, box.height / rh);
  const region = { x: box.x + (box.width - rw * k) / 2, y: box.y + (box.height - rh * k) / 2, width: rw * k, height: rh * k };
  const rect = { x: region.x - c.x * src.width * k, y: region.y - c.y * src.height * k, width: src.width * k, height: src.height * k };
  const x0 = Math.max(box.x, region.x), y0 = Math.max(box.y, region.y);
  const x1 = Math.min(box.x + box.width, region.x + region.width), y1 = Math.min(box.y + box.height, region.y + region.height);
  return { rect, view: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

/** `rect` zoomed `scale`× about the canvas centre, then shifted (dx, dy) px: the a-roll zoom. */
export function zoomRect(rect: Rect, canvas: { width: number; height: number }, scale: number, dx: number, dy: number): Rect {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  return { x: cx + (rect.x - cx) * scale + dx, y: cy + (rect.y - cy) * scale + dy, width: rect.width * scale, height: rect.height * scale };
}

// ---- build ------------------------------------------------------------------------

const lookOf = (c: ClipRef): string | undefined => {
  const parts = [
    c.grade ? "colour grade" : "",
    c.colorSpace && c.colorSpace !== "Rec.709" ? `colour space ${c.colorSpace}` : !c.colorSpace && c.color?.log ? `log ${c.color.log}` : !c.colorSpace && c.color?.hdr ? `HDR ${c.color.hdr.toUpperCase()}` : "",
    c.inputLut ? `input LUT ${c.inputLut}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
};

/** The edit as an export timeline: what plays, from which file, where and how. Throws on a relative clip path. */
export function buildExportTimeline(doc: EditDoc, media: ExportMedia): ExportTimeline {
  const fps = doc.fps;
  const F = (s: number) => toFrame(s, fps);
  const clips = new Map(doc.clips.map(c => [c.id, c]));
  const sources = new Map<string, ExportSource>();
  const uses: Partial<Record<ExportFeature, Set<string>>> = {};
  const use = (f: ExportFeature, id: string) => (uses[f] ??= new Set()).add(id);
  const warnings: ExportWarning[] = [];

  const source = (clipId: string): ExportSource => {
    const have = sources.get(clipId);
    if (have) return have;
    const c = clips.get(clipId);
    if (!c) throw new Error(`Unknown clip ${clipId}`);
    const look = lookOf(c);
    const s: ExportSource = {
      id: c.id, name: c.name, path: assertAbsolute(media.clipPath(c)), kind: c.kind,
      ...(c.fps && c.kind === "video" ? { fps: c.fps } : {}),
      duration: c.duration, timecodeStart: c.timecodeStart,
      width: c.width ?? doc.canvas.width, height: c.height ?? doc.canvas.height,
      hasAudio: c.hasAudio && c.kind !== "image", ...(look ? { look } : {}),
    };
    sources.set(clipId, s);
    return s;
  };
  const note = (i: { owner?: string; stage?: string; reason?: string }) =>
    ({ owner: i.owner, ...(i.stage ? { stage: i.stage } : {}), ...(i.reason ? { reason: i.reason } : {}) });
  const fades = (id: string, i: { fadeIn?: number; fadeOut?: number }) => {
    if (i.fadeIn || i.fadeOut) use("picture-fade", id);
    return { ...(i.fadeIn ? { fadeIn: i.fadeIn } : {}), ...(i.fadeOut ? { fadeOut: i.fadeOut } : {}) };
  };
  const noteLook = (s: ExportSource, itemId: string) => { if (s.look) use("look", itemId); };

  /** Items spread over lanes (render.lanes), as tracks bottom first: lane 0 draws on top. */
  const laned = <T extends { start: number; end: number }>(items: T[], name: string, kind: "video" | "audio", role: TrackRole, make: (item: T) => ExportClip[], keepEmpty = false): ExportTrack[] => {
    const l = lanes(items), n = items.length ? Math.max(...l) + 1 : 0;
    const tracks: ExportTrack[] = Array.from({ length: n }, (_, k) => ({ name: n > 1 ? `${name} ${n - k}` : name, kind, role, clips: [] }));
    items.forEach((item, i) => tracks[n - 1 - l[i]!]!.clips.push(...make(item)));
    for (const t of tracks) t.clips.sort((a, b) => a.start - b.start);
    if (kind === "audio" && n > 1) tracks.reverse();  // audio: first lane on top of the list
    return tracks.length || !keepEmpty ? tracks : [{ name, kind, role, clips: [] }];
  };

  // Transitions ride on the piece they lead into (render.applyTransitions reads the same joins).
  const joins = new Map<string, TransitionKind>();
  const trans = (id: string, t: { kind: TransitionKind; duration: number }) => {
    use(t.kind === "crossfade" ? "dissolve" : "transition-other", id);
    return { kind: t.kind, frames: Math.max(2, Math.round(t.duration * fps.num / fps.den)) };
  };
  for (const kind of ["a-roll", "b-roll"] as const)
    for (const j of transitionJoins<any>(shown(doc.tracks[kind] as any[]), fps)) joins.set(j.to.id, j.transition.kind);

  // ---- a-roll: angle picks, split / pip layouts, zoom
  const aItems = shown(doc.tracks["a-roll"]);
  const layoutClips: ExportClip[] = [];
  const video: ExportTrack[] = [];
  video.push(...laned(aItems, "A-roll", "video", "a-roll", a => {
    const src = pictureSource(doc, a);
    if (src.fellBack) warnings.push({ itemId: a.id, note: `angle ${a.angle} does not cover this piece: plays ${a.clipId}` });
    const s = source(src.clipId);
    noteLook(s, a.id);
    const two = companionSources(doc, a, src.clipId);
    const asked = a.layout === "split" || a.layout === "pip";
    if (asked && !two.length) warnings.push({ itemId: a.id, note: `${a.layout} has no companion covering this piece: shown alone` });
    const split = a.layout === "split" && two.length > 0, pip = a.layout === "pip" && two.length > 0;
    const stack = a.layout === "stack" && a.stack ? a.stack : null;
    const halves = split ? splitBoxes(doc.canvas) : stack ? stackBoxes(doc.canvas, stack.split) : null;
    const zoom = split || stack ? [] : zoomKeysBetween(doc.tracks.zoom, a.start, a.end, doc.canvas);
    if (zoom.length) use("zoom", a.id);
    const len = a.out - a.in;
    const main: ExportClip = {
      id: a.id, itemId: a.id, sourceId: s.id, start: F(a.start), end: F(a.end), in: src.in, out: src.in + len, speed: 1,
      picture: { ...(halves ? { box: halves[0] } : {}), ...(stack ? { crop: coverRegion(s, stack.top, halves![0]) } : {}), fit: "cover", zoom, opacity: 1, ...fades(a.id, a) },
      ...(a.transition && joins.has(a.id) ? { transition: trans(a.id, a.transition) } : {}),
      ...(split ? { layout: "split" as const } : stack ? { layout: "stack" as const } : {}),
      note: { ...note(a), ...(a.angle && !src.fellBack ? { angle: a.angle } : {}), ...(a.mic ? { mic: a.mic } : {}) },
    };
    if (stack) {
      use("layout", a.id);
      layoutClips.push({
        id: `${a.id}.stack`, itemId: a.id, sourceId: s.id, start: main.start, end: main.end, in: src.in, out: src.in + len, speed: 1,
        picture: { box: halves![1], crop: coverRegion(s, stack.bottom, halves![1]), fit: "cover", zoom: [], opacity: 1 },
        layout: "stack", note: note(a),
      });
    } else if (split || pip) {
      use("layout", a.id);
      const m = two[0]!, ms = source(m.clipId);
      noteLook(ms, a.id);
      layoutClips.push({
        id: `${a.id}.${split ? "split" : "pip"}`, itemId: a.id, sourceId: ms.id, start: main.start, end: main.end, in: m.in, out: m.in + len, speed: 1,
        picture: { box: split ? halves![1] : pipBox(doc.canvas, a.pipCorner ?? "bottom-right"), fit: "cover", zoom: [], opacity: 1 },
        layout: split ? "split" : "pip", note: note(a),
      });
    }
    return [main];
  }, true));
  if (layoutClips.length) video.push({ name: "A-roll layout", kind: "video", role: "layout", clips: layoutClips.sort((a, b) => a.start - b.start) });

  // ---- b-roll: fit, crop, opacity, speed, fades, transitions; the speaker's corner over it
  const bItems = shown(doc.tracks["b-roll"]);
  video.push(...laned(bItems, "B-roll", "video", "b-roll", b => {
    const s = source(b.clipId);
    noteLook(s, b.id);
    const speed = b.speed && b.speed !== 1 ? b.speed : 1;
    if (speed !== 1) use("speed", b.id);
    if (b.crop) use("crop", b.id);
    if (b.fit === "contain") use("fit", b.id);
    if (b.opacity < 1) use("opacity", b.id);
    return [{
      id: b.id, itemId: b.id, sourceId: s.id, start: F(b.start), end: F(b.end), in: b.in, out: b.in + (b.end - b.start) * speed, speed,
      picture: { fit: b.fit, ...(b.crop ? { crop: b.crop } : {}), zoom: [], opacity: b.opacity, ...fades(b.id, b) },
      ...(b.transition && joins.has(b.id) ? { transition: trans(b.id, b.transition) } : {}),
      note: note(b),
    }];
  }, true));
  // Mirrors planRender: the piece's own clip (not its angle) in the corner.
  const speaker: ExportClip[] = [];
  for (const b of bItems) {
    if (!b.pip) continue;
    for (const a of aItems) {
      const s0 = Math.max(a.start, b.start), e0 = Math.min(a.end, b.end);
      if (F(e0) <= F(s0) || clips.get(a.clipId)?.kind !== "video") continue;
      use("layout", b.id);
      const s = source(a.clipId), inn = a.in + (s0 - a.start);
      speaker.push({
        id: `${b.id}.pip.${a.id}`, itemId: b.id, sourceId: s.id, start: F(s0), end: F(e0), in: inn, out: inn + (e0 - s0), speed: 1,
        picture: { box: pipBox(doc.canvas, b.pip), fit: "cover", zoom: [], opacity: 1 }, layout: "speaker-pip", note: note(b),
      });
    }
  }
  if (speaker.length) video.push({ name: "Speaker", kind: "video", role: "speaker-pip", clips: speaker.sort((a, b) => a.start - b.start) });

  // ---- graphics: rendered overlays; behindSubject needs a mask no adapter has
  const rendered = shown(doc.tracks.graphics).flatMap(g => {
    use("graphics", g.id);
    if (g.behindSubject) use("behind-subject", g.id);
    const m = media.graphicPath?.(g);
    if (!m) warnings.push({ itemId: g.id, note: "graphic not rendered: left out" });
    return m ? [{ g, m, start: g.start, end: g.end }] : [];
  });
  video.push(...laned(rendered, "Graphics", "video", "graphics", ({ g, m }) => {
    const id = `gfx:${g.id}`;
    sources.set(id, {
      id, name: m.path.split(/[\\/]/).pop()!, path: assertAbsolute(m.path), kind: "graphic", fps: m.fps, duration: m.duration, timecodeStart: 0,
      width: doc.canvas.width, height: doc.canvas.height, hasAudio: false,
    });
    const len = Math.min(g.end - g.start, m.duration);
    return [{
      id: g.id, itemId: g.id, sourceId: id, start: F(g.start), end: F(g.start) + Math.min(F(g.end) - F(g.start), F(m.duration)), in: 0, out: len, speed: 1,
      picture: { fit: "contain", zoom: [], opacity: 1, ...fades(g.id, g) }, note: { owner: g.owner, ...(g.stage ? { stage: g.stage } : {}) },
    }];
  }, true));

  // ---- logos: the brand picture over graphics (mirrors planRender); height keeps the image's shape
  const logos = doc.logos.filter(l => clips.get(l.clipId)?.kind === "image");
  video.push(...laned(logos, "Logo", "video", "graphics", l => {
    use("graphics", l.id);
    if (l.opacity < 1) use("opacity", l.id);
    const s = source(l.clipId);
    const width = l.w * doc.canvas.width;
    return [{
      id: l.id, itemId: l.id, sourceId: s.id, start: F(l.start), end: F(l.end), in: 0, out: l.end - l.start, speed: 1,
      picture: { box: { x: l.x * doc.canvas.width, y: l.y * doc.canvas.height, width, height: width * s.height / s.width }, fit: "contain", zoom: [], opacity: l.opacity, ...fades(l.id, l) },
      note: { owner: l.owner },
    }];
  }));

  // ---- sound
  const audio: ExportTrack[] = [];
  const gain = (id: string, db: number) => { if (Math.abs(db) > 1e-6) use("gain", id); return db; };
  const speech = speechSounds(doc).map((h): ExportClip => {
    if (h.fellBack) warnings.push({ itemId: h.item.id, note: `mic ${h.item.mic} does not cover this piece: plays ${h.item.clipId}` });
    const s = source(h.clipId), f = cutFade(doc, h.span);
    if (f > 0) use("audio-fade", h.item.id);
    return {
      id: `${h.item.id}.sound`, itemId: h.item.id, sourceId: s.id, start: F(h.start), end: F(h.end), in: h.in, out: h.in + (h.end - h.start), speed: 1,
      sound: { gainDb: gain(h.item.id, h.item.gainDb + doc.mix.speechGainDb), fadeIn: f, fadeOut: f },
      note: { ...note(h.item), ...(h.item.mic && !h.fellBack ? { mic: h.item.mic } : {}) },
    };
  });
  if (speech.length) audio.push({ name: "A-roll audio", kind: "audio", role: "speech", clips: speech });
  const sounding = (id: string) => { const c = clips.get(id); return !!c && c.hasAudio && c.kind !== "image"; };
  const bSound = bItems.filter(b => !b.muted && sounding(b.clipId));
  audio.push(...laned(bSound, "B-roll audio", "audio", "b-roll-audio", b => {
    const speed = b.speed && b.speed !== 1 ? b.speed : 1;
    return [{ id: `${b.id}.sound`, itemId: b.id, sourceId: source(b.clipId).id, start: F(b.start), end: F(b.end), in: b.in, out: b.in + (b.end - b.start) * speed, speed,
      sound: { gainDb: 0, fadeIn: 0, fadeOut: 0 }, note: note(b) }];
  }));
  audio.push(...laned(shown(doc.tracks.voiceover).filter(v => sounding(v.clipId)), "Voiceover", "audio", "voiceover", v => [{
    id: v.id, itemId: v.id, sourceId: source(v.clipId).id, start: F(v.start), end: F(v.end), in: v.in, out: v.in + (v.end - v.start), speed: 1,
    sound: { gainDb: gain(v.id, v.gainDb), fadeIn: 0, fadeOut: 0 }, note: note(v),
  }]));
  const talk = mixSpeech(doc);
  audio.push(...laned(shown(doc.tracks.music).filter(m => sounding(m.clipId)), "Music", "audio", "music", m => {
    const d = m.end - m.start, fi = Math.min(m.fadeIn, d / 2), fo = Math.min(m.fadeOut, d / 2);
    if (fi > 0 || fo > 0) use("audio-fade", m.id);
    // duckPoints works in linear volume; back to dB relative to the base.
    const pts = m.duck ? duckPoints(talk, m.start, d, 1, 10 ** (doc.mix.duckingDb / 20), doc.mix.duckAttack, doc.mix.duckRelease) : [];
    if (pts.length) use("duck", m.id);
    const duck = pts.map(p => ({ time: p.time, db: p.value > 0 ? Math.round(20 * Math.log10(p.value) * 100) / 100 : -60 }));
    return [{ id: m.id, itemId: m.id, sourceId: source(m.clipId).id, start: F(m.start), end: F(m.end), in: m.in, out: m.in + d, speed: 1,
      sound: { gainDb: gain(m.id, m.gainDb), fadeIn: fi, fadeOut: fo, ...(duck.length ? { duck } : {}) }, note: note(m) }];
  }));
  audio.push(...laned(shown(doc.tracks.sfx).filter(s => sounding(s.clipId)), "SFX", "audio", "sfx", s => [{
    id: s.id, itemId: s.id, sourceId: source(s.clipId).id, start: F(s.start), end: F(s.end), in: s.in, out: s.in + (s.end - s.start), speed: 1,
    sound: { gainDb: gain(s.id, s.gainDb), fadeIn: 0, fadeOut: 0 }, note: note(s),
  }]));

  // ---- markers, titles, captions, mix
  const markers: ExportMarker[] = doc.markers.filter(m => m.status === "applied").map(m => ({ frame: F(m.time), kind: m.kind, name: m.title }));
  for (const m of doc.markers.filter(m => m.status === "applied")) use("markers", m.id);
  const titles: ExportTitle[] = shown(doc.tracks.text).map(t => {
    use("titles", t.id);
    return { itemId: t.id, start: F(t.start), end: F(t.end), template: t.template, text: t.text, ...(t.subtext ? { subtext: t.subtext } : {}), position: t.position };
  });
  const captions = shown(doc.tracks.captions).sort((a, b) => a.start - b.start).map(c => ({ start: c.start, end: c.end, text: c.text }));
  if (captions.length) use("caption-look", "captions");
  if (doc.mix.speechCleanup !== "off" || speech.length) use("loudness", "mix");

  const all = [...video, ...audio].flatMap(t => t.clips.map(c => c.end));
  const duration = Math.max(0, ...all, ...titles.map(t => t.end), ...markers.map(m => m.frame + 1));
  return {
    name: doc.name, editId: doc.id, revision: doc.revision, fps, canvas: { ...doc.canvas }, duration,
    sources: [...sources.values()], video, audio, markers, titles, captions,
    uses: Object.fromEntries(Object.entries(uses).map(([k, v]) => [k, [...v!]])) as ExportTimeline["uses"],
    warnings,
  };
}

/** Titles as markers, for adapters with no text layer: name = the text, note = template, subtext and length. */
export function titleMarkers(t: ExportTimeline): ExportMarker[] {
  const rate = t.fps.num / t.fps.den;
  return t.titles.map(x => ({ frame: x.start, kind: "note", name: x.text, note: `${x.template}${x.subtext ? `: ${x.subtext}` : ""} (${((x.end - x.start) / rate).toFixed(2)}s)` }));
}

function srtStamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** Applied captions as SRT, in output time. */
export function toSrt(doc: EditDoc): string {
  return shown(doc.tracks.captions).sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${srtStamp(c.start)} --> ${srtStamp(c.end)}\n${c.text}\n`).join("\n");
}
