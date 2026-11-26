// The editor on one machine: the same rules (./state), API (./api) and job
// runners (./jobs) the cloud serves, over a JSON file, a folder of blobs and
// an in-process job queue. No sign-in, no Convex, no object storage. The
// desktop's local build loads this; model keys come from the environment.
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { editorApi, type EditorApi, type EditorBlobs } from "./api";
import { runEditorJob, type AgentPlanOptions, type EditorJobContext } from "./jobs";
import { emptyData, memoryStore, type EditorData, type LocalJob } from "./memory";
import type { ProjectSources } from "./project";
import { userOps, workerOps, type JobQueue, type UserOps, type WorkerOps } from "./state";
import type { FaceFinder } from "../footage-index";
import type { GraphicRenderer } from "../graphics/render";

/** Agent harnesses for `agent.runner`: the claude and codex CLIs on their own login (dev only). */
export { claudeCliRunner, codexRunner } from "./agent/plan";

export interface LocalEngineOptions {
  /** Holds state.json and blobs/. */
  dir: string;
  /** Owner of every row. */
  owner?: string;
  /** Plan and render generated graphics; they need Docker and the sandbox image. "auto" checks per plan. */
  graphics?: boolean | "auto";
  /** Face search for reframing; off unless given (needs Python). */
  faces?: FaceFinder | false;
  render?: GraphicRenderer;
  /** Jobs run at once. */
  concurrency?: number;
  /** Each job state change, for logs. */
  onJob?: (job: LocalJob) => void;
  /** Save a debug trace per job under its clip or edit (see ./trace). */
  trace?: boolean;
  /** Plan edits with an agent harness (./agent) instead of the story stages. */
  agent?: AgentPlanOptions;
  /**
   * The creator's VoxTale web project by id (GET /api/v1/video/projects/{id}/sources),
   * null when it is not theirs or they are signed out. Absent: edits cannot name a project.
   */
  projects?: (projectId: string) => Promise<ProjectSources | null>;
  /** Job runner seam for tests. */
  runJob?: typeof runEditorJob;
}

export interface RenderEvent { stage: "queued" | "rendering" | "done" | "failed"; fraction: number; detail?: string }

export interface RenderFileOptions {
  revision: number;
  /** Full file per clip hash. */
  sources: Record<string, string>;
  dest: string;
  onEvent?: (e: RenderEvent) => void;
  /** Stops waiting; a render already running still finishes. */
  signal?: AbortSignal;
}

export interface LocalEngine {
  /** What the hosted routes serve, for the one local creator. */
  api: EditorApi;
  /** File path of a blob key. */
  path(key: string): string;
  /** Register an ingested clip, store its files and queue indexing. */
  sendClip(ingest: unknown, dir: string, files: string[], onProgress?: (fraction: number) => void): Promise<{ hash: string; status: string }>;
  /** Render the edit's latest revision from local files into `dest`. */
  renderFile(editId: string, o: RenderFileOptions): Promise<{ renderId: string; skipped: { itemId: string; reason: string }[] }>;
  jobs(): LocalJob[];
  /** Waits for running jobs and the last save. */
  close(): Promise<void>;
}

/** One-at-a-time lock: each rule reads then writes across awaits. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}

function locked<T extends object>(ops: T, lock: ReturnType<typeof serial>): T {
  return Object.fromEntries(Object.entries(ops).map(([k, fn]) =>
    [k, (...args: unknown[]) => lock(() => (fn as (...a: unknown[]) => Promise<unknown>)(...args))])) as T;
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function createLocalEngine(o: LocalEngineOptions): Promise<LocalEngine> {
  const owner = o.owner ?? "local";
  const root = resolve(o.dir);
  const blobDir = join(root, "blobs");
  const stateFile = join(root, "state.json");
  await mkdir(blobDir, { recursive: true });

  const data: EditorData = await readFile(stateFile, "utf8").then(t => ({ ...emptyData(), ...JSON.parse(t) }), () => emptyData());
  // Saves are queued so the newest state always lands last.
  let saving: Promise<void> = Promise.resolve();
  let dirty = false;
  const changed = () => {
    if (dirty) return;
    dirty = true;
    saving = saving.then(async () => {
      dirty = false;
      const tmp = `${stateFile}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, stateFile);
    }).catch(error => console.error("[voxtale] state save failed:", error));
  };
  const mem = memoryStore(data, changed);
  if (o.projects) {
    const fetchProject = o.projects;
    // The last copy fetched stands in when the cloud cannot be reached, so a replan offline keeps the brief.
    mem.store.project = async (_owner, projectId) => {
      let src: ProjectSources | null;
      try { src = await fetchProject(projectId); } catch (error) {
        const kept = data.projects?.[projectId];
        if (kept) return structuredClone(kept);
        throw error;
      }
      if (src) data.projects = { ...data.projects, [projectId]: src };
      else if (data.projects?.[projectId]) delete data.projects[projectId];
      changed();
      return src;
    };
  }

  const path = (key: string) => {
    const file = resolve(blobDir, key);
    if (!file.startsWith(blobDir + sep)) throw new Error(`Bad key ${key}`);
    return file;
  };
  const putFile = async (key: string, body: string | Uint8Array) => {
    const file = path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  };
  const blobs: EditorBlobs = {
    getText: key => readFile(path(key), "utf8").catch(() => null),
    put: (key, body) => putFile(key, body),
    async list(prefix) {
      const base = prefix.endsWith("/") ? path(prefix.slice(0, -1)) : dirname(path(prefix));
      const out: string[] = [];
      const walk = async (dir: string) => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const file = join(dir, e.name);
          if (e.isDirectory()) await walk(file);
          else out.push(relative(blobDir, file).split(sep).join("/"));
        }
      };
      await walk(base);
      return out.filter(k => k.startsWith(prefix));
    },
  };
  const storage: EditorJobContext["storage"] = {
    // Links, not copies: the job only reads, and renders read whole clips.
    async download(key, local) { await symlink(path(key), local); },
    bytes: async key => new Uint8Array(await readFile(path(key))),
    put: (key, body) => putFile(key, body),
    async upload(local, key) {
      await mkdir(dirname(path(key)), { recursive: true });
      await rename(local, path(key)).catch(() => copyFile(local, path(key)));
      return (await stat(path(key))).size;
    },
  };

  const lock = serial();
  const running = new Set<Promise<void>>();
  const waiting: string[] = [];
  const limit = Math.max(1, o.concurrency ?? 2);
  let worker: WorkerOps;
  const report = (id: string) => { const job = mem.getJob(id); if (job) o.onJob?.(structuredClone(job)); };
  const setJob = (id: string, fields: Partial<LocalJob>) => lock(async () => { mem.patchJob(id, fields); report(id); });

  let closed = false;
  function pump() {
    while (!closed && running.size < limit && waiting.length) {
      const id = waiting.shift()!;
      const job = mem.getJob(id);
      if (!job) continue;
      const ref = { id: job.id, type: job.type, owner: job.owner, payload: job.payload };
      const run: Promise<void> = (async () => {
        await setJob(id, { status: "running" });
        try {
          await (o.runJob ?? runEditorJob)(ref, {
            port: worker, storage,
            progress: (stage, detail) => setJob(id, { progress: { stage, ...(detail === undefined ? {} : { detail }) } }),
            graphics: o.graphics ?? false,
            faces: o.faces ?? false,
            ...(o.render ? { render: o.render } : {}),
            ...(o.trace ? { trace: true } : {}),
            ...(o.agent ? { agent: o.agent } : {}),
          });
          await setJob(id, { status: "done" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await worker.jobFailed(ref, message);
          await setJob(id, { status: "failed", error: message.slice(0, 2000) });
        }
      })().finally(() => { running.delete(run); pump(); });
      running.add(run);
    }
  }

  const queue: JobQueue = {
    // Called inside a locked op, so it only records the row; the job starts after.
    async enqueue(job) {
      const id = mem.addJob(job);
      report(id);
      queueMicrotask(() => { waiting.push(id); pump(); });
      return id;
    },
  };
  const ops: UserOps = locked(userOps(mem.store, queue, owner), lock);
  worker = locked(workerOps(mem.store, queue), lock);
  const api = editorApi({ ops, blobs });

  // Jobs cut short by a quit run again.
  for (const job of data.jobs) if (job.status === "queued" || job.status === "running") {
    job.status = "queued";
    waiting.push(job.id);
  }
  changed();
  pump();

  return {
    api, path,

    async sendClip(ingest, dir, files, onProgress) {
      const reg = await api.registerClip(ingest);
      if (reg.upload) {
        for (let i = 0; i < files.length; i += 500) {
          const keys = await api.clipUploadKeys(reg.hash, files.slice(i, i + 500));
          for (const [name, { key }] of Object.entries(keys)) {
            await mkdir(dirname(path(key)), { recursive: true });
            await copyFile(join(dir, name), path(key), constants.COPYFILE_FICLONE);
          }
          onProgress?.(Math.min(1, (i + 500) / files.length));
        }
        return api.completeClip(reg.hash);
      }
      onProgress?.(1);
      return { hash: reg.hash, status: reg.status };
    },

    async renderFile(editId, { revision, sources, dest, onEvent, signal }) {
      const start = () => api.startRender(editId, { revision });
      let renderId: string;
      try {
        ({ renderId } = await start());
      } catch (error) {
        const hashes = (error as { details?: { hashes?: string[] } }).details?.hashes;
        if ((error as { code?: string }).code !== "SOURCE_MISSING" || !hashes) throw error;
        // Locally the clip's full file is the one on disk: link it in place.
        for (const hash of hashes) {
          const file = sources[hash];
          if (!file) throw Object.assign(new Error("A clip in this cut is missing on this computer."), { code: "SOURCE_MISSING", details: { hashes: [hash] } });
          const uploadId = `local-${Date.now()}`;
          const key = await ops.beginClipSource({ hash, ext: extname(file).slice(1).toLowerCase(), size: (await stat(file)).size, uploadId });
          await rm(path(key), { force: true });
          await mkdir(dirname(path(key)), { recursive: true });
          await symlink(resolve(file), path(key));
          await ops.clipSourceReady({ hash, uploadId });
        }
        ({ renderId } = await start());
      }
      for (;;) {
        if (signal?.aborted) throw Object.assign(new Error("Render stopped."), { code: "CANCELLED" });
        const r = await api.render(renderId);
        if (r.status === "ready" && r.outputKey) {
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(path(r.outputKey), dest, constants.COPYFILE_FICLONE);
          onEvent?.({ stage: "done", fraction: 1 });
          return { renderId, skipped: r.skipped ?? [] };
        }
        if (r.status === "failed") {
          onEvent?.({ stage: "failed", fraction: 0, ...(r.error ? { detail: r.error } : {}) });
          throw Object.assign(new Error(r.error ?? "The render failed."), { code: "RENDER_FAILED" });
        }
        const p = r.progress;
        onEvent?.({ stage: r.status === "rendering" ? "rendering" : "queued", fraction: p?.fraction ?? 0, ...(p?.stage ? { detail: p.stage } : {}) });
        await wait(500);
      }
    },

    jobs: () => structuredClone(data.jobs),

    async close() {
      closed = true;
      while (running.size) await Promise.allSettled([...running]);
      await saving;
    },
  };
}
