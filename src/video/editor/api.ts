// The editor as a request/response API: body validation, the files a clip
// must have before indexing, EditDoc reads and creator revisions. The hosted
// API routes and the desktop's local engine both call these, so a request
// means the same thing in either place. Keys come back as keys; the caller
// turns them into signed URLs or file paths. No node imports.
import { z } from "zod";
import {
  STYLE_PRESETS, applyCreatorRevision, clipIngestSchema, docDuration, indexOverridesSchema, parseEditDoc, renderClipHashes, upgradeEditDoc,
  type ClipIngest,
} from "@voxtale/editdoc";
import type { ProjectSources } from "./project";
import { ASSET_ID, EditorError, clipPrefix, creatorRevisionKey, editPrefix, errorCode, type UserOps } from "./state";
import type { JobTrace } from "./trace";

/** Where the editor keeps its files: object storage in the cloud, a folder locally. */
export interface EditorBlobs {
  getText(key: string): Promise<string | null>;
  put(key: string, body: string, type: string): Promise<void>;
  /** Every key under a prefix. */
  list(prefix: string): Promise<string[]>;
}

export const HASH = /^[0-9a-f]{64}$/;
/** Files the desktop may upload under a clip's prefix. */
export const CLIP_FILE = /^(audio\.flac|stills\/S\d{3,5}-[01]\.jpg)$/;
export const CLIP_FILE_TYPES: Record<string, string> = { flac: "audio/flac", jpg: "image/jpeg" };
const UPLOAD_BATCH = 500;

/** Error code → HTTP status and the message a creator sees. */
export const EDITOR_ERRORS: Record<string, [number, string]> = {
  INVALID_INPUT: [400, "The request does not match the schema."],
  NOT_FOUND: [404, "Item not found."],
  STALE_CLAIM: [409, "This job was replaced."],
  CLIP_NOT_INDEXED: [409, "Index every clip before planning an edit."],
  INVALID_CLIPS: [400, "Pick between 1 and 200 clips."],
  INVALID_HASH: [400, "The clip hash must be 64 lowercase hex characters."],
  FEATURE_LOCKED: [403, "The video editor is not enabled for this account."],
  EDIT_BUSY: [409, "The agent is still working on this edit."],
  REVISION_CONFLICT: [409, "The edit changed since you last pulled it. Pull it first."],
  INVALID_DURATION: [400, "Target length must be between 5 seconds and 4 hours."],
  INVALID_STYLE: [400, "Style must be calm-explainer, fast-paced, podcast or tutorial."],
  INVALID_BRAND: [400, "Brand colours must be #RRGGBB and fonts a name up to 80 characters."],
  GRAPHIC_BUSY: [409, "This graphic is still rendering."],
  GRAPHIC_NOT_READY: [409, "This graphic has not been made yet."],
  INVALID_PROPS: [400, "Send the graphic's values as an object under 16 KB."],
  INVALID_SOURCE: [400, "Send the file's size in bytes and a known media extension."],
  STALE_UPLOAD: [409, "This upload was replaced. Start it again."],
  SOURCE_MISSING: [409, "Upload the full clips before rendering in the cloud."],
  MISSING_UPLOADS: [409, "Some of the clip's files are missing."],
  NOT_UPLOADING: [409, "This clip is already indexed or queued."],
  NOT_READY: [409, "The edit has no cut yet."],
  STALE_CALL: [409, "This frame call lapsed or was answered already."],
  TOO_MANY_CALLS: [429, "Too many frame calls are open for this job."],
};

export interface EditorFailure { status: number; code: string; message: string; details?: Record<string, unknown> }

/**
 * An EditorError, or a Convex error carrying one of its codes, as status +
 * message. Null for anything else: the caller treats it as an internal error.
 */
export function editorFailure(error: unknown): EditorFailure | null {
  const code = errorCode(error);
  if (!code || !EDITOR_ERRORS[code]) return null;
  const [status, fallback] = EDITOR_ERRORS[code];
  let details: Record<string, unknown> | undefined;
  let message = fallback;
  if (error instanceof EditorError) {
    details = error.details;
    if (error.message !== code) message = error.message;
  } else {
    const { kind: _k, code: _c, ...rest } = ((error as { data?: Record<string, unknown> }).data ?? {});
    if (Object.keys(rest).length) details = rest;
  }
  return { status, code, message, ...(details ? { details } : {}) };
}

const bad = (message: string, details?: Record<string, unknown>): never => { throw new EditorError("INVALID_INPUT", message, details); };

function checkHash(hash: string) {
  if (!HASH.test(hash)) bad("The clip hash must be 64 lowercase hex characters.");
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const fontName = z.string().trim().min(1).max(80);
const PROJECT_ID = /^[0-9a-z]{10,64}$/;
const styleId = z.enum(Object.keys(STYLE_PRESETS) as [string, ...string[]]);

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  clipHashes: z.array(z.string().regex(HASH)).min(1).max(200),
  instruction: z.string().trim().max(4000).optional(),
  targetDuration: z.number().min(5).max(4 * 3600).optional(),
  style: styleId.optional(),
  brand: z.object({
    colors: z.object({ primary: hex, accent: hex, background: hex, text: hex }).partial().strict().optional(),
    fonts: z.object({ heading: fontName, body: fontName }).partial().strict().optional(),
  }).strict().optional(),
  /** A VoxTale web project (GET /api/v1/projects). */
  projectId: z.string().regex(PROJECT_ID).optional(),
}).strict();

const replanSchema = z.object({
  instruction: z.string().trim().max(4000).optional(),
  targetDuration: z.number().min(5).max(4 * 3600).optional(),
  style: styleId.optional(),
  clipHashes: z.array(z.string().regex(HASH)).min(1).max(200).optional(),
}).strict();

const ids = z.array(z.string().min(1).max(200)).max(2000);
const change = z.object({ upsert: z.array(z.unknown()).max(5000).optional(), remove: ids.optional() }).strict();
const revisionSchema = z.object({
  baseRevision: z.number().int().min(1),
  accept: ids.optional(),
  reject: ids.optional(),
  patch: z.object({
    tracks: z.record(z.string(), change).optional(),
    markers: change.optional(),
    // Look changes; applyCreatorPatch checks each value against the style and mix schemas.
    style: z.object({
      brand: z.record(z.string(), z.unknown()).optional(),
      pace: z.record(z.string(), z.unknown()).optional(),
      audio: z.record(z.string(), z.unknown()).optional(),
    }).strict().optional(),
    mix: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional(),
}).strict();

const propsSchema = z.object({ props: z.record(z.string().max(80), z.unknown()) }).strict();

export interface EditorApiDeps {
  /** One creator's state operations: in-process locally, a Convex proxy in the cloud. */
  ops: UserOps;
  blobs: EditorBlobs;
  /** Makes creator revision keys unique. */
  nonce?: () => string;
}

/** Everything the desktop asks of the editor, for one creator. */
export function editorApi({ ops, blobs, nonce = () => crypto.randomUUID().slice(0, 8) }: EditorApiDeps) {
  async function json<T>(key: string): Promise<T | null> {
    return JSON.parse((await blobs.getText(key)) ?? "null") as T | null;
  }
  async function existingClip(hash: string, missing: string) {
    checkHash(hash);
    const clip = await ops.clip(hash);
    if (!clip) throw new EditorError("NOT_FOUND", missing);
    return clip;
  }
  async function latestDoc(editId: string) {
    const edit = await ops.edit(editId);
    // Docs stored before a schema bump reach clients upgraded, same as the server reads them.
    return { edit, doc: edit.docKey ? upgradeEditDoc(await json<unknown>(edit.docKey)) : null };
  }

  return {
    /** Register a clip from its ingest (probe + segments). `upload` says whether to send its files. */
    async registerClip(body: unknown) {
      const parsed = clipIngestSchema.safeParse(body);
      if (!parsed.success) return bad("The clip ingest does not match the schema.", { issues: parsed.error.issues.slice(0, 5) });
      const ingest = parsed.data;
      for (const s of ingest.segments) if (s.end <= s.start || s.end > ingest.duration + 0.5) bad(`Segment ${s.id} has bad times.`);
      const clip = await ops.registerClip({ hash: ingest.hash, name: ingest.name, kind: ingest.kind, duration: ingest.duration, ingest });
      if (clip.upload) await blobs.put(`${clip.prefix}ingest.json`, JSON.stringify(ingest), "application/json");
      return { hash: clip.hash, status: clip.status, upload: clip.upload, prefix: clip.prefix };
    },

    /** Where each named upload goes. The clip must still be taking uploads. */
    async clipUploadKeys(hash: string, files: unknown) {
      checkHash(hash);
      const names = Array.isArray(files) ? files : [];
      if (!names.length || names.length > UPLOAD_BATCH || !names.every(f => typeof f === "string" && CLIP_FILE.test(f)))
        bad(`Send 1–${UPLOAD_BATCH} file names: audio.flac or stills/S###-0.jpg.`);
      const clip = await existingClip(hash, "Register the clip first.");
      if (clip.status !== "uploading" && clip.status !== "failed") throw new EditorError("NOT_UPLOADING");
      return Object.fromEntries((names as string[]).map(name => [name, { key: `${clip.prefix}${name}`, type: CLIP_FILE_TYPES[name.split(".").pop()!]! }]));
    },

    /** Uploads are in: check every expected file exists, then queue indexing. */
    async completeClip(hash: string) {
      const clip = await existingClip(hash, "Register the clip first.");
      if (clip.status === "uploading" || clip.status === "failed") {
        const ingest = await json<ClipIngest>(`${clip.prefix}ingest.json`);
        if (!ingest) throw new EditorError("MISSING_UPLOADS", "Register the clip again.");
        const have = new Set((await blobs.list(clip.prefix)).map(k => k.slice(clip.prefix.length)));
        const want = [
          ...(ingest.hasAudio ? ["audio.flac"] : []),
          // Audio clips have no pictures; their segment still times go unused.
          ...(ingest.kind === "audio" ? [] : ingest.segments).flatMap(s => s.stills.map((_, i) => `stills/${s.id}-${i}.jpg`)),
        ];
        const missing = want.filter(name => !have.has(name));
        if (missing.length) throw new EditorError("MISSING_UPLOADS", `${missing.length} files are missing.`, { missing: missing.slice(0, 50) });
      }
      const queued = await ops.startIndex(hash);
      return { hash, status: queued.status };
    },

    /** Clip status, plus its index and overrides once indexed. */
    async clip(hash: string) {
      const clip = await existingClip(hash, "No clip with this hash.");
      const index = clip.status === "indexed" && clip.indexKey ? await json<unknown>(clip.indexKey) : null;
      return { hash, name: clip.name, status: clip.status, error: clip.error ?? null, roleGuess: clip.roleGuess ?? null, index, overrides: clip.overrides ?? null };
    },

    /** Replace the creator's index corrections for a clip. */
    async setOverrides(hash: string, body: unknown) {
      checkHash(hash);
      const parsed = indexOverridesSchema.safeParse(body);
      if (!parsed.success) return bad("The overrides do not match the schema.");
      await ops.setOverrides(hash, parsed.data);
      return { hash, overrides: parsed.data };
    },

    /** Start an edit from indexed clips; the first plan runs as a job. */
    async createEdit(body: unknown) {
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) return bad("Send a name, 1–200 clip hashes, an optional style, brand kit and project id.");
      const editId = await ops.createEdit(parsed.data);
      return { editId, status: "planning" as const };
    },

    /** Edit status, plus the latest EditDoc once a plan is ready. */
    async edit(editId: string) {
      const { edit, doc } = await latestDoc(editId);
      return {
        editId, name: edit.name, status: edit.status, revision: edit.revision, error: edit.error ?? null,
        notes: edit.notes ?? [], instruction: edit.instruction ?? null, targetDuration: edit.targetDuration ?? null,
        style: edit.style ?? null, clipHashes: edit.clipHashes, projectId: edit.projectId ?? null, doc,
      };
    },

    /** Run the agent again from the latest revision; creator items stay as they are. */
    async replan(editId: string, body: unknown) {
      const parsed = replanSchema.safeParse(body ?? {});
      if (!parsed.success) return bad("Send an optional instruction, target length, style or clip list.");
      await ops.replanEdit({ editId, ...parsed.data });
      return { editId, status: "planning" as const };
    },

    /**
     * A creator save: review answers plus hand edits against `baseRevision`.
     * Stored as the next revision with its decision log.
     */
    async saveRevision(editId: string, body: unknown) {
      const parsed = revisionSchema.safeParse(body);
      if (!parsed.success) return bad("Send baseRevision plus accept, reject or patch.");
      const edit = await ops.edit(editId);
      if (edit.status === "planning") throw new EditorError("EDIT_BUSY");
      if (!edit.docKey || parsed.data.baseRevision !== edit.revision)
        throw new EditorError("REVISION_CONFLICT", `The edit is at revision ${edit.revision}. Pull it first.`, { revision: edit.revision });
      const text = await blobs.getText(edit.docKey);
      if (!text) throw new EditorError("REVISION_CONFLICT", "The latest revision is missing.");
      const before = parseEditDoc(JSON.parse(text)).doc;
      let result;
      try {
        result = applyCreatorRevision(before, parsed.data as Parameters<typeof applyCreatorRevision>[1]);
      } catch (error) {
        return bad(`That change does not fit the edit: ${String((error as Error).message ?? error).slice(0, 300)}`);
      }
      const key = creatorRevisionKey(edit.docKey, result.doc.revision, nonce());
      await blobs.put(key, JSON.stringify(result.doc), "application/json");
      const decisions = result.decisions.map(({ stage, changedFields, prompts, ...d }) =>
        ({ ...d, ...(stage ? { stage } : {}), ...(changedFields ? { changedFields } : {}), ...(prompts ? { prompts } : {}) }));
      const revision = await ops.commitCreatorRevision({ editId, baseRevision: before.revision, key, decisions });
      return { editId, revision, decisions: decisions.length, doc: result.doc };
    },

    /** Every graphic on an edit, with the keys of its latest finished render (alpha WebM plus a still). */
    async graphics(editId: string) {
      const rows = await ops.graphics(editId);
      return rows.map(row => ({
        assetId: row.assetId, status: row.status, revision: row.revision, readyRevision: row.readyRevision ?? null,
        kind: row.kind ?? null, title: row.title ?? null, props: row.props ?? null,
        jsonSchema: row.jsonSchema ? JSON.parse(row.jsonSchema) : null, problem: row.problem ?? null,
        webmKey: row.readyRevision !== undefined ? `${row.prefix}r${row.readyRevision}.webm` : null,
        stillKey: row.readyRevision !== undefined ? `${row.prefix}r${row.readyRevision}.jpg` : null,
      }));
    },

    /** New values for a graphic. It renders again from the same source; no model call, no charge. */
    async setGraphicProps(editId: string, assetId: string, body: unknown) {
      if (!ASSET_ID.test(assetId)) bad("Unknown graphic.");
      const parsed = propsSchema.safeParse(body);
      if (!parsed.success || JSON.stringify(parsed.data.props).length > 16000) return bad("Send the graphic's values as { props: {...} }, under 16 KB.");
      const { revision } = await ops.setGraphicProps({ editId, assetId, props: parsed.data.props });
      return { assetId, revision, status: "queued" as const };
    },

    /** A web project's edits, newest first. */
    async projectEdits(projectId: string) {
      if (!PROJECT_ID.test(projectId)) return bad("No project with this id.");
      const rows = await ops.projectEdits(projectId);
      return { edits: rows.map(e => ({ editId: e.id, name: e.name, status: e.status, revision: e.revision, createdAt: e.createdAt })) };
    },

    /** A web project's plan (ProjectSources), a stored script read in: the local engine has no access to the cloud's files. */
    async projectSources(projectId: string): Promise<ProjectSources> {
      if (!PROJECT_ID.test(projectId)) return bad("No project with this id.");
      const src = await ops.projectSources(projectId);
      const m = src.material;
      if (!m?.blobKey) return src;
      const { blobKey, ...rest } = m;
      const text = m.text ?? (m.kind === "script" ? (await blobs.getText(blobKey))?.slice(0, 64_000) : undefined);
      return { ...src, material: { ...rest, ...(text ? { text } : {}) } };
    },

    /** Renders of this edit, newest first, with the output key once ready. */
    async renders(editId: string) {
      return (await ops.renders(editId)).map(({ id, ...r }) => ({ renderId: id, ...r }));
    },

    /**
     * Render the latest revision from the clips' full files. `revision` is the
     * one the creator is looking at. The cloud charges per started minute.
     */
    async startRender(editId: string, body: unknown) {
      const { edit, doc } = await latestDoc(editId);
      if (!edit.docKey || !doc) throw new EditorError("NOT_READY");
      const asked = (body as { revision?: unknown } | null)?.revision;
      const revision = asked === undefined ? edit.revision : Number(asked);
      if (revision !== edit.revision) throw new EditorError("REVISION_CONFLICT", undefined, { revision: edit.revision });
      const parsed = parseEditDoc(doc).doc;
      const renderId = await ops.startRender({ editId, revision, seconds: docDuration(parsed), clipHashes: renderClipHashes(parsed) });
      return { renderId };
    },

    /**
     * Debug traces of the jobs behind an edit, oldest first: its clips'
     * indexing, every plan and every graphic. Empty unless jobs ran with
     * tracing on (the desktop's local build).
     */
    async traces(editId: string): Promise<JobTrace[]> {
      const edit = await ops.edit(editId);
      const base = editPrefix(edit.owner, edit.id);
      const keys = [
        ...await blobs.list(`${base}trace/`),
        ...(await blobs.list(`${base}graphics/`)).filter(k => k.includes("/trace/")),
        ...(await Promise.all(edit.clipHashes.map(h => blobs.list(`${clipPrefix(edit.owner, h)}trace/`)))).flat(),
      ].filter(k => k.endsWith(".json"));
      const traces = await Promise.all(keys.map(async k => {
        try { return JSON.parse((await blobs.getText(k)) ?? "null") as JobTrace | null; } catch { return null; }
      }));
      return traces.filter((t): t is JobTrace => t?.version === 1).sort((x, y) => x.startedAt - y.startedAt);
    },

    async render(renderId: string) {
      const { id, ...r } = await ops.render(renderId);
      return { renderId: id, ...r };
    },
  };
}
export type EditorApi = ReturnType<typeof editorApi>;
