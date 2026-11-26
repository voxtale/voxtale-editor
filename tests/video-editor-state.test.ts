import { describe, expect, test } from "bun:test";
import { STYLE_PRESETS } from "@voxtale/editdoc";
import { EditorError, STYLE_IDS, userOps, workerOps, type JobQueue, type JobRef } from "../src/video/editor/state";
import { memoryStore } from "../src/video/editor/memory";

const H = (n: number) => n.toString(16).padStart(64, "0");
const ASSET = (n: number) => `ga-${n.toString(16).padStart(24, "0")}`;

function setup(opts: { limit?: string[] } = {}) {
  const mem = memoryStore();
  const queue: JobQueue = {
    async enqueue(job) {
      if (opts.limit?.includes(job.type)) throw new EditorError("PLAN_LIMIT");
      return mem.addJob(job);
    },
  };
  const user = (owner = "u1") => userOps(mem.store, queue, owner);
  const worker = workerOps(mem.store, queue);
  const ref = (id: string): JobRef => { const j = mem.getJob(id)!; return { id, type: j.type, owner: j.owner, payload: j.payload }; };
  return { mem, user, worker, ref };
}

async function code(p: Promise<unknown>) {
  try { await p; } catch (e) { return (e as EditorError).code; }
  return "ok";
}

async function indexedClip(s: ReturnType<typeof setup>, n: number, owner = "u1") {
  const u = s.user(owner);
  await u.registerClip({ hash: H(n), name: `clip ${n}`, kind: "video", duration: 90, ingest: { hasAudio: true } });
  const clip = await u.startIndex(H(n));
  const job = s.ref(clip.indexJobId!);
  await s.worker.clipIndexed(job, { roleGuess: "a-roll", promptVersion: "v1" });
  return H(n);
}

describe("editor state", () => {
  test("style ids come from the presets", () => {
    expect(STYLE_IDS.sort()).toEqual(Object.keys(STYLE_PRESETS).sort());
  });

  test("a clip registers, queues by started minute, and indexes", async () => {
    const s = setup();
    const u = s.user();
    const first = await u.registerClip({ hash: H(1), name: "x".repeat(300), kind: "video", duration: 61, ingest: { hasAudio: true } });
    expect(first.upload).toBe(true);
    expect(first.name.length).toBe(260);
    expect(first.prefix).toBe(`users/u1/video/clips/${H(1)}/`);
    const queued = await u.startIndex(H(1));
    expect(queued.status).toBe("queued");
    expect(s.mem.getJob(queued.indexJobId!)!.amount).toBe(2);
    // Same bytes again: no upload, loudness backfilled.
    const again = await u.registerClip({ hash: H(1), name: "y", kind: "video", duration: 61, ingest: { hasAudio: true, loudness: { lufs: -14 } } });
    expect(again.upload).toBe(false);
    expect(s.mem.data.clips[0]!.ingest.loudness).toEqual({ lufs: -14 });
    await s.worker.clipIndexed(s.ref(queued.indexJobId!), { roleGuess: "a-roll", promptVersion: "v1" });
    const done = (await u.clip(H(1)))!;
    expect(done.status).toBe("indexed");
    expect(done.indexKey).toBe(`${first.prefix}index.json`);
    expect(done.transcriptKey).toBe(`${first.prefix}transcript.json`);
    expect(await code(u.clip("nope"))).toBe("INVALID_HASH");
  });

  test("a stale index job cannot write", async () => {
    const s = setup();
    const u = s.user();
    await u.registerClip({ hash: H(1), name: "a", kind: "audio", duration: 10, ingest: {} });
    const { indexJobId } = await u.startIndex(H(1));
    await s.worker.jobFailed(s.ref(indexJobId!), "boom");
    expect((await u.clip(H(1)))!.status).toBe("failed");
    const retry = await u.startIndex(H(1));
    expect(await code(s.worker.clipIndexed(s.ref(indexJobId!), { roleGuess: "x", promptVersion: "v" }))).toBe("STALE_CLAIM");
    expect(retry.status).toBe("queued");
  });

  test("edits need owned, indexed clips and valid options", async () => {
    const s = setup();
    const u = s.user();
    expect(await code(u.createEdit({ name: "e", clipHashes: [] }))).toBe("INVALID_CLIPS");
    expect(await code(u.createEdit({ name: "e", clipHashes: [H(9)] }))).toBe("NOT_FOUND");
    await u.registerClip({ hash: H(2), name: "b", kind: "video", duration: 5, ingest: {} });
    try { await u.createEdit({ name: "e", clipHashes: [H(2)] }); } catch (e) { expect((e as EditorError).details).toEqual({ hash: H(2) }); }
    const hash = await indexedClip(s, 1);
    expect(await code(s.user("u2").createEdit({ name: "e", clipHashes: [hash] }))).toBe("NOT_FOUND");
    expect(await code(u.createEdit({ name: "e", clipHashes: [hash], style: "loud" }))).toBe("INVALID_STYLE");
    expect(await code(u.createEdit({ name: "e", clipHashes: [hash], targetDuration: 2 }))).toBe("INVALID_DURATION");
    expect(await code(u.createEdit({ name: "e", clipHashes: [hash], brand: { colors: { accent: "red" } } }))).toBe("INVALID_BRAND");
    expect(await code(u.createEdit({ name: "e", clipHashes: [hash], brand: { fonts: { title: "Inter" } as never } }))).toBe("INVALID_BRAND");
    const branded = await u.createEdit({ name: "e", clipHashes: [hash], brand: { colors: { accent: "#ffb020" }, fonts: { body: " Inter " } } });
    expect((await u.edit(branded)).brand).toEqual({ colors: { accent: "#FFB020" }, fonts: { body: "Inter" } });
    expect((await u.edit(await u.createEdit({ name: "e", clipHashes: [hash], brand: {} }))).brand).toBeUndefined();
    const editId = await u.createEdit({ name: "e", clipHashes: [hash], style: "podcast", targetDuration: 60, instruction: "tight" });
    const edit = await u.edit(editId);
    expect(edit).toMatchObject({ status: "planning", revision: 0, style: "podcast", targetDuration: 60, instruction: "tight" });
    expect(s.mem.getJob(edit.jobId!)!.type).toBe("video-plan");
    expect(await code(s.user("u2").edit(editId))).toBe("NOT_FOUND");
  });

  test("plan, creator revision, replan and conflicts", async () => {
    const s = setup();
    const u = s.user();
    const hash = await indexedClip(s, 1);
    const editId = await u.createEdit({ name: "e", clipHashes: [hash] });
    const job = s.ref((await u.edit(editId)).jobId!);
    expect(await code(u.replanEdit({ editId }))).toBe("EDIT_BUSY");
    const input = await s.worker.planInput(job);
    expect(input.revision).toBe(1);
    expect(input.docKey).toBe(`users/u1/video/edits/${editId}/rev-1.json`);
    expect(input.clips[0]!.prefix).toBe(`users/u1/video/clips/${hash}/`);
    expect(await code(s.worker.planReady(job, { revision: 2 }))).toBe("STALE_CLAIM");
    await s.worker.planReady(job, { revision: 1, stage: "story", notes: ["n".repeat(600)] });
    const ready = await u.edit(editId);
    expect(ready).toMatchObject({ status: "ready", revision: 1, docKey: input.docKey });
    expect(ready.notes![0]!.length).toBe(500);

    const key = `users/u1/video/edits/${editId}/rev-2-cabc.json`;
    expect(await code(u.commitCreatorRevision({ editId, baseRevision: 0, key, decisions: [] }))).toBe("REVISION_CONFLICT");
    expect(await code(u.commitCreatorRevision({ editId, baseRevision: 1, key: "users/u2/x", decisions: [] }))).toBe("NOT_FOUND");
    const rev = await u.commitCreatorRevision({ editId, baseRevision: 1, key, decisions: [
      { itemId: "i1", track: "main", action: "deleted", fromRevision: 1, toRevision: 2 },
      { itemId: "i0", track: "main", action: "kept", fromRevision: 0, toRevision: 1 },
    ] });
    expect(rev).toBe(2);
    expect((await u.decisions(editId)).map(d => d.itemId)).toEqual(["i1"]);
    expect(s.mem.data.versions.map(v => v.source)).toEqual(["agent", "creator"]);

    const replanJob = await u.replanEdit({ editId, instruction: "", style: "tutorial", clipHashes: [hash, hash] });
    const replanned = await u.edit(editId);
    expect(replanned).toMatchObject({ status: "planning", jobId: replanJob, style: "tutorial", clipHashes: [hash] });
    expect(replanned.instruction).toBeUndefined();
    // A failed replan keeps the last good revision.
    await s.worker.jobFailed(s.ref(replanJob), "model down");
    expect(await u.edit(editId)).toMatchObject({ status: "ready", revision: 2, error: "model down" });
  });

  test("plans can go to the cloud agent editor's own job type, which the worker side reads and fails alike", async () => {
    const s = setup();
    const hash = await indexedClip(s, 1);
    const queue: JobQueue = { enqueue: async job => s.mem.addJob(job) };
    const u = userOps(s.mem.store, queue, "u1", { planJob: "video-agent" });
    const editId = await u.createEdit({ name: "e", clipHashes: [hash] });
    const job = s.ref((await u.edit(editId)).jobId!);
    expect(job.type).toBe("video-agent");
    expect((await s.worker.planInput(job)).revision).toBe(1);
    await s.worker.jobFailed(job, "desktop gone");
    expect(await u.edit(editId)).toMatchObject({ status: "failed", error: "desktop gone" });
    const replan = await u.replanEdit({ editId });
    expect(s.ref(replan).type).toBe("video-agent");
    // Other job types still cannot read an edit.
    expect(await code(s.worker.planInput({ ...job, type: "video-render" }))).toBe("NOT_FOUND");
  });

  test("a failed first plan fails the edit", async () => {
    const s = setup();
    const u = s.user();
    const editId = await u.createEdit({ name: "e", clipHashes: [await indexedClip(s, 1)] });
    await s.worker.jobFailed(s.ref((await u.edit(editId)).jobId!), "boom");
    expect((await u.edit(editId)).status).toBe("failed");
  });

  async function readyEdit(s: ReturnType<typeof setup>, graphics: { assetId: string; request: unknown; tokens: unknown }[] = []) {
    const u = s.user();
    const editId = await u.createEdit({ name: "e", clipHashes: [await indexedClip(s, 1)] });
    const job = s.ref((await u.edit(editId)).jobId!);
    await s.worker.planReady(job, { revision: 1, graphics });
    return editId;
  }

  test("an agent-rendered graphic lands ready, with no job and no props to edit", async () => {
    const s = setup();
    const u = s.user();
    const editId = await readyEdit(s, [{ assetId: ASSET(2), request: { agent: true, id: "goal-list", seconds: 4 }, tokens: {}, rendered: true } as never]);
    const [g] = await u.graphics(editId);
    expect(g).toMatchObject({ assetId: ASSET(2), status: "ready", readyRevision: 0, hasSource: false, prefix: `users/u1/video/edits/${editId}/graphics/${ASSET(2)}/` });
    expect(s.mem.data.graphics[0]!.jobId).toBeUndefined();
    expect(await code(u.setGraphicProps({ editId, assetId: ASSET(2), props: {} }))).toBe("GRAPHIC_NOT_READY");
  });

  test("graphics queue from a plan; props re-render free; failures keep the last good render", async () => {
    const s = setup();
    const u = s.user();
    const editId = await readyEdit(s, [
      { assetId: ASSET(1), request: { kind: "lower-third", title: "Name" }, tokens: {} },
      { assetId: "bad", request: {}, tokens: {} },
    ]);
    const [g] = await u.graphics(editId);
    expect(g).toMatchObject({ assetId: ASSET(1), status: "queued", kind: "lower-third", title: "Name", prefix: `users/u1/video/edits/${editId}/graphics/${ASSET(1)}/` });
    expect(await u.graphics(editId)).toHaveLength(1);
    expect(await code(u.setGraphicProps({ editId, assetId: ASSET(1), props: {} }))).toBe("GRAPHIC_BUSY");
    const row = s.mem.data.graphics[0]!;
    const job = s.ref(row.jobId!);
    expect(await s.worker.graphicInput(job)).toMatchObject({ assetId: ASSET(1), revision: 0, props: null, hasSource: false });
    await s.worker.graphicDone(job, { revision: 0, ok: true, hasSource: true, props: { a: 1 }, jsonSchema: "{}", costUsd: 0.01 });
    expect(await code(u.setGraphicProps({ editId, assetId: ASSET(1), props: [1] }))).toBe("INVALID_PROPS");
    const { revision } = await u.setGraphicProps({ editId, assetId: ASSET(1), props: { a: 2 } });
    expect(revision).toBe(1);
    const job2 = s.ref(s.mem.data.graphics[0]!.jobId!);
    expect(s.mem.getJob(job2.id)!.amount).toBe(0);
    await s.worker.graphicDone(job2, { revision: 1, ok: false, problem: "bad props", hasSource: true, costUsd: 0.02 });
    expect(s.mem.data.graphics[0]).toMatchObject({ status: "ready", revision: 0, readyRevision: 0, problem: "bad props", costUsd: 0.03 });
    expect(await code(s.user("u2").graphics(editId))).toBe("NOT_FOUND");
  });

  test("a used-up plan leaves graphics failed with a note", async () => {
    const s = setup({ limit: ["video-graphic"] });
    const editId = await readyEdit(s, [{ assetId: ASSET(1), request: {}, tokens: {} }]);
    expect(s.mem.data.graphics[0]).toMatchObject({ status: "failed", problem: "You have used this month's graphics." });
    expect((await s.user().edit(editId)).notes).toEqual(["Some graphics were not made: you have used this month's graphics."]);
  });

  test("renders need sources, dedupe by revision, and report progress", async () => {
    const s = setup();
    const u = s.user();
    const editId = await readyEdit(s);
    const hash = H(1);
    expect(await code(u.startRender({ editId, revision: 0, seconds: 30, clipHashes: [hash] }))).toBe("REVISION_CONFLICT");
    expect(await code(u.startRender({ editId, revision: 1, seconds: 0, clipHashes: [hash] }))).toBe("INVALID_DURATION");
    expect(await code(u.startRender({ editId, revision: 1, seconds: 30, clipHashes: [hash] }))).toBe("SOURCE_MISSING");
    expect(await code(u.beginClipSource({ hash, ext: "exe", size: 10, uploadId: "up" }))).toBe("INVALID_SOURCE");
    const key = await u.beginClipSource({ hash, ext: "mp4", size: 10, uploadId: "up" });
    expect(key).toBe(`users/u1/video/clips/${hash}/source.mp4`);
    expect(await code(u.clipSourceReady({ hash, uploadId: "other" }))).toBe("STALE_UPLOAD");
    await u.clipSourceReady({ hash, uploadId: "up" });
    const renderId = await u.startRender({ editId, revision: 1, seconds: 61, clipHashes: [hash] });
    expect(await u.startRender({ editId, revision: 1, seconds: 61, clipHashes: [hash] })).toBe(renderId);
    const view = await u.render(renderId);
    expect(view).toMatchObject({ status: "queued", progress: { job: "queued", stage: null, fraction: null } });
    expect((view as Record<string, unknown>).docKey).toBeUndefined();
    const job = s.ref(s.mem.data.renders[0]!.jobId!);
    expect(s.mem.getJob(job.id)!.amount).toBe(2);
    s.mem.patchJob(job.id, { status: "running", progress: { stage: "encode", detail: { fraction: 0.5 } } });
    expect((await u.renders(editId))[0]).toMatchObject({ status: "rendering", progress: { stage: "encode", fraction: 0.5 } });
    const input = await s.worker.renderInput(job);
    expect(input.sources).toEqual([{ hash, key, size: 10 }]);
    expect(input.outputKey).toBe(`users/u1/video/edits/${editId}/renders/${renderId}.mp4`);
    await s.worker.dropSources(job, [hash]);
    expect((await u.clip(hash))!.source).toBeNull();
    await s.worker.renderDone(job, { frames: 900, duration: 30, bytes: 1000, skipped: [] });
    expect(await u.render(renderId)).toMatchObject({ status: "ready", frames: 900, progress: null });
    expect(await code(s.user("u2").render(renderId))).toBe("NOT_FOUND");
  });

  test("a failed render job fails its row", async () => {
    const s = setup();
    const u = s.user();
    const editId = await readyEdit(s);
    await u.beginClipSource({ hash: H(1), ext: "mov", size: 5, uploadId: "x" });
    await u.clipSourceReady({ hash: H(1), uploadId: "x" });
    const renderId = await u.startRender({ editId, revision: 1, seconds: 5, clipHashes: [H(1)] });
    await s.worker.jobFailed(s.ref(s.mem.data.renders[0]!.jobId!), "ffmpeg died");
    expect(await u.render(renderId)).toMatchObject({ status: "failed", error: "ffmpeg died" });
    // A failed render does not block a new one.
    expect(await u.startRender({ editId, revision: 1, seconds: 5, clipHashes: [H(1)] })).not.toBe(renderId);
  });

  test("worker reads check the job type", async () => {
    const s = setup();
    const editId = await readyEdit(s);
    const planJob = s.ref(s.mem.data.edits.find(e => e.id === editId)!.jobId!);
    expect(await code(s.worker.indexInput(planJob))).toBe("NOT_FOUND");
    expect(await code(s.worker.renderInput(planJob))).toBe("NOT_FOUND");
  });
});
