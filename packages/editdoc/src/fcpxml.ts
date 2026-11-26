// Adapter: export timeline → FCPXML 1.9 (Final Cut Pro; Resolve reads it too). Unlike OTIO, FCPXML
// carries clip transforms, so each a-roll clip gets its slice of the zoom
// track as scale/position keyframes; a zoom across a cut splits cleanly.
// Units (fallback reading of Apple's spec, unverified in Resolve): position
// is percent of frame height from the centre, y up; scale is a multiplier;
// keyframe times are in the clip's own source time (its `start` plus the
// offset into it). Two keys can't share a time, so the closing key of a jump
// moves one frame earlier.
import type { Easing, ZoomKey } from "./render";
import { toFrame, type Fps } from "./time";
import type { EditDoc } from "./schema";
import { buildExportTimeline, placePicture, titleMarkers, type ExportClip, type ExportMedia, type ExportSource, type ExportTimeline } from "./export-model";

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
function transformFor(keys: ZoomKey[], fps: Fps, height: number, sourceStart: Rt): string | undefined {
  if (!keys.length) return undefined;
  const shifted = keys.some(k => k.property !== "scale");
  const step = shifted ? 3 : 1;
  const pick = (chunk: ZoomKey[], p: ZoomKey["property"]) => chunk.find(k => k.property === p)?.value ?? 0;
  const points: ZoomPoint[] = [];
  for (let i = 0; i < keys.length; i += step) {
    const chunk = keys.slice(i, i + step);
    points.push({
      frame: toFrame(chunk[0]!.time, fps),
      scale: pick(chunk, "scale"),
      // Canvas px with y down → percent of frame height with y up.
      x: (pick(chunk, "position.x") / height) * 100,
      y: (-pick(chunk, "position.y") / height) * 100,
      interp: INTERP[chunk[0]!.easing],
    });
    const next = keys[i + step];
    if (chunk[0]!.easing === "hold" && next) {
      const p = points.at(-1)!, f = toFrame(next.time, fps) - 1;
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
    el("keyframe", { time: str(add(sourceStart, frames(p.frame, fps))), value: value(p), interp: p.interp })));
  const params = [el("param", { name: "scale" }, [kf(scl)])];
  if (shifted) params.unshift(el("param", { name: "position" }, [kf(pos)]));
  return el("adjust-transform", { position: pos(out[0]!), scale: scl(out[0]!) }, params);
}

// ---- export -----------------------------------------------------------------------

interface SpineSlot { offset: Rt; start: number; end: number; localStart: Rt; tag: "asset-clip" | "gap"; attrs: Record<string, string | undefined>; head: string[]; anchored: string[]; markers: string[] }

/**
 * Box, crop and fit as conform + transform + crop. Units as in `transformFor`
 * (position % of frame height, y up; scale over the conformed size); the trim
 * rect is % of the source per edge. Unverified in any app.
 */
function placeXml(s: ExportSource, canvas: { width: number; height: number }, p: NonNullable<ExportClip["picture"]>): string[] {
  if (!p.box && !p.crop) return [el("adjust-conform", { type: p.fit === "contain" ? "fit" : "fill" })];
  const { rect, view } = placePicture(s, canvas, p);
  const k = Math.min(canvas.width / s.width, canvas.height / s.height);
  const sc = rect.width / (s.width * k);
  const x = ((rect.x + rect.width / 2 - canvas.width / 2) / canvas.height) * 100;
  const y = (-(rect.y + rect.height / 2 - canvas.height / 2) / canvas.height) * 100;
  const pct = (v: number) => num(Math.max(0, v) * 100);
  return [
    el("adjust-crop", { mode: "trim" }, [el("trim-rect", {
      left: pct((view.x - rect.x) / rect.width), right: pct((rect.x + rect.width - view.x - view.width) / rect.width),
      top: pct((view.y - rect.y) / rect.height), bottom: pct((rect.y + rect.height - view.y - view.height) / rect.height),
    })]),
    el("adjust-conform", { type: "fit" }),
    el("adjust-transform", { position: `${num(x)} ${num(y)}`, scale: `${num(sc)} ${num(sc)}` }),
  ];
}

/**
 * FCPXML 1.9 from an export timeline. Spine: the a-roll with gaps; its sound
 * stays on the spine clip unless the mic, avOffset or a J/L cut moved it, then
 * it hangs below as its own clips. Connected above: every other video track in
 * order (layout, b-roll, speaker corner, graphics); below: b-roll sound,
 * voiceover, music, SFX. Markers and titles sit in the spine slot they fall in.
 */
export function fcpxmlFromTimeline(t: ExportTimeline): string {
  const fps = t.fps;
  const src = new Map(t.sources.map(s => [s.id, s]));
  const seqF = (f: number) => frames(f, fps);
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
  const seqFormat = format(fps, t.canvas.width, t.canvas.height);

  const assetIds = new Map<string, string>();
  const rateOf = (s: ExportSource) => s.fps ?? fps;
  const assetFor = (s: ExportSource) => {
    let id = assetIds.get(s.id);
    if (id) return id;
    id = nextId();
    assetIds.set(s.id, id);
    const rate = rateOf(s);
    const video = s.kind !== "audio";
    const fmt = video ? format(s.kind === "image" ? undefined : rate, s.width, s.height) : undefined;
    assets.push(el("asset", {
      id, name: s.name,
      start: str(frames(toFrame(s.timecodeStart, rate), rate)),
      duration: s.kind === "image" ? "0s" : str(frames(toFrame(s.duration, rate), rate)),
      hasVideo: video ? "1" : undefined, format: fmt,
      hasAudio: s.hasAudio ? "1" : undefined, audioSources: s.hasAudio ? "1" : undefined, audioChannels: s.hasAudio ? "2" : undefined,
    }, [el("media-rep", { kind: "original-media", src: fileUrl(s.path) })]));
    return id;
  };
  /** Where a clip reads from in its source's own time. */
  const sourceStart = (c: ExportClip) => {
    const s = src.get(c.sourceId)!, rate = rateOf(s);
    return { s, start: frames(toFrame(s.timecodeStart + c.in, rate), rate) };
  };

  // Spine: the top a-roll track; sound stays on it where the speech clip matches its picture.
  const aTracks = t.video.filter(tr => tr.role === "a-roll");
  const spineTrack = aTracks.at(-1)?.clips ?? [];
  const speech = t.audio.find(tr => tr.role === "speech")?.clips ?? [];
  const onSpine = new Set<string>();
  const spine: SpineSlot[] = [];
  const gap = (from: number, to: number) => {
    if (to <= from) return;
    spine.push({ offset: seqF(from), start: from, end: to, localStart: { n: 0n, d: 1n }, tag: "gap",
      attrs: { name: "Gap", start: "0s", duration: str(seqF(to - from)) }, head: [], anchored: [], markers: [] });
  };
  let cursor = 0;
  for (const c of spineTrack) {
    gap(cursor, c.start);
    const { s, start } = sourceStart(c);
    const heard = speech.find(h => h.itemId === c.itemId && h.sourceId === c.sourceId && h.start === c.start && h.end === c.end && Math.abs(h.in - c.in) < 1e-6);
    if (heard) onSpine.add(heard.id);
    const p = c.picture!;
    const head = [
      ...(p.box ? placeXml(s, t.canvas, p) : [transformFor(p.zoom, fps, t.canvas.height, start)]),
      heard ? el("adjust-volume", { amount: db(heard.sound!.gainDb) }) : undefined,
    ].filter((x): x is string => !!x);
    spine.push({ offset: seqF(c.start), start: c.start, end: c.end, localStart: start, tag: "asset-clip",
      attrs: { ref: assetFor(s), name: c.itemId, start: str(start), duration: str(seqF(c.end - c.start)), srcEnable: heard || !s.hasAudio ? undefined : "video", tcFormat: "NDF" },
      head, anchored: [], markers: [] });
    cursor = c.end;
  }
  gap(cursor, t.duration);
  if (!spine.length) gap(0, 1);

  /** The spine slot over sequence frame `f`; the last slot takes anything past the end. */
  const slotAt = (f: number) => spine.find(s => f < s.end) ?? spine[spine.length - 1]!;
  const local = (slot: SpineSlot, f: number) => add(slot.localStart, sub(seqF(f), slot.offset));
  const connect = (f: number, xml: (offset: Rt) => string) => { const s = slotAt(f); s.anchored.push(xml(local(s, f))); };
  const clipXml = (c: ExportClip, lane: number, extra: { srcEnable?: string; head?: string[] }) => (offset: Rt) => {
    const { s, start } = sourceStart(c);
    return el("asset-clip", {
      ref: assetFor(s), lane: String(lane), offset: str(offset), name: c.itemId,
      start: str(start), duration: str(seqF(c.end - c.start)), srcEnable: extra.srcEnable, tcFormat: "NDF",
    }, extra.head ?? []);
  };

  // Connected video: every track but the spine, bottom first, a lane each.
  let lane = 0;
  for (const tr of t.video) {
    if (tr.clips === spineTrack) continue;
    lane++;
    for (const c of tr.clips) {
      const s = src.get(c.sourceId)!, p = c.picture!;
      connect(c.start, clipXml(c, lane, {
        srcEnable: s.kind === "graphic" ? undefined : "video",
        head: s.kind === "graphic" ? [] : [
          ...(tr.role === "a-roll" && !p.box ? [transformFor(p.zoom, fps, t.canvas.height, sourceStart(c).start)].filter((x): x is string => !!x) : placeXml(s, t.canvas, p)),
          ...(p.opacity < 1 ? [el("adjust-blend", { amount: num(p.opacity) })] : []),
        ],
      }));
    }
  }

  // Sound below the spine, a lane each; fades shorter than a frame are left out.
  const oneFrame = 1 / (fps.num / fps.den);
  lane = 0;
  for (const tr of t.audio) {
    const clips = tr.clips.filter(c => !onSpine.has(c.id));
    if (!clips.length) continue;
    lane--;
    for (const c of clips) {
      const a = c.sound!, s = src.get(c.sourceId)!;
      const fi = a.fadeIn >= oneFrame ? a.fadeIn : 0, fo = a.fadeOut >= oneFrame ? a.fadeOut : 0;
      const fade = fi || fo
        ? [el("param", { name: "amount" }, [
          ...(fi ? [el("fadeIn", { type: "easeIn", duration: str(seqF(toFrame(fi, fps))) })] : []),
          ...(fo ? [el("fadeOut", { type: "easeIn", duration: str(seqF(toFrame(fo, fps))) })] : []),
        ])]
        : [];
      connect(c.start, clipXml(c, lane, { srcEnable: s.kind === "video" ? "audio" : undefined, head: [el("adjust-volume", { amount: db(a.gainDb) }, fade)] }));
    }
  }

  // Markers sit inside the spine slot they fall in. FCPXML has no text layers;
  // titles travel as markers with a note, as in the OTIO export.
  const oneFrameStr = str(frames(1, fps));
  const mark = (f: number, xml: (start: Rt) => string) => { const s = slotAt(f); s.markers.push(xml(local(s, f))); };
  for (const m of t.markers) mark(m.frame, start => el(m.kind === "chapter" ? "chapter-marker" : "marker", {
    start: str(start), duration: oneFrameStr, value: m.name, posterOffset: m.kind === "chapter" ? "0s" : undefined,
  }));
  for (const m of titleMarkers(t)) mark(m.frame, start => el("marker", { start: str(start), duration: oneFrameStr, value: m.name, note: m.note }));

  const spineXml = spine.map(s => el(s.tag, { offset: str(s.offset), ...s.attrs }, [...s.head, ...s.anchored, ...s.markers]));
  const end = spine[spine.length - 1]!;
  const body = el("fcpxml", { version: "1.9" }, [
    el("resources", {}, [...formats, ...assets]),
    el("library", {}, [el("event", { name: t.name }, [el("project", { name: t.name }, [
      el("sequence", { format: seqFormat, duration: str(seqF(end.end)), tcStart: "0s", tcFormat: "NDF", audioLayout: "stereo", audioRate: "48k" },
        [el("spine", {}, spineXml)]),
    ])])]),
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n${body}\n`;
}

/** EditDoc → FCPXML (kept for callers; same as the "finalcut" exporter). */
export function toFcpxml(doc: EditDoc, media: ExportMedia): string {
  return fcpxmlFromTimeline(buildExportTimeline(doc, media));
}
