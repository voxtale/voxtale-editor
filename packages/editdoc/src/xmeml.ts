// Adapter: export timeline → Final Cut Pro 7 XML (xmeml v4), the format Adobe
// Premiere Pro imports natively and DaVinci Resolve reads as "FCP 7 XML".
// Units (Basic Motion, Crop, Audio Levels, Time Remap) were measured in
// Premiere 26.5 by REDACTED (editor/src/premiere.ts); the Resolve variant
// divides by Resolve's default "Scale entire image to fit" first.
import { fpsValue } from "./time";
import { dbToVolume, keyValue, type ZoomKey } from "./render";
import { placePicture, titleMarkers, zoomRect, type ExportClip, type ExportSource, type ExportTimeline, type Rect } from "./export-model";

export interface XmemlOptions { resolve?: boolean }
export interface AdapterOutput { text: string; notes: { itemId: string; note: string }[] }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A path as Premiere writes it: file://localhost/Users/… (Mac), file://localhost/C%3a/Users/… (Windows). */
export const xmemlPathUrl = (abs: string) => "file://localhost" + (/^[A-Za-z]:/.test(abs) ? "/" : "")
  + abs.split(/[\\/]/).map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? `${s[0]}%3a` : encodeURIComponent(s))).join("/");
const rateXml = (fps: number) => `<rate><timebase>${Math.round(fps)}</timebase><ntsc>${Number.isInteger(fps) ? "FALSE" : "TRUE"}</ntsc></rate>`;

/** Premiere's XML import clips Audio Levels above +12 dB (REDACTED, Premiere 26.5). */
const MAX_LEVEL = 3.98109;

interface Motion { scale: number; horiz: number; vert: number }
/**
 * Basic Motion for a source drawn at `rect` (canvas px). Scale 100 = source
 * pixels; centre = offset of the picture's middle from the canvas middle,
 * divided by the SOURCE size (REDACTED measured, Premiere 26.5).
 */
function motionOf(src: { width: number; height: number }, canvas: { width: number; height: number }, r: Rect, resolve: boolean): Motion {
  // Resolve first fits the source to the timeline, then applies the XML scale on top.
  const fit = resolve ? Math.min(canvas.width / src.width, canvas.height / src.height) : 1;
  return {
    scale: +((r.width / src.width) * 100 / fit).toFixed(3),
    horiz: +((r.x + r.width / 2 - canvas.width / 2) / src.width / fit).toFixed(6),
    vert: +((r.y + r.height / 2 - canvas.height / 2) / src.height / fit).toFixed(6),
  };
}

function motionFilter(keys: ({ frame: number } & Motion)[], inFrame: number): string {
  const animated = keys.length > 1, first = keys[0]!;
  const kf = (v: (k: (typeof keys)[number]) => string) => keys.map(k => `<keyframe><when>${inFrame + k.frame}</when><value>${v(k)}</value></keyframe>`).join("");
  return `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>`
    + `<parameter authoringApp="PremierePro"><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>${first.scale}</value>${animated ? kf(k => String(k.scale)) : ""}</parameter>`
    + `<parameter authoringApp="PremierePro"><parameterid>center</parameterid><name>Center</name><value><horiz>${first.horiz}</horiz><vert>${first.vert}</vert></value>${animated ? kf(k => `<horiz>${k.horiz}</horiz><vert>${k.vert}</vert>`) : ""}</parameter>`
    + `</effect></filter>`;
}

function cropFilter(c: { left: number; right: number; top: number; bottom: number }): string {
  if (!c.left && !c.right && !c.top && !c.bottom) return "";
  const p = (id: keyof typeof c) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${id}</name><valuemin>0</valuemin><valuemax>100</valuemax><value>${c[id]}</value></parameter>`;
  return `<filter><effect><name>Crop</name><effectid>crop</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${p("left")}${p("right")}${p("top")}${p("bottom")}</effect></filter>`;
}

const opacityFilter = (keys: { when: number; value: number }[]) =>
  `<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>`
  + `<parameter authoringApp="PremierePro"><parameterid>opacity</parameterid><name>opacity</name><valuemin>0</valuemin><valuemax>100</valuemax><value>${keys[0]!.value}</value>`
  + (keys.length > 1 ? keys.map(k => `<keyframe><when>${k.when}</when><value>${k.value}</value></keyframe>`).join("") : "")
  + `</parameter></effect></filter>`;

const levelFilter = (value: number, keys: { when: number; value: number }[]) =>
  `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>`
  + `<parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>${MAX_LEVEL}</valuemax><value>${value}</value>`
  + keys.map(k => `<keyframe><when>${k.when}</when><value>${k.value}</value></keyframe>`).join("")
  + `</parameter></effect></filter>`;

/**
 * Constant speed as Premiere exports it: Time Remap at a fixed % plus its
 * graphdict table (clip frame → file frame).
 */
function speedFilter(speed: number, mediaType: "video" | "audio", inF: number, frames: number, lo: number, hi: number, len: number, fileFrames: number): string {
  const kf = (when: number, value: number, flag: string) => `<keyframe><when>${when}</when><value>${value}</value><speedvirtualkf>TRUE</speedvirtualkf><${flag}>TRUE</${flag}></keyframe>`;
  const param = (id: string, value: string, range = "") => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${id}</name>${range}<value>${value}</value></parameter>`;
  const graph = `<parameter authoringApp="PremierePro"><parameterid>graphdict</parameterid><name>graphdict</name><valuemin>0</valuemin><valuemax>${fileFrames}</valuemax><value>0</value>`
    + kf(0, 0, "speedkfstart") + kf(inF, lo, "speedkfin") + kf(inF + frames, hi, "speedkfout") + kf(len, fileFrames, "speedkfend") + `<interpolation><name>FCPCurve</name></interpolation></parameter>`;
  return `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>${mediaType}</mediatype>`
    + param("variablespeed", "0", "<valuemin>0</valuemin><valuemax>1</valuemax>")
    + param("speed", String(+(speed * 100).toFixed(2)), "<valuemin>-100000</valuemin><valuemax>100000</valuemax>")
    + param("reverse", "FALSE") + param("frameblending", "FALSE") + graph + `</effect></filter>`;
}

/**
 * Times (clip seconds) to key the zoom at. Premiere joins keys in straight
 * lines and an XML carries no curves, so eased moves are sampled every 2
 * frames; a hold jumps one frame before the next key (REDACTED's rule).
 */
function zoomTimes(keys: ZoomKey[], len: number, rate: number): number[] {
  const times = new Set<number>([0]);
  const byProp = new Map<string, ZoomKey[]>();
  for (const k of keys) byProp.set(k.property, [...(byProp.get(k.property) ?? []), k]);
  for (const ks of byProp.values()) {
    const s = [...ks].sort((a, b) => a.time - b.time);
    for (let i = 0; i < s.length; i++) {
      const a = s[i]!, b = s[i + 1];
      times.add(a.time);
      if (!b || b.time <= a.time) continue;
      if (a.easing === "hold") times.add(Math.max(a.time, b.time - 1 / rate));
      else if (a.easing !== "linear") for (let t = a.time + 2 / rate; t < b.time - 1e-6; t += 2 / rate) times.add(+t.toFixed(6));
    }
  }
  return [...times].filter(t => t >= 0 && t <= len + 1e-6).sort((a, b) => a - b);
}

/** FCP 7 XML for Premiere (default) or DaVinci Resolve (`resolve`). */
export function toXmeml(t: ExportTimeline, opts: XmemlOptions = {}): AdapterOutput {
  const resolve = !!opts.resolve;
  const rate = fpsValue(t.fps);
  const f = (s: number) => Math.round(s * rate);
  const notes: AdapterOutput["notes"] = [];
  const extraMarkers: { frame: number; name: string; note: string }[] = [];
  const src = new Map(t.sources.map(s => [s.id, s]));
  const fileIds = new Map(t.sources.map((s, i) => [s.id, `file-${i + 1}`]));
  const declared = new Set<string>();
  /** File length in sequence frames: a 24 fps file in a 25 fps sequence counts in time, not frames. */
  const fileFrames = (s: ExportSource) => s.kind === "image" ? f(3600) : f(s.duration);

  const fileXml = (s: ExportSource): string => {
    const id = fileIds.get(s.id)!;
    if (declared.has(id)) return `<file id="${id}"/>`;
    declared.add(id);
    const own = s.fps ? fpsValue(s.fps) : rate;
    return `<file id="${id}"><name>${esc(s.name)}</name><pathurl>${xmemlPathUrl(s.path)}</pathurl>${rateXml(own)}<duration>${Math.round(s.duration * own)}</duration>`
      + `<media>${s.kind === "audio" ? "" : `<video><samplecharacteristics>${rateXml(own)}<width>${s.width}</width><height>${s.height}</height></samplecharacteristics></video>`}`
      + (s.hasAudio ? `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>` : "")
      + `</media></file>`;
  };

  /** in / out / duration as Premiere writes them, speed included (REDACTED `span`). */
  const span = (c: ExportClip, s: ExportSource) => {
    const frames = c.end - c.start, M = fileFrames(s);
    if (s.kind === "image") return { inF: 0, len: M, lo: 0, hi: frames };
    if (c.speed !== 1) {
      const lo = f(c.in), hi = f(c.out);
      return { inF: Math.round(lo / c.speed), len: Math.round(M / c.speed), lo, hi };
    }
    return { inF: Math.max(0, Math.min(f(c.in), M - frames)), len: M, lo: 0, hi: 0 };
  };

  const clipItem = (id: string, c: ExportClip, s: ExportSource, inF: number, len: number, body: string) =>
    `<clipitem id="${id}"><name>${esc(c.itemId)}</name><enabled>TRUE</enabled><duration>${len}</duration>${rateXml(rate)}`
    + `<start>${c.start}</start><end>${c.end}</end><in>${inF}</in><out>${inF + c.end - c.start}</out>${fileXml(s)}${body}`
    + (c.note.angle || c.note.mic || s.look ? `<comments><mastercomment1>${esc([c.note.angle && `angle ${c.note.angle}`, c.note.mic && `mic ${c.note.mic}`, s.look].filter(Boolean).join("; "))}</mastercomment1></comments>` : "")
    + `</clipitem>`;

  const videoFilters = (c: ExportClip, s: ExportSource, inF: number): string => {
    const p = c.picture!;
    const len = (c.end - c.start) / rate;
    const { rect, view } = placePicture(s, t.canvas, p);
    // Crop: whatever of the placed source falls outside its view, in % of the source.
    const pct = (v: number) => +(Math.max(0, v) * 100).toFixed(3);
    const crop = {
      left: pct((view.x - rect.x) / rect.width), right: pct((rect.x + rect.width - view.x - view.width) / rect.width),
      top: pct((view.y - rect.y) / rect.height), bottom: pct((rect.y + rect.height - view.y - view.height) / rect.height),
    };
    // Full-frame pictures overflow the canvas, which crops them already.
    const boxed = !!p.box || !!p.crop || p.fit === "contain";
    const keys = (p.zoom.length ? zoomTimes(p.zoom, len, rate) : [0]).map(time => ({
      frame: f(time),
      ...motionOf(s, t.canvas, zoomRect(rect, t.canvas, keyValue(p.zoom, "scale", time, 1), keyValue(p.zoom, "position.x", time, 0), keyValue(p.zoom, "position.y", time, 0)), resolve),
    })).filter((k, i, all) => i === 0 || k.frame !== all[i - 1]!.frame);
    let out = motionFilter(keys, inF) + (boxed ? cropFilter(crop) : "");
    // Opacity with picture fades: a fade of whole frames = 2 keys, the last on the clip's last frame (REDACTED opacityKeys).
    const n = c.end - c.start, o = p.opacity;
    const fi = Math.min(n, f(p.fadeIn ?? 0)), fo = Math.min(n - fi, f(p.fadeOut ?? 0));
    if (fi || fo || o < 1) {
      const pc = (x: number) => Math.round(x * 10000) / 100;
      const pts: [number, number][] = [...(fi ? [[0, 0], [fi, o]] as [number, number][] : [[0, o]] as [number, number][]),
        ...(fo ? [[n - fo, o], [n - 1, o / fo]] as [number, number][] : [[n - 1, o]] as [number, number][])]
        .filter(([w], k, all) => k === 0 || w !== all[k - 1]![0]);
      out += opacityFilter(fi || fo ? pts.map(([w, v]) => ({ when: inF + w, value: pc(v) })) : [{ when: inF, value: pc(o) }]);
    }
    return out;
  };

  const audioFilters = (c: ExportClip, inF: number): string => {
    // Cut fades shorter than a frame (the 10 ms default) have no key to sit on.
    const a0 = c.sound!, len = (c.end - c.start) / rate;
    const a = { ...a0, fadeIn: a0.fadeIn >= 1 / rate ? a0.fadeIn : 0, fadeOut: a0.fadeOut >= 1 / rate ? a0.fadeOut : 0 };
    const times = new Set<number>([0, len]);
    if (a.fadeIn) times.add(Math.min(len, a.fadeIn));
    if (a.fadeOut) times.add(Math.max(0, len - a.fadeOut));
    for (const d of a.duck ?? []) if (d.time >= 0 && d.time <= len) times.add(d.time);
    const duckAt = (x: number) => {
      const d = a.duck ?? [];
      if (!d.length) return 0;
      if (x <= d[0]!.time) return d[0]!.db;
      for (let i = 0; i < d.length - 1; i++) if (x <= d[i + 1]!.time) {
        const u = (x - d[i]!.time) / Math.max(1e-9, d[i + 1]!.time - d[i]!.time);
        return d[i]!.db + (d[i + 1]!.db - d[i]!.db) * u;
      }
      return d.at(-1)!.db;
    };
    const fade = (x: number) => Math.min(1, a.fadeIn ? x / a.fadeIn : 1, a.fadeOut ? (len - x) / a.fadeOut : 1);
    const keys = [...times].sort((x, y) => x - y).map(x => ({ when: inF + Math.min(f(x), c.end - c.start - 1), value: dbToVolume(a.gainDb + duckAt(x)) * Math.max(0, fade(x)) }))
      .filter((k, i, all) => i === 0 || k.when !== all[i - 1]!.when);
    const factor = Math.max(1, ...keys.map(k => k.value / MAX_LEVEL));
    if (factor > 1) {
      const db = Math.round(20 * Math.log10(factor) * 10) / 10;
      extraMarkers.push({ frame: c.start, name: "Audio gain", note: `${c.itemId}: add +${db} dB with Audio Gain (XML levels stop at +12 dB)` });
      notes.push({ itemId: c.itemId, note: `gain above +12 dB: written at +12 dB, marker says how much to add` });
    }
    const scaled = keys.map(k => ({ when: k.when, value: +(k.value / factor).toFixed(4) }));
    if (scaled.every(k => Math.abs(k.value - 1) < 1e-4)) return "";
    return scaled.some(k => k.value !== scaled[0]!.value) ? levelFilter(scaled[0]!.value, scaled) : levelFilter(scaled[0]!.value, []);
  };

  const transitionXml = (c: ExportClip, mediaType: "video" | "audio") => {
    const half = Math.floor(c.transition!.frames / 2);
    const name = mediaType === "video" ? "Cross Dissolve" : "Cross Fade (+3dB)";
    const id = mediaType === "video" ? "Cross Dissolve" : "KGAudioTransCrossFade3dB";
    if (c.transition!.kind !== "crossfade" && mediaType === "video") notes.push({ itemId: c.itemId, note: `${c.transition!.kind} written as a cross dissolve` });
    return `<transitionitem><start>${c.start - half}</start><end>${c.start - half + c.transition!.frames}</end><alignment>center</alignment>${rateXml(rate)}`
      + `<effect><name>${name}</name><effectid>${id}</effectid><effectcategory>${mediaType === "video" ? "Dissolve" : "crossfade"}</effectcategory><effecttype>transition</effecttype><mediatype>${mediaType}</mediatype></effect></transitionitem>`;
  };

  const tracks = (kind: "video" | "audio") => (kind === "video" ? t.video : t.audio).map((tr, ti) => {
    const items = tr.clips.map((c, k) => {
      const s = src.get(c.sourceId)!, { inF, len, lo, hi } = span(c, s), id = `${kind[0]}${ti + 1}-${k + 1}`;
      const prev = tr.clips[k - 1];
      const tx = c.transition && prev && prev.end === c.start ? transitionXml(c, kind) : "";
      const speed = c.speed !== 1 && s.kind !== "image" ? speedFilter(c.speed, kind, inF, c.end - c.start, lo, hi, len, fileFrames(s)) : "";
      const body = kind === "video"
        ? speed + videoFilters(c, s, inF)
        : `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` + speed + audioFilters(c, inF);
      return tx + clipItem(id, c, s, inF, len, body);
    }).join("");
    return `<track>${items}</track>`;
  }).join("");

  const video = tracks("video"), audio = tracks("audio");
  const markers = [
    ...t.markers.map(m => ({ frame: m.frame, name: m.name, note: m.kind === "chapter" ? "chapter" : m.note ?? "" })),
    ...titleMarkers(t).map(m => ({ frame: m.frame, name: m.name, note: `title: ${m.note}` })),
    ...extraMarkers,
  ].sort((a, b) => a.frame - b.frame)
    .map(m => `<marker><name>${esc(m.name)}</name><comment>${esc(m.note)}</comment><in>${m.frame}</in><out>-1</out></marker>`).join("");

  const fmt = `<format><samplecharacteristics>${rateXml(rate)}<width>${t.canvas.width}</width><height>${t.canvas.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>`;
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="sequence-1"><name>${esc(t.name)}</name><duration>${t.duration}</duration>${rateXml(rate)}`
    + `<in>-1</in><out>-1</out><media><video>${fmt}${video}</video><audio><numOutputChannels>2</numOutputChannels>${audio}</audio></media>`
    + markers + `</sequence></xmeml>\n`;
  return { text, notes };
}
