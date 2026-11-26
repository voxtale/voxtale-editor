// Agentic video editor jobs (docs/agentic-video-editor-plan.md §9): index a
// clip, plan an edit, make a graphic, render an edit. Callers pass the row
// reads and writes (WorkerOps, in-process or over Convex) and storage, so the
// same runners serve the cloud worker and the desktop's local engine.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STYLE_PRESETS, withBrand, applyIndexOverrides, renderClipHashes, clipIndexSchema, clipIngestSchema, clipRefSchema, parseEditDoc, stillName,
  type EditDoc, type IndexOverrides,
} from "@voxtale/editdoc";
import { indexClip, indexPromptVersion, locateFaces, type FaceFinder, type VisionModel } from "../footage-index";
import { planStoryEdit, type StoryClip } from "../story-edit";
import type { Planner } from "../pipeline";
import { transcriptSchema, type Transcript } from "../transcript-model";
import { graphicRequestSchema, makeGraphic, rerenderGraphic, type GraphicRequest, type GraphicWriter } from "../graphics/make";
import { graphicTokens, type GraphicTokens } from "../graphics/tokens";
import { dockerRenderer, sandboxReady, type GraphicRenderer } from "../graphics/render";
import { askPlanner, askVision, askWriter } from "../openrouter";
import { transcribeAudio } from "../transcript";
import { renderEditDoc } from "../render-edit";
import { nativeFaceFinder } from "../../native/bridge";
import { graphicPrefix, type BrandKit, type JobRef, type WorkerOps } from "./state";
import { traceRecorder, type TraceRecorder } from "./trace";
import { projectBrief, type ProjectBrief, type ProjectSources } from "./project";
import { cutMap, type TakeRemoval } from "../cut-map";
import { denseMoments, freshMoments, type ClipMoments } from "../moments";
import { agentClipHashes, musicClipHashes, graphicsReady, planWithAgent, type AgentPlan, type AgentPlanInput, type UnderstandClip, type AgentRunner, type AgentStep, type FrameHost, type HtmlRenderer } from "./agent/plan";
import { ff } from "./agent/look";

export interface VideoStorage {
  download(key: string, localPath: string): Promise<void>;
  bytes(key: string): Promise<Uint8Array>;
  put(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
}

export interface VideoIndexDeps {
  clip(): Promise<{ hash: string; name: string; prefix: string; ingest: unknown; overrides?: unknown }>;
  /** `transcribed`: whether transcript.json was written (music and effects skip it). */
  indexed(roleGuess: string, promptVersion: string, transcribed: boolean): Promise<void>;
  storage: VideoStorage;
  progress(stage: string, detail?: unknown): Promise<void>;
  /** Model seams for tests; default to the real providers. */
  vision?: VisionModel;
  transcribe?: typeof transcribeAudio;
  /** false skips the face search (no Python on this machine). */
  faces?: FaceFinder | false;
  trace?: TraceRecorder;
}

async function scratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  // Renders hold whole clips: VIDEO_SCRATCH_DIR points at a disk with room.
  const dir = await mkdtemp(join(process.env.VIDEO_SCRATCH_DIR || tmpdir(), "voxtale-video-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Transcribe (when the clip has speech), label every segment, store both. */
export async function runVideoIndexJob(deps: VideoIndexDeps): Promise<{ segments: number; missing: number; costUsd?: number }> {
  const clip = await deps.clip();
  const ingest = clipIngestSchema.parse(clip.ingest);
  const t = deps.trace;
  t?.at(`${clip.prefix}trace/`, { clipHash: clip.hash, clipName: ingest.name });
  const transcriptKey = `${clip.prefix}transcript.json`;
  // Music and effects carry no words worth paying to transcribe.
  const speech = ingest.hasAudio && ingest.role !== "music" && ingest.role !== "sfx";
  const transcript = speech ? await scratch(async dir => {
    await deps.progress("transcribing");
    const audio = join(dir, "audio.flac");
    await deps.storage.download(`${clip.prefix}audio.flac`, audio);
    const run = () => (deps.transcribe ?? transcribeAudio)(audio, join(dir, "transcript.json"), { name: ingest.name, hash: ingest.hash, duration: ingest.duration });
    const words = await (t ? t.call("transcribe", "assemblyai", { name: ingest.name, duration: ingest.duration }, run,
      r => ({ words: r.words.length, text: r.words.map(w => w.text).join(" ") })) : run());
    await deps.storage.put(transcriptKey, JSON.stringify(words), "application/json");
    return words;
  }) : null;
  await deps.progress("indexing", { segments: ingest.segments.length });
  let done = 0;
  const still = (id: string, i: number) => deps.storage.bytes(`${clip.prefix}${stillName(id, i)}`);
  let index = await indexClip({
    ingest,
    words: transcript?.words ?? [],
    still,
    ...(transcript ? { transcriptRef: "transcript.json" } : {}),
  }, t ? t.vision(deps.vision ?? askVision) : deps.vision ?? askVision, { progress: message => { t?.progress(message); done++; if (done % 5 === 0) void deps.progress("indexing", { message }); } });
  // Face boxes only steer zoom focus; without them zooms centre on the frame.
  if (deps.faces !== false) try { index = await locateFaces(index, { ingest, still }, deps.faces ?? nativeFaceFinder); }
  catch (error) { t?.artifact("faces-error", String(error).slice(0, 1000)); console.warn(`[video-index] face search failed for ${ingest.name}: ${String(error).slice(0, 200)}`); }
  t?.artifact("index", { roleGuess: index.roleGuess, summary: index.summary, segments: index.segments.length, missing: index.missing });
  await deps.storage.put(`${clip.prefix}index.json`, JSON.stringify(index), "application/json");
  await deps.indexed(applyIndexOverrides(index, clip.overrides as IndexOverrides | undefined).roleGuess, indexPromptVersion(), transcript !== null);
  return { segments: index.segments.length, missing: index.missing.length, ...(index.costUsd !== undefined ? { costUsd: index.costUsd } : {}) };
}

export interface VideoPlanDeps {
  edit(): Promise<{
    edit: { id: string; owner?: string; name: string; instruction?: string; targetDuration?: number; style?: string; brand?: BrandKit; docKey?: string; revision: number; projectId?: string };
    clips: { hash: string; prefix: string; ingest: unknown; overrides?: unknown; indexKey?: string; transcriptKey?: string }[];
    revision: number;
    docKey: string;
    /** The web project the edit is for, when it has one. */
    project?: ProjectSources;
  }>;
  /** `stage`: "story" (the story stages) or "agent" (an agent harness). */
  ready(revision: number, notes: string[], graphics: PlannedGraphicRequest[], stage: "story" | "agent"): Promise<void>;
  storage: VideoStorage;
  progress(stage: string, detail?: unknown): Promise<void>;
  /** Plan with an agent harness instead of the story stages (desktop only: it needs the full clip files). */
  agent?: AgentPlanOptions;
  planner?: Planner;
  vision?: VisionModel;
  /** Plan generated graphics: only where a render box takes video-graphic jobs. */
  graphics?: boolean;
  trace?: TraceRecorder;
}

/** `rendered`: the agent planner already stored r0.webm; no graphic job. */
export type PlannedGraphicRequest =
  | { assetId: string; request: GraphicRequest; tokens: GraphicTokens }
  | { assetId: string; request: AgentGraphicRequest; tokens: GraphicTokens; rendered: true };

export interface AgentGraphicRequest { agent: true; id: string; seconds: number }

export interface AgentPlanOptions {
  runner: AgentRunner;
  /** Full file path per clip hash on this machine; null when it is not here. */
  sources?(hashes: string[]): Promise<Record<string, string | null>>;
  /**
   * Where frames come from when the files are elsewhere (a cloud run asks the
   * creator's desktop). `dir`: this run's scratch folder. Wins over `sources`.
   */
  frames?(dir: string): FrameHost;
  /** Renders agent graphics; default: Docker with the engine VOXTALE_GRAPHICS_RENDERER picks (Remotion unless set to hyperframes). */
  html?: HtmlRenderer;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}

const json = async (storage: VideoStorage, key: string) => JSON.parse(new TextDecoder().decode(await storage.bytes(key)));

/** The project brief, with an uploaded script read from storage. A script that will not read just goes without. */
async function briefFor(deps: VideoPlanDeps, edit: { owner?: string; projectId?: string }, src: ProjectSources | undefined): Promise<ProjectBrief | undefined> {
  if (!src || !edit.projectId) return undefined;
  const m = src.material;
  if (m && !m.text && m.blobKey && m.kind === "script" && edit.owner && m.blobKey.startsWith(`users/${edit.owner}/`) && !m.blobKey.includes("..")) {
    const text = await deps.storage.bytes(m.blobKey).then(b => new TextDecoder().decode(b.slice(0, 64_000)), () => undefined);
    return projectBrief(edit.projectId, { ...src, material: { ...m, ...(text ? { text } : {}) } });
  }
  return projectBrief(edit.projectId, src);
}

/**
 * P3: every chosen clip through the story stages (takes, structure, assembly,
 * text). A replan starts from the latest revision, which may be the
 * creator's, and keeps its clip ids so creator items still point at them.
 */
export async function runVideoPlanJob(deps: VideoPlanDeps): Promise<{ revision: number; docKey: string; notes: string[]; graphics: number }> {
  const { edit, clips, revision, docKey, project: projectRows } = await deps.edit();
  const project = await briefFor(deps, edit, projectRows);
  const t = deps.trace;
  t?.at(`${docKey.slice(0, docKey.lastIndexOf("/") + 1)}trace/`, { editId: edit.id, revision });
  const previous: EditDoc | undefined = edit.docKey && edit.revision > 0
    ? parseEditDoc(await json(deps.storage, edit.docKey)).doc : undefined;
  const taken = new Set(previous?.clips.map(c => c.id));
  let next = 1;
  const freshId = () => { while (taken.has(`c${next}`)) next++; taken.add(`c${next}`); return `c${next}`; };
  const story: StoryClip[] = [];
  const prefixes = new Map<string, string>();
  for (const c of clips) {
    const ingest = clipIngestSchema.parse(c.ingest);
    const index = applyIndexOverrides(clipIndexSchema.parse(await json(deps.storage, c.indexKey!)), c.overrides as IndexOverrides | undefined);
    const role = ingest.role ?? index.roleGuess;
    const id = previous?.clips.find(p => p.hash === ingest.hash)?.id ?? freshId();
    prefixes.set(id, c.prefix);
    // Music and effects have no transcript, whatever an older row says.
    const words = c.transcriptKey && role !== "music" && role !== "sfx";
    const transcript: Transcript | undefined = words ? transcriptSchema.parse(await json(deps.storage, c.transcriptKey!)) : undefined;
    story.push({
      index, ...(transcript ? { transcript } : {}),
      ref: clipRefSchema.parse({
        id, hash: ingest.hash, name: ingest.name, kind: ingest.kind, role,
        roleSource: ingest.role ? "creator" : "index", duration: ingest.duration,
        ...(ingest.fps ? { fps: ingest.fps } : {}), ...(ingest.width ? { width: ingest.width, height: ingest.height } : {}),
        hasAudio: ingest.hasAudio, timecodeStart: ingest.timecodeStart, indexRef: `${c.prefix}index.json`,
        ...(ingest.loudness ? { loudness: ingest.loudness } : {}),
      }),
    });
  }
  await deps.progress("planning", { clips: story.length, replan: Boolean(previous) });
  t?.artifact("input", { instruction: edit.instruction ?? null, targetDuration: edit.targetDuration ?? null, style: edit.style ?? null, replanOf: previous?.revision ?? null, project: project ?? null,
    clips: story.map(c => ({ id: c.ref.id, name: c.ref.name, role: c.ref.role, duration: c.ref.duration, words: c.transcript?.words.length ?? 0 })) });
  // A new preset resets the look; otherwise a replan keeps the creator's tuned look and mix.
  const kept = previous && (!edit.style || edit.style === previous.styleRef.id) ? previous : undefined;
  let fallback: string | undefined;
  if (deps.agent) {
    const look = kept ? { style: kept.styleRef.snapshot, mix: kept.mix } : undefined;
    const done = await runAgentPlan(deps, deps.agent, { edit, story, prefixes, revision, docKey, replan: Boolean(previous), ...(previous ? { previous } : {}), ...(look ? { look } : {}), ...(project ? { project } : {}) });
    if (typeof done !== "string") return done;
    fallback = done;
  }
  const takes = new Map<string, TakeRemoval[]>();
  const planner = deps.planner ?? askPlanner, vision = deps.vision ?? askVision;
  const { doc, notes, graphics } = await planStoryEdit({
    id: edit.id, name: edit.name, clips: story, revision,
    ...(edit.instruction ? { instruction: edit.instruction } : {}),
    ...(edit.targetDuration ? { targetDuration: edit.targetDuration } : {}),
    ...(!kept && (edit.style || edit.brand) ? { style: freshStyle(edit) } : {}),
    ...(previous ? { previous } : {}),
    ...(deps.graphics ? { graphics: true } : {}),
    planner: t ? t.planner(planner) : planner,
    look: {
      vision: t ? t.vision(vision) : vision,
      still: (clipId, segment, i) => deps.storage.bytes(`${prefixes.get(clipId)}${stillName(segment, i)}`),
    },
    output: {
      write: async (name, value) => {
        const clipId = name.endsWith("-take-removals") ? name.slice(0, -"-take-removals".length) : null;
        if (clipId) takes.set(clipId, value as TakeRemoval[]);
        t?.artifact(name, value);
      },
      progress: message => { t?.progress(message); void deps.progress("planning", { message }); },
    },
  });
  t?.cutMap(cutMap(doc, story.flatMap(c => c.transcript ? [{
    clipId: c.ref.id, name: c.ref.name, duration: c.ref.duration, words: c.transcript.words, shots: c.index?.segments ?? [],
  }] : []), takes));
  await deps.storage.put(docKey, JSON.stringify(doc), "application/json");
  const tokens = graphicTokens(doc.styleRef.snapshot);
  const requests = [...graphics].map(([assetId, request]) => ({ assetId, request, tokens }));
  await deps.ready(revision, [...(fallback ? [fallback] : []), ...notes], requests, "story");
  return { revision, docKey, notes, graphics: requests.length };
}

/** The edit's preset (calm explainer if none), with the creator's brand kit laid over it. */
function freshStyle(edit: { style?: string; brand?: BrandKit }) {
  const preset = edit.style && edit.style in STYLE_PRESETS ? STYLE_PRESETS[edit.style as keyof typeof STYLE_PRESETS] : STYLE_PRESETS["calm-explainer"];
  return edit.brand ? withBrand(preset, edit.brand) : preset;
}

const AGENT_FALLBACK = "Planned without the agent editor: some clips are not on this computer.";
const AGENT_OFFLINE = "Planned without the agent editor: VoxTale was not open on your computer, or could not find the clips there.";

/**
 * Asks the frame host for one frame of every clip, so a run never starts
 * without its footage. Null when all answered; else why not.
 */
export async function framesReachable(host: FrameHost, hashes: string[]): Promise<string | null> {
  if (!hashes.length) return null;
  const pairs = hashes.map((h, k) => ({ a: { clip: h, t: 0 }, b: { clip: hashes[k + 1] ?? h, t: 0 } }));
  try {
    for (let k = 0; k < pairs.length; k += 30) await host.joins(pairs.slice(k, k + 30));
    return null;
  } catch (error) {
    return String(error instanceof Error ? error.message : error).slice(0, 300);
  }
}

/**
 * Moments for each footage clip, cached beside the clip's other derived files
 * and redone only when the moments prompt changes. A clip that fails keeps its
 * index; the edit goes on.
 */
async function understandFootage(deps: VideoPlanDeps, prefixes: Map<string, string>, clips: UnderstandClip[], host: FrameHost): Promise<Record<string, ClipMoments>> {
  const t = deps.trace, vision = deps.vision ?? askVision, model = t ? t.vision(vision) : vision;
  const out: Record<string, ClipMoments> = {};
  for (const [k, c] of clips.entries()) {
    const prefix = prefixes.get(c.id);
    const key = prefix ? `${prefix}moments/dense.json` : undefined;
    const cached = key ? await json(deps.storage, key).then(x => freshMoments(x, c.hash), () => undefined) : undefined;
    if (cached) { out[c.id] = cached; continue; }
    const say = (message: string) => { t?.progress(message); void deps.progress("planning", { message: `Understanding footage ${k + 1}/${clips.length}: ${message}` }); };
    try {
      const m = await denseMoments({ hash: c.hash, duration: c.duration, words: c.words, frames: host }, model, { progress: say });
      if (key) await deps.storage.put(key, JSON.stringify(m), "application/json");
      t?.artifact(`${c.id}-moments`, m);
      out[c.id] = m;
    } catch (error) {
      t?.progress(`moments for ${c.id} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  return out;
}

/** What a replan kept of the creator's own work in the last version. */
function keptNote(doc: EditDoc): string {
  const n = [...Object.values(doc.tracks).flat(), ...doc.markers].filter(i => i.owner === "creator").length;
  return n ? `The agent replanned the edit and kept your own changes from the last version (${n} item${n === 1 ? "" : "s"}).`
    : "The agent planned from scratch: its own edits to the last version are not carried over.";
}

/** The agent planner. A note instead when its footage is out of reach, so the story stages plan instead. */
async function runAgentPlan(deps: VideoPlanDeps, a: AgentPlanOptions, o: {
  edit: Awaited<ReturnType<VideoPlanDeps["edit"]>>["edit"]; story: StoryClip[]; prefixes: Map<string, string>; revision: number; docKey: string; replan: boolean;
  look?: AgentPlanInput["look"]; project?: ProjectBrief; previous?: EditDoc;
}): Promise<{ revision: number; docKey: string; notes: string[]; graphics: number } | string> {
  const { edit, story, revision, docKey } = o;
  const t = deps.trace;
  // Music is asked for too: with the file here, code finds its beat. A plan does not need it.
  const found = a.frames || !a.sources ? {} : await a.sources([...agentClipHashes(story), ...musicClipHashes(story)]);
  const sources = Object.fromEntries(Object.entries(found).flatMap(([hash, path]) => path ? [[hash, path]] : []));
  if (!a.frames && agentClipHashes(story).some(hash => !sources[hash])) return AGENT_FALLBACK;
  const graphicsOn = Boolean(deps.graphics) && Boolean(edit.owner);
  const dir = await mkdtemp(join(tmpdir(), "voxtale-agent-plan-"));
  const frames = a.frames?.(join(dir, "looks"));
  if (frames) {
    await deps.progress("planning", { message: "Reaching your computer for the footage" });
    const why = await framesReachable(frames, agentClipHashes(story));
    if (why) {
      t?.progress(`frames out of reach: ${why}`);
      await rm(dir, { recursive: true, force: true });
      return AGENT_OFFLINE;
    }
  }
  const log: string[] = [];
  const steps: AgentStep[] = [];
  let run: AgentPlan["run"] | undefined;
  try {
    const plan = await planWithAgent({
      steps,
      id: edit.id, name: edit.name, revision, clips: story, sources, graphics: graphicsOn, runner: a.runner, workspace: dir,
      ...(edit.style ? { style: edit.style } : {}), ...(edit.brand ? { brand: edit.brand } : {}), ...(o.look ? { look: o.look } : {}), ...(o.previous ? { previous: o.previous } : {}),
      ...(edit.targetDuration ? { targetDuration: edit.targetDuration } : {}),
      ...(edit.instruction ? { instruction: edit.instruction } : {}), ...(o.project ? { project: o.project } : {}),
      ...(a.html ? { html: a.html } : {}), ...(frames ? { frames } : {}),
      understand: (clips, host) => understandFootage(deps, o.prefixes, clips, host),
      ...(a.model ? { model: a.model } : {}), ...(a.maxTurns ? { maxTurns: a.maxTurns } : {}),
      ...(a.maxBudgetUsd ? { maxBudgetUsd: a.maxBudgetUsd } : {}), ...(a.signal ? { signal: a.signal } : {}),
      log: line => {
        log.push(line);
        // One progress line per tool call: enough to show the agent is working.
        if (line.startsWith("call ")) void deps.progress("planning", { message: `Agent: ${line.slice(5, 60)}` });
      },
    });
    run = plan.run;
    t?.artifact("agent-run", { runner: a.runner.name, stop: plan.run.stop, turns: plan.run.turns, costUsd: plan.run.costUsd,
      toolCalls: plan.run.toolCalls, finalText: plan.run.finalText, problems: plan.problems, metrics: plan.metrics });
    // Stored graphics need ids the rows accept, unique per edit and revision.
    const ids = new Map(plan.graphics.map(g => [g.assetId, `ga-${createHash("sha256").update(`${edit.id}:${revision}:${g.assetId}`).digest("hex").slice(0, 24)}`]));
    const doc = { ...plan.doc, tracks: { ...plan.doc.tracks, graphics: plan.doc.tracks.graphics.flatMap(g => {
      const assetId = ids.get(g.assetId);
      // The creator's graphics from the last version keep their stored asset.
      return assetId ? [{ ...g, assetId, assetRevision: 0 }] : g.owner === "creator" ? [g] : [];
    }) } };
    const tokens = graphicTokens(doc.styleRef.snapshot);
    const requests: PlannedGraphicRequest[] = [];
    for (const g of plan.graphics) {
      const assetId = ids.get(g.assetId)!;
      const prefix = graphicPrefix(edit.owner!, edit.id, assetId);
      await deps.storage.put(`${prefix}r0.webm`, new Uint8Array(await readFile(g.webm)), "video/webm");
      // A still for the graphics list; the graphic plays without one.
      const still = join(dir, `${assetId}.jpg`);
      await ff(["-c:v", "libvpx-vp9", "-ss", String(g.seconds / 2), "-i", g.webm, "-frames:v", "1", still])
        .then(async () => deps.storage.put(`${prefix}r0.jpg`, new Uint8Array(await readFile(still)), "image/jpeg"))
        .catch(error => t?.progress(`graphic still failed: ${String(error).slice(0, 200)}`));
      requests.push({ assetId, request: { agent: true, id: g.assetId, seconds: g.seconds }, tokens, rendered: true });
    }
    t?.cutMap(cutMap(doc, story.flatMap(c => c.transcript ? [{
      clipId: c.ref.id, name: c.ref.name, duration: c.ref.duration, words: c.transcript.words, shots: c.index?.segments ?? [],
    }] : []), new Map()));
    await deps.storage.put(docKey, JSON.stringify(doc), "application/json");
    const notes = [
      ...plan.notes,
      ...(o.replan ? [keptNote(doc)] : []),
      ...(deps.graphics && !edit.owner ? ["No motion graphics: this engine cannot store agent graphics."] : []),
    ];
    await deps.ready(revision, notes, requests, "agent");
    return { revision, docKey, notes, graphics: requests.length };
  } finally {
    t?.artifact("agent-log", log);
    t?.agent({ runner: a.runner.name, steps, ...(edit.targetDuration ? { targetSeconds: edit.targetDuration } : {}),
      clips: story.map(c => ({ id: c.ref.id, name: c.ref.name, duration: c.ref.duration, role: c.ref.role })),
      ...(run ? { stop: run.stop, turns: run.turns, costUsd: run.costUsd, finalText: run.finalText } : {}) });
    await rm(dir, { recursive: true, force: true });
  }
}

export interface VideoGraphicDeps {
  graphic(): Promise<{ assetId: string; revision: number; request: unknown; tokens: unknown; props: unknown; hasSource: boolean; prefix: string }>;
  done(result: { revision: number; ok: boolean; problem?: string; props?: unknown; jsonSchema?: string; hasSource: boolean; costUsd?: number }): Promise<void>;
  storage: VideoStorage;
  progress(stage: string, detail?: unknown): Promise<void>;
  write?: GraphicWriter;
  render?: GraphicRenderer;
  vision?: VisionModel;
  trace?: TraceRecorder;
}

/**
 * P5, render box only: a model writes the graphic once and the sandbox
 * renders it; new props later render the same source with no model call.
 * Files: <prefix>source.tsx, r<revision>.webm, r<revision>.jpg. The props
 * schema travels as JSON text: Convex refuses keys like `$schema`.
 */
export async function runVideoGraphicJob(deps: VideoGraphicDeps): Promise<{ ok: boolean; revision: number; costUsd?: number }> {
  const g = await deps.graphic();
  const t = deps.trace;
  t?.at(`${g.prefix}trace/`, { assetId: g.assetId, revision: g.revision });
  const request = graphicRequestSchema.parse(g.request);
  const tokens = g.tokens as GraphicTokens;
  const render = deps.render ?? dockerRenderer();
  const files = async (webm: Uint8Array, still: Uint8Array | undefined) => {
    await deps.storage.put(`${g.prefix}r${g.revision}.webm`, webm, "video/webm");
    if (still) await deps.storage.put(`${g.prefix}r${g.revision}.jpg`, still, "image/jpeg");
  };
  if (g.hasSource && g.props && typeof g.props === "object") {
    await deps.progress("rendering");
    const source = new TextDecoder().decode(await deps.storage.bytes(`${g.prefix}source.tsx`));
    try {
      const out = await rerenderGraphic(source, g.props as Record<string, unknown>, request, tokens, render);
      await files(out.webm!, [...out.stills.values()][0]);
      await deps.done({ revision: g.revision, ok: true, props: out.props ?? undefined, ...(out.jsonSchema ? { jsonSchema: JSON.stringify(out.jsonSchema) } : {}), hasSource: true });
      return { ok: true, revision: g.revision };
    } catch (error) {
      await deps.done({ revision: g.revision, ok: false, problem: error instanceof Error ? error.message : String(error), hasSource: true });
      return { ok: false, revision: g.revision };
    }
  }
  await deps.progress("writing");
  t?.artifact("request", { request, tokens });
  const write = deps.write ?? askWriter, vision = deps.vision ?? askVision;
  const made = await makeGraphic(request, tokens, {
    write: t ? t.writer(write) : write, render, vision: t ? t.vision(vision) : vision,
    log: (step, detail) => { t?.progress(step, detail); void deps.progress(step, detail); },
  });
  if (made.source) t?.artifact("source.tsx", made.source);
  if (made.ok && made.source && made.webm) {
    await deps.storage.put(`${g.prefix}source.tsx`, made.source, "text/plain");
    await files(made.webm, made.still);
  }
  await deps.done({ revision: g.revision, ok: made.ok, hasSource: made.ok,
    ...(made.problem ? { problem: `The graphic could not be made. ${made.problem}` } : {}),
    ...(made.props ? { props: made.props } : {}), ...(made.jsonSchema ? { jsonSchema: JSON.stringify(made.jsonSchema) } : {}), costUsd: made.costUsd });
  return { ok: made.ok, revision: g.revision, costUsd: made.costUsd };
}

export interface VideoRenderDeps {
  render(): Promise<{ docKey: string; outputKey: string; sources: { hash: string; key: string; size: number }[]; graphics: { assetId: string; key: string }[] }>;
  done(result: { frames: number; duration: number; bytes: number; skipped: { itemId: string; reason: string }[] }): Promise<void>;
  /** Uploads whose bytes do not match their clip; the desktop sends them again. */
  dropSources(hashes: string[]): Promise<void>;
  storage: VideoStorage & { upload(localPath: string, key: string, contentType: string): Promise<number> };
  progress(stage: string, detail?: unknown): Promise<void>;
  renderDoc?: typeof renderEditDoc;
}

async function fileHash(path: string): Promise<string> {
  const hasher = createHash("sha256");
  for await (const chunk of createReadStream(path)) hasher.update(chunk as Buffer);
  return hasher.digest("hex");
}

/**
 * P7, render box: the EditDoc rendered from the clips' full files, the same
 * way the desktop export renders it. Graphics still rendering are left out
 * and reported. Each file is checked against its clip hash before use.
 */
export async function runVideoRenderJob(deps: VideoRenderDeps): Promise<{ frames: number; duration: number; bytes: number; skipped: number }> {
  const job = await deps.render();
  const doc = parseEditDoc(await json(deps.storage, job.docKey)).doc;
  const need = renderClipHashes(doc);
  const byHash = new Map(job.sources.map(s => [s.hash, s]));
  const absent = need.filter(h => !byHash.has(h));
  if (absent.length) throw new Error(`${absent.length} clips have no uploaded file. Upload them and render again.`);
  return scratch(async dir => {
    const media: Record<string, string> = {};
    let got = 0;
    const total = need.reduce((sum, h) => sum + byHash.get(h)!.size, 0);
    const bad: string[] = [];
    for (const hash of need) {
      const src = byHash.get(hash)!;
      const path = join(dir, `${hash}.${src.key.split(".").pop()}`);
      await deps.progress("downloading", { fraction: total ? got / total : 0 });
      await deps.storage.download(src.key, path);
      got += src.size;
      if ((await stat(path)).size !== src.size || await fileHash(path) !== hash) bad.push(hash);
      media[hash] = path;
    }
    if (bad.length) {
      await deps.dropSources(bad);
      throw new Error(`${bad.length} uploaded clips do not match the files on your computer. Upload them again.`);
    }
    const graphics: Record<string, string> = {};
    for (const g of job.graphics) {
      if (!doc.tracks.graphics.some(i => i.assetId === g.assetId)) continue;
      const path = join(dir, `${g.assetId}.webm`);
      await deps.storage.download(g.key, path);
      graphics[g.assetId] = path;
    }
    let last = 0;
    const out = join(dir, "render.mp4");
    const result = await (deps.renderDoc ?? renderEditDoc)({
      doc, media, graphics, out, work: join(dir, "work"),
      progress: fraction => {
        if (fraction - last < 0.02 && fraction < 1) return;
        last = fraction;
        void deps.progress("rendering", { fraction });
      },
    });
    await deps.progress("uploading");
    const bytes = await deps.storage.upload(out, job.outputKey, "video/mp4");
    await deps.done({ frames: result.frames, duration: result.duration, bytes, skipped: result.skipped });
    return { frames: result.frames, duration: result.duration, bytes, skipped: result.skipped.length };
  });
}

/** The row side of a job: WorkerOps in-process, or the same calls over Convex. */
export type EditorJobPort = Pick<WorkerOps,
  "indexInput" | "clipIndexed" | "planInput" | "planReady" | "graphicInput" | "graphicDone" | "renderInput" | "renderDone" | "dropSources">;

export interface EditorJobContext {
  port: EditorJobPort;
  storage: VideoRenderDeps["storage"];
  progress(stage: string, detail?: unknown): Promise<void>;
  /**
   * Plan generated graphics: only where something runs video-graphic jobs.
   * "auto": when this machine's Docker has the sandbox image, checked per plan.
   */
  graphics?: boolean | "auto";
  /** false skips the face search. */
  faces?: FaceFinder | false;
  /** Graphic sandbox; defaults to the Docker one. */
  render?: GraphicRenderer;
  /** Save a debug trace of each index, plan and graphic job (prompts, model I/O, cut map). */
  trace?: boolean;
  /** Plan with an agent harness; its graphics use the Remotion (or HyperFrames) sandbox. */
  agent?: AgentPlanOptions;
}

/** Run one editor job against its rows. Throws on failure; the caller marks the job failed. */
export async function runEditorJob(job: JobRef, c: EditorJobContext): Promise<unknown> {
  const trace = c.trace && job.type !== "video-render" ? traceRecorder(job) : undefined;
  if (!trace) return runJob(job, c);
  let failure: unknown;
  try {
    return await runJob(job, c, trace);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // A trace never fails the job it describes.
    if (trace.key) await c.storage.put(`${trace.key}${job.id}.json`, JSON.stringify(trace.finish(failure)), "application/json")
      .catch(error => console.warn(`[editor] trace save failed: ${String(error).slice(0, 200)}`));
  }
}

const GRAPHICS_OFF = "No motion graphics in this cut: they render in Docker, which is not running here (or lacks the voxtale-graphics-sandbox image).";

const GRAPHICS_OFF_AGENT = "No motion graphics in this cut: they render in Docker, which is not running here (or lacks the voxtale-hyperframes-sandbox image).";

function runJob(job: JobRef, c: EditorJobContext, trace?: TraceRecorder): Promise<unknown> {
  const { port, storage, progress } = c;
  const traced = trace ? { trace } : {};
  switch (job.type) {
    case "video-index":
      return runVideoIndexJob({
        clip: () => port.indexInput(job),
        indexed: (roleGuess, promptVersion, transcribed) => port.clipIndexed(job, { roleGuess, promptVersion, transcribed }),
        storage, progress, ...(c.faces !== undefined ? { faces: c.faces } : {}), ...traced,
      });
    case "video-plan":
    case "video-agent":
      return (async () => {
        const graphics = c.graphics === "auto" ? await (c.agent ? (c.agent.html || c.agent.frames ? true : graphicsReady()) : sandboxReady()) : Boolean(c.graphics);
        const off = c.graphics === "auto" && !graphics ? [c.agent ? GRAPHICS_OFF_AGENT : GRAPHICS_OFF] : [];
        return runVideoPlanJob({
          edit: () => port.planInput(job),
          ready: (revision, notes, planned, stage) => port.planReady(job, { revision, stage, notes: [...notes, ...off], graphics: planned }),
          storage, progress, graphics, ...(c.agent ? { agent: c.agent } : {}), ...traced,
        });
      })();
    case "video-graphic":
      return runVideoGraphicJob({
        graphic: () => port.graphicInput(job),
        done: result => port.graphicDone(job, result),
        storage, progress, ...(c.render ? { render: c.render } : {}), ...traced,
      });
    case "video-render":
      return runVideoRenderJob({
        render: () => port.renderInput(job),
        done: result => port.renderDone(job, result),
        dropSources: hashes => port.dropSources(job, hashes),
        storage, progress,
      });
  }
  return Promise.reject(new Error(`Not an editor job: ${job.type}`));
}
