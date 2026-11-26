// The VoxTale web project an edit belongs to, as the editor sees it: what the
// creator planned (packaging, outline, script) so the cut can deliver it. The
// store hands over raw rows; this file decides what reaches the agent.

/** A project's rows as the store has them. Outline drafts come in any of the shapes the outline tools wrote. */
export interface ProjectSources {
  title: string;
  material?: { kind: "topic" | "script" | "transcript" | "video"; text?: string; blobKey?: string };
  /** The outline to use: the accepted outline-agent version, else the newest one, else the newest outline session version. */
  outline?: unknown;
  /** Packaging options from the newest finished run, best first. */
  packaging?: { title: string; hook?: string; angle?: string }[];
  /** The title the creator logged as published, if any. */
  publishedTitle?: string;
}

export interface ProjectBrief {
  id: string;
  title: string;
  /** `chosen`: the creator published it; otherwise these are ideas, best first. */
  packaging: { title: string; hook?: string; chosen: boolean }[];
  promise?: string;
  beats: { title: string; content: string }[];
  material?: { kind: "topic" | "script"; text: string; truncated: boolean };
}

const clip = (s: unknown, n: number) => typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, n) : "";
const MATERIAL_CHARS = { topic: 800, script: 4000 } as const;

/** Beats and promise from an outline-agent v2 draft ({promise, beats:[{title,content}]}) or a v1 one ({premise, beats:[{beat,content}]}). */
function outlineOf(raw: unknown): Pick<ProjectBrief, "promise" | "beats"> {
  if (!raw || typeof raw !== "object") return { beats: [] };
  const o = raw as { promise?: unknown; premise?: unknown; beats?: unknown };
  const beats = (Array.isArray(o.beats) ? o.beats : []).slice(0, 20).flatMap(b => {
    if (!b || typeof b !== "object") return [];
    const x = b as { title?: unknown; beat?: unknown; content?: unknown };
    const title = clip(x.title ?? x.beat, 120), content = clip(x.content, 300);
    return title || content ? [{ title, content }] : [];
  });
  const promise = clip(o.promise ?? o.premise, 500);
  return { ...(promise ? { promise } : {}), beats };
}

export function projectBrief(id: string, src: ProjectSources): ProjectBrief {
  const options = (src.packaging ?? []).slice(0, 3).map(p => ({ title: clip(p.title, 150), ...(clip(p.hook, 300) ? { hook: clip(p.hook, 300) } : {}) })).filter(p => p.title);
  const published = clip(src.publishedTitle, 150);
  const packaging = published
    ? [{ ...(options.find(p => p.title === published) ?? { title: published }), chosen: true }]
    : options.map(p => ({ ...p, chosen: false }));
  const m = src.material, kind = m?.kind;
  const text = (kind === "topic" || kind === "script") ? (m?.text ?? "").trim() : "";
  return {
    id, title: clip(src.title, 200), packaging, ...outlineOf(src.outline),
    ...(text && (kind === "topic" || kind === "script") ? { material: { kind, text: text.slice(0, MATERIAL_CHARS[kind]), truncated: text.length > MATERIAL_CHARS[kind] } } : {}),
  };
}

/** The brief as task-prompt lines; [] when there is nothing to say beyond the title. */
export function projectLines(b: ProjectBrief): string[] {
  const lines = [`Project "${b.title}" (planned in VoxTale before filming):`];
  const chosen = b.packaging.find(p => p.chosen);
  if (chosen) lines.push(`- Published title: "${chosen.title}"${chosen.hook ? `. Planned hook: ${chosen.hook}` : ""}`);
  else if (b.packaging.length) lines.push(`- Packaging ideas, none chosen yet: ${b.packaging.map(p => `"${p.title}"${p.hook ? ` (hook: ${p.hook})` : ""}`).join("; ")}`);
  if (b.promise) lines.push(`- Promise to the viewer: ${b.promise}`);
  if (b.beats.length) lines.push(`- Outline beats: ${b.beats.map((x, i) => `${i + 1}. ${[x.title, x.content].filter(Boolean).join(": ")}`).join(" ")}`);
  if (b.material) lines.push(`- ${b.material.kind === "topic" ? "Topic" : `Script${b.material.truncated ? " (start)" : ""}`}: ${b.material.text.replace(/\s+/g, " ")}`);
  return lines.length > 1 ? lines : [];
}
