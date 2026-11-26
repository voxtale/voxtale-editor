// Resolve hand-off with zooms: EditDoc → FCPXML 1.9. Unlike OTIO, FCPXML
// carries clip transforms, so each a-roll clip gets its slice of the zoom
// track as scale/position keyframes; a zoom across a cut splits cleanly.
// Units (fallback reading of Apple's spec, unverified in Resolve): position
// is percent of frame height from the centre, y up; scale is a multiplier;
// keyframe times are in the clip's own source time (its `start` plus the
// offset into it). Two keys can't share a time, so the closing key of a jump
// moves one frame earlier.
import { lanes, zoomKeysBetween, type Easing, type ZoomKey } from "./render";
import { fpsValue, toFrame, type Fps } from "./time";
import type { OtioMedia } from "./otio";
import type { ClipItem, ClipRef, EditDoc, Item } from "./schema";

const live = <T extends Item>(items: T[]) => items.filter(i => i.status !== "suggested");

// ---- rational time ------------------------------------------------------------

/** Seconds as an exact fraction; BigInt so 1001-rate timecodes don't overflow. */
interface Rt { n: bigint; d: bigint }
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
const rt = (n: bigint, d: bigint): Rt => { const g = gcd(n, d) || 1n; return { n: n / g, d: d / g }; };
/** Frame `frames` at `fps`, as seconds. */
const frames = (count: number, fps: Fps): Rt => rt(BigInt(count) * BigInt(fps.den), BigInt(fps.num));
const add = (a: Rt, b: Rt): Rt => rt(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Rt, b: Rt): Rt => add(a, { n: -b.n, d: b.d });
const str = (t: Rt): string => (t.n === 0n ? "0s" : t.d === 1n ? `${t.n}s` : `${t.n}/${t.d}s`);

// ---- xml ----------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const attrs = (a: Record<string, string | number | undefined>) =>
  Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${esc(String(v))}"`).join("");
const el = (name: string, a: Record<string, string | number | undefined>, children: string[] = []) =>
  children.length ? `<${name}${attrs(a)}>${children.join("")}</${name}>` : `<${name}${attrs(a)}/>`;

/** Absolute path → file URL, each segment percent-encoded. Windows drives become file:///C:/… */
export function fileUrl(path: string): string {
  const p = path.replace(/\\/g, "/");
  if (!p.startsWith("/") && !/^[A-Za-z]:\//.test(p)) throw new Error(`Clip path must be absolute: ${path}`);
  const segs = (p.startsWith("/") ? p.slice(1) : p).split("/").map(s => (/^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)));
  return `file:///${segs.join("/")}`;
}

const num = (x: number) => String(Math.round(x * 10_000) / 10_000);
const db = (x: number) => `${num(x)}dB`;

// ---- zoom → adjust-transform ----------------------------------------------------

/** FCPXML has linear, ease, easeIn, easeOut: the nearest for each curve. A hold gets a second key a frame before the next. */
const INTERP: Record<Easing, string> = { linear: "linear", "ease-in-out": "ease", hold: "linear", snap: "easeOut", settle: "easeOut", build: "easeIn" };

interface ZoomPoint { frame: number; scale: number; x: number; y: number; interp: string }

/**
 * The zoom track over one a-roll clip as `adjust-transform`. Plain attributes
 * when the clip holds one zoom; keyframes when it moves; nothing when wide.
 */
function transformFor(doc: EditDoc, item: ClipItem, sourceStart: Rt): string | undefined {
  const { height } = doc.canvas;
  const keys = zoomKeysBetween(doc.tracks.zoom ?? [], item.start, item.end, doc.canvas);
  if (!keys.length) return undefined;
  const shifted = keys.some(k => k.property !== "scale");
  const step = shifted ? 3 : 1;
  const pick = (chunk: ZoomKey[], p: ZoomKey["property"]) => chunk.find(k => k.property === p)?.value ?? 0;
  const points: ZoomPoint[] = [];
  for (let i = 0; i < keys.length; i += step) {
    const chunk = keys.slice(i, i + step);
    points.push({
      frame: toFrame(chunk[0]!.time, doc.fps),
      scale: pick(chunk, "scale"),
      // Canvas px with y down → percent of frame height with y up.
      x: (pick(chunk, "position.x") / height) * 100,
      y: (-pick(chunk, "position.y") / height) * 100,
      interp: INTERP[chunk[0]!.easing],
    });
    const next = keys[i + step];
    if (chunk[0]!.easing === "hold" && next) {
      const p = points.at(-1)!, f = toFrame(next.time, doc.fps) - 1;
      if (f > p.frame) points.push({ ...p, frame: f });
    }
  }
  const same = (a: ZoomPoint, b: ZoomPoint) => Math.abs(a.scale - b.scale) < 1e-4 && Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3;
  const pos = (p: ZoomPoint) => `${num(p.x)} ${num(p.y)}`;
  const scl = (p: ZoomPoint) => `${num(p.scale)} ${num(p.scale)}`;
  if (points.every(p => same(p, points[0]!))) {
    const p = points[0]!;
    if (Math.abs(p.scale - 1) < 1e-4 && Math.abs(p.x) < 1e-3 && Math.abs(p.y) < 1e-3) return undefined;
    return el("adjust-transform", { position: pos(p), scale: scl(p) });
  }
  // One key per frame: a jump's closing key steps back a frame; a key that
  // then lands on its predecessor's frame replaces it.
  const out: ZoomPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && p.frame <= last.frame) {
      last.frame = p.frame - 1;
      while (out.length > 1 && out[out.length - 2]!.frame >= last.frame) out.splice(out.length - 2, 1);
      if (last.frame < 0) out.pop();
    }
    out.push({ ...p });
  }
  const kf = (value: (p: ZoomPoint) => string) => el("keyframeAnimation", {}, out.map(p =>
    el("keyframe", { time: str(add(sourceStart, frames(p.frame, doc.fps))), value: value(p), interp: p.interp })));
  const params = [el("param", { name: "scale" }, [kf(scl)])];
  if (shifted) params.unshift(el("param", { name: "position" }, [kf(pos)]));
  return el("adjust-transform", { position: pos(out[0]!), scale: scl(out[0]!) }, params);
}

// ---- export -----------------------------------------------------------------------

interface SpineSlot { offset: Rt; startSec: number; endSec: number; localStart: Rt; tag: "asset-clip" | "gap"; attrs: Record<string, string | undefined>; head: string[]; anchored: string[]; markers: string[] }

/**
 * FCPXML 1.9 for Resolve's File > Import > Timeline. Spine: a-roll with gaps.
 * Connected above: b-roll, then graphics (alpha ProRes). Below: voiceover,
 * music, SFX. Markers: chapters as chapter markers, notes and text items as
 * markers. Captions travel as SRT (`toSrt`).
 */
export function toFcpxml(doc: EditDoc, media: OtioMedia): string {
  const fps = doc.fps;
  const clips = new Map(doc.clips.map(c => [c.id, c]));
  const seq = (s: number) => frames(toFrame(s, fps), fps);
  const formats: string[] = [];
  const assets: string[] = [];
  let ids = 0;
  const nextId = () => `r${++ids}`;
  const formatIds = new Map<string, string>();
  const format = (rate: Fps | undefined, w: number | undefined, h: number | undefined) => {
    const key = `${rate ? `${rate.num}/${rate.den}` : "still"}@${w ?? ""}x${h ?? ""}`;
    let id = formatIds.get(key);
    if (!id) {
      id = nextId();
      formatIds.set(key, id);
      formats.push(el("format", { id, frameDuration: rate ? str(frames(1, rate)) : undefined, width: w, height: h }));
    }
    return id;
  };
  const seqFormat = format(fps, doc.canvas.width, doc.canvas.height);

  const assetIds = new Map<string, string>();
  const clipRate = (clip: ClipRef) => clip.fps ?? fps;
  const assetFor = (clip: ClipRef) => {
    let id = assetIds.get(clip.id);
    if (id) return id;
    id = nextId();
    assetIds.set(clip.id, id);
    const rate = clipRate(clip);
    const video = clip.kind !== "audio";
    const fmt = video ? format(clip.kind === "image" ? undefined : rate, clip.width, clip.height) : undefined;
    assets.push(el("asset", {
      id, name: clip.name,
      start: str(frames(toFrame(clip.timecodeStart, rate), rate)),
      duration: clip.kind === "image" ? "0s" : str(frames(toFrame(clip.duration, rate), rate)),
      hasVideo: video ? "1" : undefined, format: fmt,
      hasAudio: clip.hasAudio && clip.kind !== "image" ? "1" : undefined,
      audioSources: clip.hasAudio && clip.kind !== "image" ? "1" : undefined,
      audioChannels: clip.hasAudio && clip.kind !== "image" ? "2" : undefined,
    }, [el("media-rep", { kind: "original-media", src: fileUrl(media.clipPath(clip)) })]));
    return id;
  };
  /** Where an item reads from in its own clip's time. */
  const sourceStart = (item: ClipItem): { clip: ClipRef; start: Rt } => {
    const clip = clips.get(item.clipId);
    if (!clip) throw new Error(`Unknown clip ${item.clipId}`);
    const rate = clipRate(clip);
    return { clip, start: frames(toFrame(clip.timecodeStart + item.in, rate), rate) };
  };

  // Spine: a-roll in order, gaps between, a tail gap over anything connected past the end.
  const aroll = live(doc.tracks["a-roll"]).filter(i => i.end > i.start).sort((a, b) => a.start - b.start);
  const connectedEnds = [
    ...live(doc.tracks["b-roll"]), ...live(doc.tracks.graphics), ...live(doc.tracks.voiceover),
    ...live(doc.tracks.music), ...live(doc.tracks.sfx), ...live(doc.tracks.text),
  ].map(i => i.end);
  const markerTimes = doc.markers.filter(m => m.status === "applied").map(m => m.time);
  const total = Math.max(0, ...aroll.map(i => i.end), ...connectedEnds, ...markerTimes.map(t => t + 1 / fpsValue(fps)));
  const spine: SpineSlot[] = [];
  const gap = (from: number, to: number) => {
    if (toFrame(to, fps) <= toFrame(from, fps)) return;
    spine.push({ offset: seq(from), startSec: from, endSec: to, localStart: { n: 0n, d: 1n }, tag: "gap",
      attrs: { name: "Gap", start: "0s", duration: str(sub(seq(to), seq(from))) }, head: [], anchored: [], markers: [] });
  };
  let cursor = 0;
  for (const item of aroll) {
    if (item.start < cursor - 1e-6) throw new Error(`Overlap on A-roll at ${item.id}`);
    gap(cursor, item.start);
    const { clip, start } = sourceStart(item);
    const head = [transformFor(doc, item, start), el("adjust-volume", { amount: db(item.gainDb + doc.mix.speechGainDb) })]
      .filter((x): x is string => !!x);
    spine.push({ offset: seq(item.start), startSec: item.start, endSec: item.end, localStart: start, tag: "asset-clip",
      attrs: { ref: assetFor(clip), name: item.id, start: str(start), duration: str(sub(seq(item.end), seq(item.start))), tcFormat: "NDF" },
      head, anchored: [], markers: [] });
    cursor = item.end;
  }
  gap(cursor, total);
  if (!spine.length) gap(0, 1);

  /** The spine slot over output time `t`; the last slot takes anything past the end. */
  const slotAt = (t: number) => spine.find(s => toFrame(t, fps) < toFrame(s.endSec, fps)) ?? spine[spine.length - 1]!;
  const local = (slot: SpineSlot, t: number) => add(slot.localStart, sub(seq(t), slot.offset));
  const connect = (t: number, xml: (offset: Rt) => string) => { const s = slotAt(t); s.anchored.push(xml(local(s, t))); };

  // Lanes: overlapping items on one track spread over lanes; video lanes count up, audio down.
  let up = 1;
  let down = -1;
  const stack = <T extends { start: number; end: number }>(items: T[], audio: boolean, place: (item: T, lane: number) => void) => {
    if (!items.length) return;
    const l = lanes(items);
    const span = Math.max(...l);
    items.forEach((item, i) => place(item, audio ? down - l[i]! : up + (span - l[i]!)));
    if (audio) down -= span + 1; else up += span + 1;
  };
  const clipXml = (item: ClipItem, lane: number, extra: { srcEnable?: string; head?: string[] }) => (offset: Rt) => {
    const { clip, start } = sourceStart(item);
    return el("asset-clip", {
      ref: assetFor(clip), lane: String(lane), offset: str(offset), name: item.id,
      start: str(start), duration: str(sub(seq(item.end), seq(item.start))), srcEnable: extra.srcEnable, tcFormat: "NDF",
    }, extra.head ?? []);
  };

  stack(live(doc.tracks["b-roll"]), false, (b, lane) => connect(b.start, clipXml(b, lane, {
    srcEnable: b.muted ? "video" : undefined,
    head: [
      el("adjust-conform", { type: b.fit === "contain" ? "fit" : "fill" }),
      ...(b.opacity < 1 ? [el("adjust-blend", { amount: num(b.opacity) })] : []),
    ],
  })));

  const graphics = live(doc.tracks.graphics).flatMap(g => {
    const m = media.graphicPath?.(g);
    return m ? [{ g, m, start: g.start, end: g.end }] : [];
  });
  stack(graphics, false, ({ g, m }, lane) => {
    const id = nextId();
    assets.push(el("asset", {
      id, name: m.path.split(/[\\/]/).pop(), start: "0s", duration: str(frames(Math.round(m.duration * fpsValue(m.fps)), m.fps)),
      hasVideo: "1", format: format(m.fps, doc.canvas.width, doc.canvas.height),
    }, [el("media-rep", { kind: "original-media", src: fileUrl(m.path) })]));
    const len = Math.min(toFrame(g.end, fps) - toFrame(g.start, fps), toFrame(m.duration, fps));
    connect(g.start, offset => el("asset-clip", {
      ref: id, lane: String(lane), offset: str(offset), name: g.id, start: "0s", duration: str(frames(len, fps)), tcFormat: "NDF",
    }));
  });

  const sound = (item: ClipItem & { gainDb: number }, lane: number, fades?: { fadeIn: number; fadeOut: number }) => {
    const clip = clips.get(item.clipId);
    const fade = fades && (fades.fadeIn > 0 || fades.fadeOut > 0)
      ? [el("param", { name: "amount" }, [
        ...(fades.fadeIn > 0 ? [el("fadeIn", { type: "easeIn", duration: str(seq(fades.fadeIn)) })] : []),
        ...(fades.fadeOut > 0 ? [el("fadeOut", { type: "easeIn", duration: str(seq(fades.fadeOut)) })] : []),
      ])]
      : [];
    connect(item.start, clipXml(item, lane, {
      srcEnable: clip?.kind === "video" ? "audio" : undefined,
      head: [el("adjust-volume", { amount: db(item.gainDb) }, fade)],
    }));
  };
  stack(live(doc.tracks.voiceover), true, (v, lane) => sound(v, lane));
  stack(live(doc.tracks.music), true, (m, lane) => sound(m, lane, m));
  stack(live(doc.tracks.sfx), true, (s, lane) => sound(s, lane));

  // Markers sit inside the spine slot they fall in. FCPXML has no text layers;
  // text items travel as markers with a note, as in the OTIO export.
  const oneFrame = str(frames(1, fps));
  const mark = (t: number, xml: (start: Rt) => string) => { const s = slotAt(t); s.markers.push(xml(local(s, t))); };
  for (const m of doc.markers.filter(m => m.status === "applied")) {
    mark(m.time, start => el(m.kind === "chapter" ? "chapter-marker" : "marker", {
      start: str(start), duration: oneFrame, value: m.title, posterOffset: m.kind === "chapter" ? "0s" : undefined,
    }));
  }
  for (const t of live(doc.tracks.text)) {
    mark(t.start, start => el("marker", {
      start: str(start), duration: oneFrame, value: t.text,
      note: `${t.template}${t.subtext ? `: ${t.subtext}` : ""} (${(t.end - t.start).toFixed(2)}s)`,
    }));
  }

  const spineXml = spine.map(s => el(s.tag, { offset: str(s.offset), ...s.attrs }, [...s.head, ...s.anchored, ...s.markers]));
  const end = spine[spine.length - 1]!;
  const duration = add(end.offset, sub(seq(end.endSec), seq(end.startSec)));
  const body = el("fcpxml", { version: "1.9" }, [
    el("resources", {}, [...formats, ...assets]),
    el("library", {}, [el("event", { name: doc.name }, [el("project", { name: doc.name }, [
      el("sequence", { format: seqFormat, duration: str(duration), tcStart: "0s", tcFormat: "NDF", audioLayout: "stereo", audioRate: "48k" },
        [el("spine", {}, spineXml)]),
    ])])]),
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n${body}\n`;
}
