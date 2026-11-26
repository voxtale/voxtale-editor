// Editor state rules (docs/agentic-video-editor-plan.md §9): clips, edits,
// revisions, graphics and renders, and how each job moves them. Written once
// against two ports, so the same rules run in Convex (cloud) and in the local
// engine (VoxTale Desktop with no cloud). No node imports: Convex bundles this.
// Auth, entitlements and job claims stay with the caller.
import { STYLE_PRESETS } from "@voxtale/editdoc";
import type { ProjectSources } from "./project";

// ---- rows and ports ---------------------------------------------------------

export type ClipKind = "video" | "audio" | "image";
export type ClipStatus = "uploading" | "queued" | "indexed" | "failed";
export type EditStatus = "planning" | "ready" | "failed";
export type VideoJobType = "video-index" | "video-plan" | "video-agent" | "video-graphic" | "video-render";
/** Jobs that plan an edit. video-agent: the cloud agent editor, on its own worker pool. */
export type PlanJobType = "video-plan" | "video-agent";
export const PLAN_JOBS: readonly VideoJobType[] = ["video-plan", "video-agent"];

export interface ClipSource { key: string; size: number; uploadId?: string; status: "uploading" | "ready" }

export interface ClipRow {
  id: string; owner: string; hash: string; name: string; kind: ClipKind; duration: number;
  /** ClipIngest (@voxtale/editdoc), validated by the API layer. */
  ingest: any;
  status: ClipStatus; indexJobId?: string; indexKey?: string; transcriptKey?: string;
  roleGuess?: string; promptVersion?: string; overrides?: unknown; error?: string; source?: ClipSource;
}

export interface EditRow {
  id: string; owner: string; name: string; clipHashes: string[]; status: EditStatus;
  /** Latest EditDoc revision in storage. */
  revision: number; docKey?: string; jobId?: string; instruction?: string; targetDuration?: number;
  style?: string; notes?: string[]; error?: string;
  /** The creator's brand kit, laid over the preset whenever a plan picks a fresh look. */
  brand?: BrandKit;
  /** The VoxTale web project this edit is for; its plan reaches the agent. */
  projectId?: string;
}

/** A creator's brand kit: what `withBrand` (@voxtale/editdoc) lays over a preset. */
export interface BrandKit {
  colors?: Partial<Record<"primary" | "accent" | "background" | "text", string>>;
  fonts?: Partial<Record<"heading" | "body", string>>;
}

export interface VersionRow { editId: string; owner: string; revision: number; key: string; source: "agent" | "creator"; stage?: string }

export type DecisionAction = "kept" | "changed" | "deleted" | "accepted" | "rejected";
export interface DecisionInput {
  itemId: string; track: string; stage?: string; action: DecisionAction;
  fromRevision: number; toRevision: number; changedFields?: string[]; prompts?: string[];
}
export interface DecisionRow extends DecisionInput { editId: string; owner: string }

export interface GraphicRow {
  id: string; owner: string; editId: string; assetId: string;
  /** Counts renders: new props bump it and render the same source again. */
  revision: number; readyRevision?: number; status: "queued" | "ready" | "failed";
  request: any; tokens: any; props?: unknown; jsonSchema?: string; hasSource: boolean;
  jobId?: string; problem?: string; costUsd?: number;
}

export interface RenderRow {
  id: string; owner: string; editId: string; createdAt: number; revision: number; docKey: string;
  status: "queued" | "ready" | "failed"; jobId?: string; outputKey?: string;
  frames?: number; duration?: number; bytes?: number; skipped?: { itemId: string; reason: string }[]; error?: string;
}

export interface JobInfo { status: string; progress?: unknown }
/** A job as its runner sees it. The caller has checked the claim. */
export interface JobRef { id: string; type: string; owner: string; payload: any }

type New<T> = Omit<T, "id">;
type Patch<T> = Partial<Omit<T, "id" | "owner">>;

/**
 * Rows by owner. `undefined` in a patch clears the field. Lookups by id
 * return null for an id that is malformed or names another table.
 */
export interface EditorStore {
  clip(owner: string, hash: string): Promise<ClipRow | null>;
  clips(owner: string): Promise<ClipRow[]>;
  insertClip(row: New<ClipRow>): Promise<string>;
  patchClip(id: string, patch: Patch<ClipRow>): Promise<void>;
  edit(id: string): Promise<EditRow | null>;
  insertEdit(row: New<EditRow>): Promise<string>;
  patchEdit(id: string, patch: Patch<EditRow>): Promise<void>;
  insertVersion(row: VersionRow): Promise<void>;
  insertDecision(row: DecisionRow): Promise<void>;
  /** Newest revision first. */
  decisions(editId: string, limit: number): Promise<DecisionRow[]>;
  graphic(id: string): Promise<GraphicRow | null>;
  graphicByAsset(owner: string, assetId: string): Promise<GraphicRow | null>;
  graphics(editId: string): Promise<GraphicRow[]>;
  insertGraphic(row: New<GraphicRow>): Promise<string>;
  patchGraphic(id: string, patch: Patch<GraphicRow>): Promise<void>;
  render(id: string): Promise<RenderRow | null>;
  /** Newest first. */
  renders(editId: string, limit: number): Promise<RenderRow[]>;
  insertRender(row: New<RenderRow>): Promise<string>;
  patchRender(id: string, patch: Patch<RenderRow>): Promise<void>;
  job(id: string): Promise<JobInfo | null>;
  /** The owner's web project, or null when it is not theirs or gone. Absent = no web projects here (the desktop's local engine). */
  project?(owner: string, projectId: string): Promise<ProjectSources | null>;
  /** The owner's edits for a project, newest first. */
  projectEdits?(owner: string, projectId: string, limit: number): Promise<(EditRow & { createdAt: number })[]>;
}

/**
 * Queue a job. `amount` is meter units (undefined = the type's default,
 * 0 = charge nothing). The cloud queue gates and meters here and throws
 * code PLAN_LIMIT when the plan is used up; the local queue never refuses.
 */
export interface JobQueue {
  enqueue(job: { type: VideoJobType; owner: string; payload: Record<string, string>; amount?: number }): Promise<string>;
}

// ---- errors -------------------------------------------------------------------

/** Codes that mean "not yours or gone", as opposed to a bad request. */
export const ACCESS_CODES = new Set(["NOT_FOUND", "STALE_CLAIM", "STALE_UPLOAD"]);

export class EditorError extends Error {
  constructor(readonly code: string, message?: string, readonly details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "EditorError";
  }
}

const fail = (code: string, details?: Record<string, unknown>): never => { throw new EditorError(code, undefined, details); };

/** Code of an EditorError or of a Convex error's data. */
export function errorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; data?: { code?: unknown } } | null;
  const code = e instanceof EditorError ? e.code : e?.data?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

// ---- keys -----------------------------------------------------------------------

export const STYLE_IDS = Object.keys(STYLE_PRESETS);

/** File types a clip's full source may have (cloud render). */
export const SOURCE_EXTS = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mxf", "mts", "m2ts", "mp3", "wav", "m4a", "aac", "flac", "ogg", "png", "jpg", "jpeg", "webp"];

/** Storage prefix of a clip's uploads and index. */
export const clipPrefix = (owner: string, hash: string) => `users/${owner}/video/clips/${hash}/`;
export const editPrefix = (owner: string, editId: string) => `users/${owner}/video/edits/${editId}/`;
/** Agent revisions. Creator revisions add a nonce, since two saves may race for one number. */
export const editRevisionKey = (owner: string, editId: string, revision: number) => `${editPrefix(owner, editId)}rev-${revision}.json`;
export const creatorRevisionKey = (docKey: string, revision: number, nonce: string) =>
  `${docKey.slice(0, docKey.lastIndexOf("/") + 1)}rev-${revision}-c${nonce}.json`;
export const graphicPrefix = (owner: string, editId: string, assetId: string) => `${editPrefix(owner, editId)}graphics/${assetId}/`;
export const clipSourceKey = (owner: string, hash: string, ext: string) => `${clipPrefix(owner, hash)}source.${ext}`;
/** Result files of one agent frame call, uploaded by the creator's desktop. */
export const frameCallPrefix = (owner: string, callId: string) => `users/${owner}/video/frame-calls/${callId}/`;
export const renderKey = (owner: string, editId: string, renderId: string) => `${editPrefix(owner, editId)}renders/${renderId}.mp4`;

// ---- views ----------------------------------------------------------------------

const HASH = /^[0-9a-f]{64}$/;
export const ASSET_ID = /^ga-[0-9a-f]{24}$/;
const MAX_CLIPS = 200;
const MAX_SOURCE_BYTES = 200 * 1024 ** 3;
const tooBig = (x: unknown, chars: number) => JSON.stringify(x ?? null).length > chars;

export function clipView(clip: ClipRow) {
  const { ingest: _ingest, owner: _owner, source, ...rest } = clip;
  return { ...rest, prefix: clipPrefix(clip.owner, clip.hash), source: source ?? null };
}
export type ClipView = ReturnType<typeof clipView>;

export function graphicView(row: GraphicRow) {
  const { owner: _o, tokens: _t, jobId: _j, costUsd: _c, request, ...rest } = row;
  return { ...rest, kind: request?.kind as string | undefined, title: request?.title as string | undefined,
    prefix: graphicPrefix(row.owner, row.editId, row.assetId) };
}
export type GraphicView = ReturnType<typeof graphicView>;

export function renderView(row: RenderRow, job: JobInfo | null) {
  const { owner: _o, docKey: _d, jobId: _j, ...rest } = row;
  const p = job?.progress as { stage?: string; detail?: { fraction?: number } } | undefined;
  const progress = row.status === "queued" && job ? { job: job.status, stage: p?.stage ?? null, fraction: p?.detail?.fraction ?? null } : null;
  // The row stays queued until the job finishes; say "rendering" once a worker holds it.
  const status = row.status === "queued" && (job?.status === "claimed" || job?.status === "running") ? "rendering" as const : row.status;
  return { ...rest, status, progress };
}
export type RenderView = ReturnType<typeof renderView>;

const BRAND_COLORS = ["primary", "accent", "background", "text"] as const;
const BRAND_FONTS = ["heading", "body"] as const;

/** A kit with only known keys, #RRGGBB colours and font names; undefined when empty. */
function checkBrand(brand: BrandKit | undefined): BrandKit | undefined {
  if (brand === undefined) return undefined;
  const colors: NonNullable<BrandKit["colors"]> = {}, fonts: NonNullable<BrandKit["fonts"]> = {};
  for (const [k, v] of Object.entries(brand.colors ?? {})) {
    if (!BRAND_COLORS.includes(k as never) || typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) fail("INVALID_BRAND");
    colors[k as keyof typeof colors] = v.toUpperCase();
  }
  for (const [k, v] of Object.entries(brand.fonts ?? {})) {
    if (!BRAND_FONTS.includes(k as never) || typeof v !== "string" || !v.trim() || v.trim().length > 80) fail("INVALID_BRAND");
    fonts[k as keyof typeof fonts] = v.trim();
  }
  const kit = { ...(Object.keys(colors).length ? { colors } : {}), ...(Object.keys(fonts).length ? { fonts } : {}) };
  return Object.keys(kit).length ? kit : undefined;
}

function checkStyle(id: string | undefined): boolean {
  if (id === undefined) return false;
  if (!STYLE_IDS.includes(id)) fail("INVALID_STYLE");
  return true;
}

function checkDuration(seconds: number | undefined): boolean {
  if (seconds === undefined) return false;
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 4 * 3600) fail("INVALID_DURATION");
  return true;
}

// ---- creator side ---------------------------------------------------------------

export interface CreateEditArgs { name: string; clipHashes: string[]; instruction?: string; targetDuration?: number; style?: string; brand?: BrandKit; projectId?: string }
export interface ReplanArgs { editId: string; instruction?: string; targetDuration?: number; style?: string; clipHashes?: string[] }

export interface UserOpsOptions {
  /** Which job plans an edit; default video-plan. */
  planJob?: PlanJobType;
}

/** What one creator may do. Every method checks the rows are theirs. */
export function userOps(store: EditorStore, queue: JobQueue, owner: string, o: UserOpsOptions = {}) {
  const planJob = o.planJob ?? "video-plan";
  async function ownedClip(hash: string) {
    if (!HASH.test(hash)) fail("INVALID_HASH");
    return store.clip(owner, hash);
  }
  async function ownedEdit(editId: string) {
    const row = await store.edit(editId);
    if (!row || row.owner !== owner) fail("NOT_FOUND");
    return row!;
  }
  async function ownedProject(projectId: string) {
    if (!store.project || !(await store.project(owner, projectId))) fail("NOT_FOUND");
  }
  async function indexedClips(hashes: string[]) {
    if (!hashes.length || hashes.length > MAX_CLIPS) fail("INVALID_CLIPS");
    for (const hash of hashes) {
      const clip = await ownedClip(hash);
      if (!clip) fail("NOT_FOUND");
      if (clip!.status !== "indexed") fail("CLIP_NOT_INDEXED", { hash });
    }
  }

  return {
    /**
     * Create or refresh the row for an uploaded clip. Same hash = same bytes,
     * so an indexed clip stays indexed and the desktop skips its upload.
     */
    async registerClip(args: { hash: string; name: string; kind: ClipKind; duration: number; ingest: any }) {
      const existing = await ownedClip(args.hash);
      if (existing && (existing.status === "indexed" || existing.status === "queued")) {
        // Same bytes, so only measurements added since can differ: take a
        // loudness the first ingest did not have (clips indexed before P6).
        if (args.ingest?.loudness && !existing.ingest?.loudness)
          await store.patchClip(existing.id, { ingest: { ...existing.ingest, loudness: args.ingest.loudness } });
        return { ...clipView(existing), upload: false };
      }
      const row = { hash: args.hash, name: args.name.slice(0, 260), kind: args.kind, duration: args.duration,
        ingest: args.ingest, status: "uploading" as const, error: undefined };
      if (existing) await store.patchClip(existing.id, row);
      else await store.insertClip({ owner, ...row });
      return { ...clipView((await ownedClip(args.hash))!), upload: true };
    },

    /** Queue indexing once the uploads are in. Meters footage by started minute. */
    async startIndex(hash: string) {
      const clip = await ownedClip(hash);
      if (!clip) return fail("NOT_FOUND");
      if (clip.status === "queued" || clip.status === "indexed") return clipView(clip);
      const jobId = await queue.enqueue({ type: "video-index", owner, amount: Math.ceil(clip.duration / 60),
        payload: { clipHash: hash, prefix: clipPrefix(owner, hash) } });
      await store.patchClip(clip.id, { status: "queued", indexJobId: jobId, error: undefined });
      return clipView((await ownedClip(hash))!);
    },

    async clip(hash: string) {
      const row = await ownedClip(hash);
      return row ? clipView(row) : null;
    },

    /** Creator corrections; the API layer validates them against indexOverridesSchema. */
    async setOverrides(hash: string, overrides: unknown) {
      const row = await ownedClip(hash);
      if (!row) fail("NOT_FOUND");
      await store.patchClip(row!.id, { overrides });
    },

    /** A new edit from indexed clips; queues the first plan. */
    async createEdit(args: CreateEditArgs) {
      await indexedClips(args.clipHashes);
      if (args.projectId) await ownedProject(args.projectId);
      const brand = checkBrand(args.brand);
      const editId = await store.insertEdit({
        owner, name: args.name.slice(0, 200), clipHashes: args.clipHashes, status: "planning", revision: 0,
        ...(args.instruction ? { instruction: args.instruction.slice(0, 4000) } : {}),
        ...(checkDuration(args.targetDuration) ? { targetDuration: args.targetDuration } : {}),
        ...(checkStyle(args.style) ? { style: args.style } : {}),
        ...(brand ? { brand } : {}),
        ...(args.projectId ? { projectId: args.projectId } : {}),
      });
      const jobId = await queue.enqueue({ type: planJob, owner, payload: { editId } });
      await store.patchEdit(editId, { jobId });
      return editId;
    },

    edit: ownedEdit,

    /**
     * The project's plan as the editor reads it (ProjectSources), for an edit
     * cut elsewhere: the desktop's local engine. A script blob key outside the
     * owner's own files is dropped.
     */
    async projectSources(projectId: string): Promise<ProjectSources> {
      const src = store.project ? await store.project(owner, projectId) : null;
      if (!src) return fail("NOT_FOUND");
      const key = src.material?.blobKey;
      if (key && (!key.startsWith(`users/${owner}/`) || key.includes(".."))) {
        const { blobKey: _, ...material } = src.material!;
        return { ...src, material };
      }
      return src;
    },

    /** The project's edits, newest first. */
    async projectEdits(projectId: string) {
      await ownedProject(projectId);
      return (await store.projectEdits?.(owner, projectId, 50)) ?? [];
    },

    /** Run the agent again over the latest revision, creator changes included. */
    async replanEdit(args: ReplanArgs) {
      const row = await ownedEdit(args.editId);
      if (row.status === "planning") fail("EDIT_BUSY");
      const hashes = args.clipHashes ?? row.clipHashes;
      await indexedClips(hashes);
      const style = checkStyle(args.style), duration = checkDuration(args.targetDuration);
      const jobId = await queue.enqueue({ type: planJob, owner, payload: { editId: row.id } });
      await store.patchEdit(row.id, {
        status: "planning", jobId, error: undefined, clipHashes: [...new Set(hashes)],
        ...(args.instruction !== undefined ? { instruction: args.instruction.slice(0, 4000) || undefined } : {}),
        ...(duration ? { targetDuration: args.targetDuration } : {}),
        ...(style ? { style: args.style } : {}),
      });
      return jobId;
    },

    /**
     * Record a creator revision the API layer already validated and stored at
     * `key`. Anything newer than `baseRevision` is a conflict the desktop
     * resolves by pulling first.
     */
    async commitCreatorRevision(args: { editId: string; baseRevision: number; key: string; decisions: DecisionInput[] }) {
      const row = await ownedEdit(args.editId);
      if (row.status === "planning") fail("EDIT_BUSY");
      if (args.baseRevision !== row.revision) fail("REVISION_CONFLICT", { revision: row.revision });
      if (!args.key.startsWith(editPrefix(owner, row.id)) || args.decisions.length > 5000) fail("NOT_FOUND");
      const revision = row.revision + 1;
      await store.insertVersion({ editId: row.id, owner, revision, key: args.key, source: "creator" });
      for (const d of args.decisions) {
        if (d.toRevision !== revision) continue;
        await store.insertDecision({ editId: row.id, owner, ...d, itemId: d.itemId.slice(0, 200), track: d.track.slice(0, 40) });
      }
      await store.patchEdit(row.id, { revision, docKey: args.key, status: "ready", error: undefined });
      return revision;
    },

    /** Creator decisions on one edit, newest revision first. */
    async decisions(editId: string) {
      await ownedEdit(editId);
      return store.decisions(editId, 2000);
    },

    // ---- full clip files, for cloud render ----

    /** A multipart upload of the clip's full file started (or resumed). */
    async beginClipSource(args: { hash: string; ext: string; size: number; uploadId: string }) {
      const clip = await ownedClip(args.hash);
      if (!clip) fail("NOT_FOUND");
      if (!SOURCE_EXTS.includes(args.ext) || !Number.isInteger(args.size) || args.size < 1 || args.size > MAX_SOURCE_BYTES) fail("INVALID_SOURCE");
      const key = clipSourceKey(owner, args.hash, args.ext);
      await store.patchClip(clip!.id, { source: { key, size: args.size, uploadId: args.uploadId, status: "uploading" } });
      return key;
    },

    /** The parts add up; the file is whole. */
    async clipSourceReady(args: { hash: string; uploadId: string }) {
      const clip = await ownedClip(args.hash);
      if (!clip?.source || clip.source.uploadId !== args.uploadId) return fail("STALE_UPLOAD");
      await store.patchClip(clip.id, { source: { key: clip.source.key, size: clip.source.size, status: "ready" } });
    },

    async dropClipSource(hash: string) {
      const clip = await ownedClip(hash);
      if (!clip) fail("NOT_FOUND");
      await store.patchClip(clip!.id, { source: undefined });
    },

    /**
     * Queue a render of the edit's latest revision. The caller read that
     * revision's doc for its length and clips. A render of the same revision
     * already queued or done comes back instead of a second charge.
     */
    async startRender(args: { editId: string; revision: number; seconds: number; clipHashes: string[] }) {
      const row = await ownedEdit(args.editId);
      if (row.status === "planning") fail("EDIT_BUSY");
      if (!row.docKey || args.revision !== row.revision) fail("REVISION_CONFLICT", { revision: row.revision });
      if (!Number.isFinite(args.seconds) || args.seconds <= 0 || args.seconds > 4 * 3600) fail("INVALID_DURATION");
      if (args.clipHashes.length > MAX_CLIPS) fail("INVALID_CLIPS");
      const missing: string[] = [];
      for (const hash of new Set(args.clipHashes)) {
        const clip = await ownedClip(hash);
        if (!clip) fail("NOT_FOUND");
        if (clip!.source?.status !== "ready") missing.push(hash);
      }
      if (missing.length) fail("SOURCE_MISSING", { hashes: missing });
      const same = (await store.renders(row.id, 20)).find(r => r.revision === row.revision && r.status !== "failed");
      if (same) return same.id;
      const renderId = await store.insertRender({ owner, editId: row.id, createdAt: Date.now(), revision: row.revision, docKey: row.docKey!, status: "queued" });
      const jobId = await queue.enqueue({ type: "video-render", owner, amount: Math.ceil(args.seconds / 60), payload: { renderId } });
      await store.patchRender(renderId, { jobId, outputKey: renderKey(owner, row.id, renderId) });
      return renderId;
    },

    /** Renders of one edit, newest first, with live job progress. */
    async renders(editId: string) {
      await ownedEdit(editId);
      const rows = await store.renders(editId, 10);
      return Promise.all(rows.map(async r => renderView(r, r.jobId ? await store.job(r.jobId) : null)));
    },

    async render(renderId: string) {
      const row = await store.render(renderId);
      if (!row || row.owner !== owner) return fail("NOT_FOUND");
      return renderView(row, row.jobId ? await store.job(row.jobId) : null);
    },

    // ---- graphics ----

    /** Every graphic on an edit. */
    async graphics(editId: string) {
      await ownedEdit(editId);
      return (await store.graphics(editId)).slice(0, 500).map(graphicView);
    },

    /**
     * New values for a graphic: the same source renders again with no model
     * call, so it is not charged. The graphic's own schema checks the values
     * in the sandbox; a failure keeps the last good render.
     */
    async setGraphicProps(args: { editId: string; assetId: string; props: unknown }) {
      await ownedEdit(args.editId);
      const row = await store.graphicByAsset(owner, args.assetId);
      if (!row || row.editId !== args.editId) return fail("NOT_FOUND");
      if (row.status === "queued") fail("GRAPHIC_BUSY");
      if (!row.hasSource) fail("GRAPHIC_NOT_READY");
      if (typeof args.props !== "object" || args.props === null || Array.isArray(args.props) || tooBig(args.props, 16000)) fail("INVALID_PROPS");
      const jobId = await queue.enqueue({ type: "video-graphic", owner, amount: 0, payload: { graphicId: row.id } });
      const revision = row.revision + 1;
      await store.patchGraphic(row.id, { revision, props: args.props, status: "queued", jobId, problem: undefined });
      return { revision };
    },
  };
}
export type UserOps = ReturnType<typeof userOps>;

// ---- worker side -----------------------------------------------------------------

/** `rendered`: the plan job already stored r0.webm under the graphic's prefix (agent planner); no render job. */
export interface PlannedGraphic { assetId: string; request: unknown; tokens: unknown; rendered?: boolean }
export interface GraphicResult { revision: number; ok: boolean; problem?: string; props?: unknown; jsonSchema?: string; hasSource: boolean; costUsd?: number }
export interface RenderResult { frames: number; duration: number; bytes: number; skipped: { itemId: string; reason: string }[] }

/** What jobs read and report. The caller checked the job is claimed by it. */
export function workerOps(store: EditorStore, queue: JobQueue) {
  const typed = (job: JobRef, type: VideoJobType) => { if (job.type !== type) fail("NOT_FOUND"); };
  async function indexedClip(job: JobRef) {
    typed(job, "video-index");
    const hash = String(job.payload?.clipHash);
    const clip = HASH.test(hash) ? await store.clip(job.owner, hash) : null;
    if (!clip || clip.indexJobId !== job.id) return fail("STALE_CLAIM");
    return clip;
  }
  async function plannedEdit(job: JobRef) {
    if (!PLAN_JOBS.includes(job.type as VideoJobType)) fail("NOT_FOUND");
    const edit = await store.edit(String(job.payload?.editId));
    if (!edit || edit.owner !== job.owner || edit.jobId !== job.id) return fail("STALE_CLAIM");
    return edit;
  }
  async function claimedGraphic(job: JobRef) {
    typed(job, "video-graphic");
    const row = await store.graphic(String(job.payload?.graphicId));
    if (!row || row.owner !== job.owner || row.jobId !== job.id) return fail("STALE_CLAIM");
    return row;
  }
  async function claimedRender(job: JobRef) {
    typed(job, "video-render");
    const row = await store.render(String(job.payload?.renderId));
    if (!row || row.owner !== job.owner || row.jobId !== job.id || !row.outputKey) return fail("STALE_CLAIM");
    return row;
  }

  return {
    /** What an index job needs: the clip row (for role and overrides). */
    async indexInput(job: JobRef) {
      const clip = await indexedClip(job);
      return { ...clip, prefix: clipPrefix(clip.owner, clip.hash) };
    },

    async clipIndexed(job: JobRef, args: { roleGuess: string; promptVersion: string; transcribed?: boolean }) {
      const clip = await indexedClip(job);
      const prefix = clipPrefix(clip.owner, clip.hash);
      await store.patchClip(clip.id, {
        status: "indexed", indexKey: `${prefix}index.json`,
        transcriptKey: (args.transcribed ?? clip.ingest?.hasAudio) ? `${prefix}transcript.json` : undefined,
        roleGuess: args.roleGuess, promptVersion: args.promptVersion, error: undefined,
      });
    },

    /** What a plan job needs: the edit, its clips, and where to write. */
    async planInput(job: JobRef) {
      const edit = await plannedEdit(job);
      const clips = [];
      for (const hash of edit.clipHashes) {
        const clip = await store.clip(edit.owner, hash);
        if (!clip?.indexKey) return fail("CLIP_NOT_INDEXED");
        clips.push({ ...clip, prefix: clipPrefix(clip.owner, clip.hash) });
      }
      const revision = edit.revision + 1;
      // A project deleted since the edit began just leaves the agent without it.
      const project = edit.projectId ? await store.project?.(edit.owner, edit.projectId) ?? null : null;
      return { edit, clips, revision, docKey: editRevisionKey(edit.owner, edit.id, revision), ...(project ? { project } : {}) };
    },

    async planReady(job: JobRef, args: { revision: number; stage?: string; notes?: string[]; graphics?: PlannedGraphic[] }) {
      const edit = await plannedEdit(job);
      if (args.revision !== edit.revision + 1) fail("STALE_CLAIM");
      const key = editRevisionKey(edit.owner, edit.id, args.revision);
      await store.insertVersion({ editId: edit.id, owner: edit.owner, revision: args.revision, key, source: "agent", ...(args.stage ? { stage: args.stage } : {}) });
      const notes = (args.notes ?? []).slice(0, 20).map(n => n.slice(0, 500));
      // New graphics queue on the render box. A graphic the edit already has
      // (same asset id) keeps its render; one that failed to write gets another try.
      let blocked = false;
      for (const g of (args.graphics ?? []).slice(0, 20)) {
        if (!ASSET_ID.test(g.assetId) || tooBig(g.request, 8000) || tooBig(g.tokens, 4000)) continue;
        const row = await store.graphicByAsset(edit.owner, g.assetId);
        if (g.rendered) {
          // No source to re-render from, so its props cannot be edited.
          if (!row) await store.insertGraphic({ owner: edit.owner, editId: edit.id, assetId: g.assetId, revision: 0, readyRevision: 0,
            status: "ready", request: g.request, tokens: g.tokens, hasSource: false });
          continue;
        }
        if (row && (row.editId !== edit.id || row.status !== "failed" || row.hasSource)) continue;
        const id = row?.id ?? await store.insertGraphic({ owner: edit.owner, editId: edit.id, assetId: g.assetId, revision: 0,
          status: "queued", request: g.request, tokens: g.tokens, hasSource: false });
        try {
          const jobId = await queue.enqueue({ type: "video-graphic", owner: edit.owner, payload: { graphicId: id } });
          await store.patchGraphic(id, { status: "queued", jobId, problem: undefined });
        } catch (error) {
          const limit = errorCode(error) === "PLAN_LIMIT";
          await store.patchGraphic(id, { status: "failed", problem: limit ? "You have used this month's graphics." : "This graphic could not be queued." });
          blocked ||= limit;
        }
      }
      if (blocked) notes.push("Some graphics were not made: you have used this month's graphics.");
      await store.patchEdit(edit.id, { status: "ready", revision: args.revision, docKey: key, error: undefined, notes });
    },

    /** What a graphic job needs: the request, the style tokens, and what exists already. */
    async graphicInput(job: JobRef) {
      const row = await claimedGraphic(job);
      return { assetId: row.assetId, revision: row.revision, request: row.request, tokens: row.tokens, props: row.props ?? null,
        hasSource: row.hasSource, prefix: graphicPrefix(row.owner, row.editId, row.assetId) };
    },

    async graphicDone(job: JobRef, args: GraphicResult) {
      const row = await claimedGraphic(job);
      if (row.revision !== args.revision) fail("STALE_CLAIM");
      const costUsd = (row.costUsd ?? 0) + (args.costUsd ?? 0);
      if (args.ok) await store.patchGraphic(row.id, { status: "ready", readyRevision: args.revision, hasSource: true, problem: undefined, costUsd,
        ...(args.props !== undefined && !tooBig(args.props, 16000) ? { props: args.props } : {}),
        ...(args.jsonSchema !== undefined && args.jsonSchema.length <= 32000 ? { jsonSchema: args.jsonSchema } : {}) });
      // A failed re-render keeps the last good one; the props go back to what it shows.
      else await store.patchGraphic(row.id, { status: row.readyRevision !== undefined ? "ready" : "failed", hasSource: row.hasSource || args.hasSource,
        problem: (args.problem ?? "The graphic could not be made.").slice(0, 600), costUsd,
        ...(row.readyRevision !== undefined ? { revision: row.readyRevision } : {}) });
    },

    /** What a render job needs: the doc, every clip's full file and the ready graphics. */
    async renderInput(job: JobRef) {
      const row = await claimedRender(job);
      const clips = await store.clips(row.owner);
      const graphics = await store.graphics(row.editId);
      return {
        docKey: row.docKey, outputKey: row.outputKey!,
        sources: clips.flatMap(c => c.source?.status === "ready" ? [{ hash: c.hash, key: c.source.key, size: c.source.size }] : []),
        graphics: graphics.flatMap(g => g.readyRevision !== undefined ? [{ assetId: g.assetId, key: `${graphicPrefix(g.owner, g.editId, g.assetId)}r${g.readyRevision}.webm` }] : []),
      };
    },

    async renderDone(job: JobRef, args: RenderResult) {
      const row = await claimedRender(job);
      await store.patchRender(row.id, { status: "ready", frames: args.frames, duration: args.duration, bytes: args.bytes,
        skipped: args.skipped.slice(0, 200), error: undefined });
    },

    /** Uploaded files whose bytes do not hash to their clip: the desktop must send them again. */
    async dropSources(job: JobRef, hashes: string[]) {
      typed(job, "video-render");
      for (const hash of hashes.slice(0, MAX_CLIPS)) {
        const clip = HASH.test(hash) ? await store.clip(job.owner, hash) : null;
        if (clip?.source) await store.patchClip(clip.id, { source: undefined });
      }
    },

    /** A job failed or its worker died: its row says so. */
    async jobFailed(job: JobRef, error: string) {
      if (job.type === "video-index") {
        const hash = String(job.payload?.clipHash);
        const clip = HASH.test(hash) ? await store.clip(job.owner, hash) : null;
        if (clip?.indexJobId === job.id) await store.patchClip(clip.id, { status: "failed", error });
      } else if (job.type === "video-graphic") {
        const row = await store.graphic(String(job.payload?.graphicId));
        // A failed props re-render keeps the last good render on screen.
        if (row?.jobId === job.id) await store.patchGraphic(row.id, { status: row.readyRevision !== undefined ? "ready" : "failed", problem: error.slice(0, 600),
          ...(row.readyRevision !== undefined ? { revision: row.readyRevision } : {}) });
      } else if (job.type === "video-render") {
        const row = await store.render(String(job.payload?.renderId));
        if (row?.jobId === job.id && row.status === "queued") await store.patchRender(row.id, { status: "failed", error: error.slice(0, 600) });
      } else if (PLAN_JOBS.includes(job.type as VideoJobType)) {
        const edit = await store.edit(String(job.payload?.editId));
        // A failed new cut leaves the last good revision in place: the edit
        // stays ready, and `error` tells the creator the new cut did not happen.
        if (edit?.jobId === job.id && edit.status === "planning") await store.patchEdit(edit.id, { status: edit.docKey ? "ready" : "failed", error });
      }
    },
  };
}
export type WorkerOps = ReturnType<typeof workerOps>;
