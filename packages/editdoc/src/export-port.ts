// Export port: one interface every editor adapter implements, and the one
// call the tools use. Adapters translate the export timeline (export-model.ts)
// and list what they carry; whatever the edit uses beyond that is reported.
import type { EditDoc } from "./schema";
import { buildExportTimeline, type ExportFeature, type ExportMedia, type ExportTimeline } from "./export-model";
import { toXmeml } from "./xmeml";
import { fcpxmlFromTimeline } from "./fcpxml";
import { otioFromTimeline } from "./otio";

export interface ExportLoss { feature: ExportFeature | "fallback" | "adapter"; items: string[]; note: string }

export interface TimelineExporter {
  target: string;
  app: string;
  format: string;
  extension: string;
  /** Features this adapter writes so the app plays them as the render does. */
  carries: readonly ExportFeature[];
  /** What happens to a feature it does not carry, when that is more than "left out". */
  instead?: Partial<Record<ExportFeature, string>>;
  write(t: ExportTimeline): { text: string; notes?: { itemId: string; note: string }[] };
}

const XMEML_CARRIES: ExportFeature[] = ["layout", "zoom", "crop", "fit", "opacity", "picture-fade", "speed", "dissolve", "gain", "audio-fade", "duck", "graphics", "markers"];
const AS_MARKERS = "written as markers (text, template, length) to rebuild";
const COMMON_INSTEAD: Partial<Record<ExportFeature, string>> = {
  titles: AS_MARKERS,
  look: "not applied; source look noted on the clip",
  "behind-subject": "graphic drawn over the speaker; mask them by hand",
  loudness: "mix loudness and speech cleanup not applied; normalise in the app",
  "caption-look": "captions go out as SRT text, without their style",
};

export const EXPORTERS = {
  premiere: {
    target: "premiere", app: "Adobe Premiere Pro", format: "FCP 7 XML (xmeml v4)", extension: "xml",
    carries: XMEML_CARRIES,
    instead: { ...COMMON_INSTEAD, "transition-other": "written as cross dissolves" },
    write: t => toXmeml(t),
  },
  resolve: {
    target: "resolve", app: "DaVinci Resolve", format: "FCP 7 XML (xmeml v4), Resolve scaling", extension: "xml",
    carries: XMEML_CARRIES,
    instead: { ...COMMON_INSTEAD, "transition-other": "written as cross dissolves" },
    write: t => toXmeml(t, { resolve: true }),
  },
  finalcut: {
    target: "finalcut", app: "Final Cut Pro", format: "FCPXML 1.9", extension: "fcpxml",
    carries: ["layout", "zoom", "crop", "fit", "opacity", "gain", "audio-fade", "graphics", "markers"],
    instead: { ...COMMON_INSTEAD, speed: "plays at normal speed", dissolve: "hard cut", "transition-other": "hard cut", duck: "music at its base level" },
    write: t => ({ text: fcpxmlFromTimeline(t) }),
  },
  otio: {
    target: "otio", app: "OpenTimelineIO (any app; checked in DaVinci Resolve)", format: "OTIO JSON", extension: "otio",
    carries: ["dissolve", "graphics", "markers"],
    instead: {
      ...COMMON_INSTEAD,
      layout: "split / pip layers written but switched off; values in clip metadata",
      zoom: "in clip metadata only", crop: "in clip metadata only", fit: "in clip metadata only", opacity: "in clip metadata only",
      "picture-fade": "in clip metadata only", gain: "in clip metadata only", "audio-fade": "in clip metadata only", duck: "in clip metadata only",
      speed: "plays at normal speed; speed in clip metadata", "transition-other": "custom transition; kind in metadata",
    },
    write: t => ({ text: JSON.stringify(otioFromTimeline(t), null, 2) + "\n" }),
  },
} satisfies Record<string, TimelineExporter>;

export type ExportTarget = keyof typeof EXPORTERS;
export const EXPORT_TARGETS = Object.keys(EXPORTERS) as ExportTarget[];

export interface ExportResult { target: ExportTarget; app: string; format: string; extension: string; text: string; losses: ExportLoss[] }

/** What `exporter` drops from `t`: features it does not carry, the model's own fallbacks, and the adapter's notes. */
export function exportLosses(t: ExportTimeline, exporter: TimelineExporter, notes: { itemId: string; note: string }[] = []): ExportLoss[] {
  const losses: ExportLoss[] = [];
  for (const [feature, items] of Object.entries(t.uses) as [ExportFeature, string[]][]) {
    if (!items.length || exporter.carries.includes(feature)) continue;
    losses.push({ feature, items, note: exporter.instead?.[feature] ?? "left out" });
  }
  for (const w of t.warnings) losses.push({ feature: "fallback", items: [w.itemId], note: w.note });
  const byNote = new Map<string, string[]>();
  for (const n of notes) byNote.set(n.note, [...(byNote.get(n.note) ?? []), n.itemId]);
  for (const [note, items] of byNote) losses.push({ feature: "adapter", items: [...new Set(items)], note });
  return losses;
}

/** The edit for one app: the file's text and what it cannot carry. */
export function exportTimeline(doc: EditDoc, media: ExportMedia, target: ExportTarget): ExportResult {
  const exporter: TimelineExporter = EXPORTERS[target];
  if (!exporter) throw new Error(`Unknown export target ${target}; use ${EXPORT_TARGETS.join(", ")}`);
  const t = buildExportTimeline(doc, media);
  const out = exporter.write(t);
  return { target, app: exporter.app, format: exporter.format, extension: exporter.extension, text: out.text, losses: exportLosses(t, exporter, out.notes) };
}
