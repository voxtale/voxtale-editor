// The local engine: the shared rules over a folder, with a fake job runner so
// nothing calls a model. Covers clip files, job hand-off, restart and render.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { clipIngestSchema, newEditDoc, parseEditDoc, segmentsFromCuts } from "@voxtale/editdoc";
import { createLocalEngine, type LocalEngine } from "../src/video/editor/local";
import { runVideoRenderJob, type EditorJobContext } from "../src/video/editor/jobs";
import type { JobRef } from "../src/video/editor";

const SOURCE = "full clip bytes";
const A = createHash("sha256").update(SOURCE).digest("hex");
const ingest = (hash: string) => clipIngestSchema.parse({ hash, name: "a.mov", kind: "video", duration: 20, fps: { num: 30, den: 1 }, width: 1920, height: 1080,
  hasAudio: true, segments: segmentsFromCuts(20, []).map(({ id, start, end, stills }) => ({ id, start, end, stills })) });

const dirs: string[] = [];
const engines: LocalEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map(e => e.close()));
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});
const scratch = async () => { const d = await mkdtemp(join(tmpdir(), "vt-local-")); dirs.push(d); return d; };

/** Ingest files on disk, as the desktop leaves them. */
async function clipFiles(hash: string) {
  const dir = await scratch();
  const files = ["audio.flac", ...ingest(hash).segments.flatMap(s => s.stills.map((_, i) => `stills/${s.id}-${i}.jpg`))];
  await mkdir(join(dir, "stills"), { recursive: true });
  for (const f of files) await writeFile(join(dir, f), f);
  return { dir, files };
}

/** Fake jobs: index marks the clip indexed, plan writes a one-cut doc, render writes bytes. */
function fakeRunner(seen: string[]) {
  return async (job: JobRef, c: EditorJobContext) => {
    seen.push(job.type);
    if (job.type === "video-index") {
      const clip = await c.port.indexInput(job);
      await c.storage.put(`${clip.prefix}index.json`, "{}", "application/json");
      await c.port.clipIndexed(job, { roleGuess: "a-roll", promptVersion: "test", transcribed: false });
    } else if (job.type === "video-plan") {
      const p = await c.port.planInput(job);
      const clip = { id: "c1", hash: A, name: "a.mov", kind: "video" as const, role: "a-roll" as const, roleSource: "creator" as const, duration: 20,
        fps: { num: 30, den: 1 }, hasAudio: true, timecodeStart: 0, width: 640, height: 360 };
      const d = newEditDoc({ id: p.edit.id, name: "cut", clips: [clip] });
      const doc = parseEditDoc({ ...d, revision: p.revision, tracks: { ...d.tracks, "a-roll": [{ id: "a1", clipId: "c1", in: 0, out: 2, start: 0, end: 2, owner: "agent" }] } }).doc;
      await c.storage.put(p.docKey, JSON.stringify(doc), "application/json");
      await c.port.planReady(job, { revision: p.revision, stage: "story", notes: ["ok"] });
    } else if (job.type === "video-render") {
      // The real render job (hash checks, linked sources), with a fake encoder.
      await runVideoRenderJob({
        render: () => c.port.renderInput(job), done: r => c.port.renderDone(job, r), dropSources: h => c.port.dropSources(job, h),
        storage: c.storage, progress: c.progress,
        renderDoc: (async (o: { media: Record<string, string>; out: string }) => {
          await writeFile(o.out, `render of ${await readFile(o.media[A]!, "utf8")}`);
          return { frames: 60, duration: 2, skipped: [] };
        }) as never,
      });
    }
  };
}

const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 200 && !(await check()); i++) await new Promise(r => setTimeout(r, 10)); };

describe("local editor engine", () => {
  test("clip → index → edit → render, all on disk", async () => {
    const dir = await scratch();
    const seen: string[] = [];
    const engine = await createLocalEngine({ dir, runJob: fakeRunner(seen) as never });
    engines.push(engine);
    const { dir: clipDir, files } = await clipFiles(A);
    const sent = await engine.sendClip(ingest(A), clipDir, files);
    expect(sent.status).toBe("queued");
    await until(async () => (await engine.api.clip(A)).status === "indexed");
    expect((await engine.api.clip(A)).status).toBe("indexed");

    const { editId } = await engine.api.createEdit({ name: "cut", clipHashes: [A] });
    await until(async () => (await engine.api.edit(editId)).status === "ready");
    const edit = await engine.api.edit(editId);
    expect(edit.notes).toEqual(["ok"]);

    const source = join(await scratch(), "a.mov");
    await writeFile(source, SOURCE);
    const dest = join(await scratch(), "export.mp4");
    const stages: string[] = [];
    const done = await engine.renderFile(editId, { revision: edit.revision, sources: { [A]: source }, dest, onEvent: e => stages.push(e.stage) });
    expect(await readFile(dest, "utf8")).toBe(`render of ${SOURCE}`);
    expect(stages.at(-1)).toBe("done");
    expect(done.skipped).toEqual([]);
    expect(seen).toEqual(["video-index", "video-plan", "video-render"]);
  });

  test("an edit for a cloud project gets its plan; the last copy stands in offline", async () => {
    const P = "kd7abc1234567890xyz";
    const titles: (string | undefined)[] = [];
    let online = true;
    const runJob = async (job: JobRef, c: EditorJobContext) => {
      if (job.type === "video-plan") titles.push((await c.port.planInput(job)).project?.title);
      return fakeRunner([])(job, c);
    };
    const engine = await createLocalEngine({
      dir: await scratch(), runJob: runJob as never,
      projects: async id => { if (!online) throw new Error("offline"); return id === P ? { title: "Why devs quit" } : null; },
    });
    engines.push(engine);
    const { dir: clipDir, files } = await clipFiles(A);
    await engine.sendClip(ingest(A), clipDir, files);
    await until(async () => (await engine.api.clip(A)).status === "indexed");
    await expect(engine.api.createEdit({ name: "cut", clipHashes: [A], projectId: "nope0000000" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { editId } = await engine.api.createEdit({ name: "cut", clipHashes: [A], projectId: P });
    await until(async () => (await engine.api.edit(editId)).status === "ready");
    online = false;
    await engine.api.replan(editId, {});
    await until(async () => titles.length === 2 && (await engine.api.edit(editId)).status === "ready");
    expect(titles).toEqual(["Why devs quit", "Why devs quit"]);
  });

  test("a missing clip file is refused by the shared rules", async () => {
    const engine = await createLocalEngine({ dir: await scratch(), runJob: fakeRunner([]) as never });
    engines.push(engine);
    const { dir, files } = await clipFiles(A);
    await engine.api.registerClip(ingest(A));
    const keys = await engine.api.clipUploadKeys(A, files.slice(0, 1));
    await mkdir(join(engine.path(keys["audio.flac"]!.key), ".."), { recursive: true });
    await writeFile(engine.path(keys["audio.flac"]!.key), await readFile(join(dir, "audio.flac")));
    await expect(engine.api.completeClip(A)).rejects.toMatchObject({ code: "MISSING_UPLOADS" });
  });

  test("a failed job marks its row; state survives a restart", async () => {
    const dir = await scratch();
    const first = await createLocalEngine({ dir, runJob: (async () => { throw new Error("no key"); }) as never });
    const { dir: clipDir, files } = await clipFiles(A);
    await first.sendClip(ingest(A), clipDir, files);
    await until(async () => (await first.api.clip(A)).status === "failed");
    expect((await first.api.clip(A)).error).toContain("no key");
    await first.close();

    const again = await createLocalEngine({ dir, runJob: fakeRunner([]) as never });
    engines.push(again);
    expect((await again.api.clip(A)).status).toBe("failed");
    await again.api.completeClip(A);
    await until(async () => (await again.api.clip(A)).status === "indexed");
    expect((await again.api.clip(A)).status).toBe("indexed");
  });
});
