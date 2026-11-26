// Debug traces for editor jobs: every model call (prompt id and version,
// model, input, output, usage), every artifact a stage writes, and progress,
// in the order they happened. The job runner saves one JSON file per job next
// to the clip or edit it worked on; the desktop's debug panel reads them back.
// Off unless the caller asks: traces hold whole prompts and transcripts.
import { promptForText } from "../../services/prompts";
import type { Planner } from "../pipeline";
import type { VisionModel } from "../footage-index";
import type { GraphicWriter } from "../graphics/make";
import type { CutMap } from "../cut-map";
import type { AgentTrace } from "./agent/steps";

export interface TracePrompt { id: string; version: number; hash: string }

export interface TraceStep {
  n: number;
  /** ms from job start. */
  at: number;
  /** How long a model call took. */
  ms?: number;
  kind: "model" | "artifact" | "progress";
  name: string;
  model?: string;
  prompt?: TracePrompt;
  /** Prompts carried inside the input (repair or length notes). */
  alsoPrompts?: TracePrompt[];
  system?: string;
  input?: unknown;
  output?: unknown;
  usage?: unknown;
  costUsd?: number;
  error?: string;
}

export interface JobTrace {
  version: 1;
  job: { id: string; type: string };
  subject: { clipHash?: string; clipName?: string; editId?: string; revision?: number; assetId?: string };
  startedAt: number;
  finishedAt?: number;
  status: "running" | "done" | "failed";
  error?: string;
  steps: TraceStep[];
  cutMap?: CutMap;
  /** The agent planner's run, one step per tool call (the desktop's step view). */
  agent?: AgentTrace;
}

export interface TraceRecorder {
  /** Where the trace is saved, and what it is about; set once the job knows. */
  at(key: string, subject: JobTrace["subject"]): void;
  readonly key: string | undefined;
  planner(p: Planner): Planner;
  vision(v: VisionModel): VisionModel;
  writer(w: GraphicWriter): GraphicWriter;
  /** A model call made outside the three seams (transcription). */
  call<T>(name: string, model: string, input: unknown, fn: () => Promise<T>, output: (r: T) => unknown): Promise<T>;
  artifact(name: string, value: unknown): void;
  progress(message: string, detail?: unknown): void;
  cutMap(map: CutMap): void;
  agent(run: AgentTrace): void;
  finish(error?: unknown): JobTrace;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 4000);

/** Registered prompt texts nested in a planner input (repair and length notes). */
function nestedPrompts(input: unknown, depth = 0): TracePrompt[] {
  if (typeof input === "string") return input.length >= 80 ? [promptForText(input)].filter((p): p is TracePrompt => p !== null) : [];
  if (depth > 2 || !input || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.values(input).flatMap(v => nestedPrompts(v, depth + 1));
}

export function traceRecorder(job: { id: string; type: string }, now: () => number = Date.now): TraceRecorder {
  const startedAt = now();
  const trace: JobTrace = { version: 1, job: { id: job.id, type: job.type }, subject: {}, startedAt, status: "running", steps: [] };
  let key: string | undefined;
  // A stage saves each model response as an artifact too; that name labels the model step instead.
  const byResult = new WeakMap<object, TraceStep>();
  const push = (s: Omit<TraceStep, "n" | "at">, at = now()) => {
    const step = { n: trace.steps.length + 1, at: at - startedAt, ...s } as TraceStep;
    trace.steps.push(step);
    return step;
  };
  async function model<T>(base: Omit<TraceStep, "n" | "at" | "kind">, fn: () => Promise<T>, read: (r: T) => Partial<TraceStep>): Promise<T> {
    const t0 = now();
    try {
      const r = await fn();
      const step = push({ kind: "model", ...base, ...read(r), ms: now() - t0 }, t0);
      if (r && typeof r === "object") byResult.set(r as object, step);
      return r;
    } catch (error) {
      push({ kind: "model", ...base, error: message(error), ms: now() - t0 }, t0);
      throw error;
    }
  }
  const named = (system: string, fallback: string) => {
    const prompt = promptForText(system);
    return { name: prompt?.id ?? fallback, ...(prompt ? { prompt } : {}), system };
  };
  return {
    at(k, subject) { key = k; trace.subject = { ...trace.subject, ...subject }; },
    get key() { return key; },
    planner: p => (system, input, schema) => {
      const also = nestedPrompts(input);
      return model({ ...named(system, "planner"), input, ...(also.length ? { alsoPrompts: also } : {}) }, () => p(system, input, schema), r => {
        const usage = r.usage as { cost?: unknown } | null;
        return { model: r.model, output: r.plan, usage, ...(typeof usage?.cost === "number" ? { costUsd: usage.cost } : {}) };
      });
    },
    vision: v => (system, parts) => model({
      ...named(system, "vision"),
      input: parts.map(p => p.type === "text" ? p.text : { image: `${Math.round(p.jpeg.byteLength / 1024)} KB jpeg` }),
    }, () => v(system, parts), r => ({ model: r.model, output: r.json, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) })),
    writer: w => messages => {
      const system = messages.find(m => m.role === "system")?.content ?? "";
      return model({ ...named(system, "writer"), input: messages.filter(m => m.role !== "system") },
        () => w(messages), r => ({ model: r.model, output: r.text, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) }));
    },
    call: (name, m, input, fn, output) => model({ name, model: m, input }, fn, r => ({ output: output(r) })),
    artifact(name, value) {
      const step = value && typeof value === "object" ? byResult.get(value as object) : undefined;
      if (step) { step.name = name; return; }
      push({ kind: "artifact", name, output: value });
    },
    progress(msg, detail) { push({ kind: "progress", name: msg, ...(detail === undefined ? {} : { output: detail }) }); },
    cutMap(map) { trace.cutMap = map; },
    agent(run) { trace.agent = run; },
    finish(error) {
      trace.finishedAt = now();
      trace.status = error === undefined ? "done" : "failed";
      if (error !== undefined) trace.error = message(error);
      return trace;
    },
  };
}
