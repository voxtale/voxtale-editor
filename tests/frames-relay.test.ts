import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OFFLINE, answerFrameCall, badFrameCall, relayFrames,
  type FrameCall, type FrameHost, type FrameReply, type RelayPort,
} from "@voxtale/frames";

const A = "a".repeat(64);
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** The creator's desktop, in memory: answers every call from `host`, files into `blobs`. */
function desktop(host: FrameHost, o: { answer?: boolean } = {}) {
  const blobs = new Map<string, Uint8Array>();
  const calls = new Map<string, { call: FrameCall; status: "pending" | "done" | "failed"; reply?: FrameReply }>();
  const posted: { call: FrameCall; deadline: number }[] = [];
  const port: RelayPort = {
    async post(call, deadline) {
      const id = `c${calls.size}`;
      posted.push({ call, deadline });
      calls.set(id, { call, status: "pending" });
      if (o.answer !== false) {
        const a = await answerFrameCall(host, call);
        const files: Record<string, string> = {};
        for (const [name, f] of Object.entries(a.files)) { blobs.set(`k/${id}/${name}`, f.bytes); files[name] = `k/${id}/${name}`; }
        const { files: _f, ...rest } = a;
        calls.set(id, { call, status: a.ok ? "done" : "failed", reply: { ...rest, files } });
      }
      return id;
    },
    state: async id => calls.get(id) ?? null,
    bytes: async key => blobs.get(key)!,
  };
  return { port, posted };
}

const fakeHost = (dir: string): FrameHost => ({
  filmstrip: async (clip, start, end) => bytes(`strip ${clip.slice(0, 2)} ${start}-${end}`),
  joins: async pairs => bytes(`joins ${pairs.length}`),
  frames: async (_clip, times) => times.map(t => (t === 2 ? null : bytes(`f@${t}`))),
  graphic: async job => {
    const webm = join(dir, `${job.id}.webm`);
    await writeFile(webm, "WEBM");
    return { ok: true, webm, report: "render: ok", sheet: bytes("sheet") };
  },
});

describe("frame relay", () => {
  test("a cloud run reads frames and graphics from the creator's desktop, by blob key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-"));
    const { port } = desktop(fakeHost(dir));
    const host = relayFrames({ port, dir: join(dir, "worker"), sleep: async () => {} });
    expect(text(await host.filmstrip(A, 1, 3))).toBe("strip aa 1-3");
    expect(text(await host.joins([{ a: { clip: A, t: 1 }, b: { clip: A, t: 2 } }]))).toBe("joins 1");
    expect((await host.frames(A, [1, 2, 3], 640)).map(f => (f ? text(f) : null))).toEqual(["f@1", null, "f@3"]);
    const g = await host.graphic({ id: "stat-40pct", html: "<html></html>", kitCss: "", width: 1920, height: 1080, seconds: 3, stills: [1], backdrop: { clip: A, t: 1 } });
    expect(g.ok).toBe(true);
    expect(g.webm).toBe(join(dir, "worker", "graphics", "stat-40pct", "graphic.webm"));
    expect(await readFile(g.webm!, "utf8")).toBe("WEBM");
    expect(text(g.sheet!)).toBe("sheet");
  });

  test("when the desktop never picks a call up, the agent is told VoxTale is closed, and the next call gives up sooner", async () => {
    let clock = 0;
    const { port, posted } = desktop(fakeHost(tmpdir()), { answer: false });
    const host = relayFrames({ port, dir: tmpdir(), pickupMs: 45_000, now: () => clock, sleep: async ms => { clock += ms; } });
    await expect(host.filmstrip(A, 0, 2)).rejects.toThrow(OFFLINE);
    const before = clock;
    await expect(host.joins([{ a: { clip: A, t: 1 }, b: { clip: A, t: 2 } }])).rejects.toThrow(OFFLINE);
    expect(clock - before).toBeLessThan(20_000);
    // The call lapses for the desktop too, so a late pickup does not run it.
    expect(posted[0]!.deadline).toBe(45_000 + 90_000);
    // A graphic that fails is a report for the agent, not a crash.
    const g = await host.graphic({ id: "g1", html: "", kitCss: "", width: 100, height: 100, seconds: 1, stills: [], backdrop: { clip: A, t: 0 } });
    expect(g).toEqual({ ok: false, report: `render failed: ${OFFLINE}` });
  });

  test("the desktop refuses calls it should not run", async () => {
    const graphic = { id: "../../etc", html: "", kitCss: "", width: 100, height: 100, seconds: 1, stills: [], backdrop: { clip: A, t: 0 } };
    expect(badFrameCall({ op: "graphic", job: graphic })).toBe("bad graphic");
    expect(badFrameCall({ op: "filmstrip", clip: "../x", start: 0, end: 1 })).toBe("bad filmstrip range");
    expect(badFrameCall({ op: "frames", clip: A, times: Array(65).fill(1), width: 640 })).toBe("bad frames");
    expect(badFrameCall({ op: "shell", cmd: "rm" })).toBe("unknown op");
    let ran = false;
    const host = { ...fakeHost(tmpdir()), graphic: async () => { ran = true; return { ok: true, report: "" }; } };
    expect(await answerFrameCall(host, { op: "graphic", job: graphic })).toEqual({ ok: false, error: "refused: bad graphic", files: {} });
    expect(ran).toBe(false);
  });
});
