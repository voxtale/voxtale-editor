import { describe, expect, test } from "bun:test";
import { EditorError, userOps, workerOps, type EditorStore, type JobQueue, type JobRef } from "../src/video/editor/state";
import { editorApi } from "../src/video/editor/api";
import { memoryStore } from "../src/video/editor/memory";
import { projectBrief, projectLines, type ProjectSources } from "../src/video/editor/project";
import { taskPrompt } from "../src/video/editor/agent/plan";
import { STYLE_PRESETS } from "@voxtale/editdoc";

const H = (n: number) => n.toString(16).padStart(64, "0");
const P = "kd7abc1234567890xyz";

const SOURCES: ProjectSources = {
  title: "Why devs quit",
  material: { kind: "script", text: "Most devs quit because of meetings. ".repeat(200) },
  outline: { promise: "You learn the real reason.", beats: [{ title: "Cold open", content: "The resignation email." }, { beat: "Old shape", content: "v1 beats use `beat`." }] },
  packaging: [{ title: "I quit coding", hook: "Day one without code." }, { title: "B" }, { title: "C" }, { title: "D" }],
};

describe("project brief", () => {
  test("keeps three ideas, both outline shapes, and cuts a long script", () => {
    const b = projectBrief(P, SOURCES);
    expect(b.packaging.map(p => p.title)).toEqual(["I quit coding", "B", "C"]);
    expect(b.packaging.every(p => !p.chosen)).toBe(true);
    expect(b.beats.map(x => x.title)).toEqual(["Cold open", "Old shape"]);
    expect(b.promise).toBe("You learn the real reason.");
    expect(b.material!.truncated).toBe(true);
    expect(b.material!.text.length).toBeLessThanOrEqual(4000);
  });

  test("a published title is the only one, with its planned hook", () => {
    const b = projectBrief(P, { ...SOURCES, publishedTitle: "I quit coding" });
    expect(b.packaging).toEqual([{ title: "I quit coding", hook: "Day one without code.", chosen: true }]);
  });

  test("a transcript or video is not passed on; a bare title says nothing", () => {
    expect(projectBrief(P, { title: "x", material: { kind: "transcript", text: "t" } }).material).toBeUndefined();
    expect(projectLines(projectBrief(P, { title: "x" }))).toEqual([]);
  });

  test("the task prompt carries the plan", () => {
    const brief = projectBrief(P, SOURCES);
    const ref = { id: "c1", name: "c", role: "a-roll", duration: 60, width: 1920, height: 1080 };
    const job = { id: "e", name: "e", clips: [{ ref, words: [] }], style: STYLE_PRESETS["calm-explainer"], project: brief };
    const prompt = taskPrompt(job as never, false);
    for (const line of projectLines(brief)) expect(prompt).toContain(line);
    expect(taskPrompt({ ...job, project: undefined } as never, false)).not.toContain(projectLines(brief)[0]!);
  });
});

function setup() {
  const mem = memoryStore();
  const queue: JobQueue = { async enqueue(job) { return mem.addJob(job); } };
  const projects: Record<string, { owner: string; src: ProjectSources }> = { [P]: { owner: "u1", src: SOURCES } };
  const store: EditorStore = {
    ...mem.store,
    async project(owner, id) { const p = projects[id]; return p && p.owner === owner ? p.src : null; },
    async projectEdits(owner, id, limit) {
      return mem.data.edits.filter(e => e.owner === owner && e.projectId === id).slice(0, limit).map(e => ({ ...e, createdAt: 0 }));
    },
  };
  const user = (owner = "u1") => userOps(store, queue, owner);
  const worker = workerOps(store, queue);
  const ref = (id: string): JobRef => { const j = mem.getJob(id)!; return { id, type: j.type, owner: j.owner, payload: j.payload }; };
  return { mem, user, worker, ref, projects };
}

async function code(p: Promise<unknown>) {
  try { await p; } catch (e) { return (e as EditorError).code; }
  return "ok";
}

describe("edits for a project", () => {
  test("an edit links to an owned project and its plan reaches the planner", async () => {
    const s = setup();
    const u = s.user();
    await u.registerClip({ hash: H(1), name: "c", kind: "video", duration: 60, ingest: { hasAudio: true } });
    const clip = await u.startIndex(H(1));
    await s.worker.clipIndexed(s.ref(clip.indexJobId!), { roleGuess: "a-roll", promptVersion: "v1" });

    expect(await code(u.createEdit({ name: "e", clipHashes: [H(1)], projectId: "nope0000000" }))).toBe("NOT_FOUND");
    expect(await code(s.user("u2").projectEdits(P))).toBe("NOT_FOUND");
    const editId = await u.createEdit({ name: "e", clipHashes: [H(1)], projectId: P });
    await u.createEdit({ name: "other", clipHashes: [H(1)] });
    expect((await u.projectEdits(P)).map(e => e.id)).toEqual([editId]);

    const input = await s.worker.planInput(s.ref((await u.edit(editId)).jobId!));
    expect(input.edit.projectId).toBe(P);
    expect(input.project?.title).toBe("Why devs quit");
  });

  test("a project's sources go only to its owner, a stray script key dropped", async () => {
    const s = setup();
    expect(await code(s.user("u2").projectSources(P))).toBe("NOT_FOUND");
    expect((await s.user().projectSources(P)).title).toBe("Why devs quit");
    s.projects[P]!.src = { title: "t", material: { kind: "script", blobKey: "users/u2/script.txt" } };
    expect((await s.user().projectSources(P)).material).toEqual({ kind: "script" });
    s.projects[P]!.src = { title: "t", material: { kind: "script", blobKey: "users/u1/script.txt" } };
    expect((await s.user().projectSources(P)).material?.blobKey).toBe("users/u1/script.txt");
  });

  test("the API reads a stored script in and hides the key", async () => {
    const s = setup();
    s.projects[P]!.src = { title: "t", material: { kind: "script", blobKey: "users/u1/script.txt" } };
    const blobs = { getText: async (k: string) => k === "users/u1/script.txt" ? "the script" : null, put: async () => {}, list: async () => [] };
    const api = editorApi({ ops: s.user(), blobs });
    expect((await api.projectSources(P)).material).toEqual({ kind: "script", text: "the script" });
    await expect(api.projectSources("../x")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("a store with no projects refuses a project id", async () => {
    const mem = memoryStore();
    const u = userOps(mem.store, { async enqueue(job) { return mem.addJob(job); } }, "u1");
    expect(await code(u.projectEdits(P))).toBe("NOT_FOUND");
  });
});
