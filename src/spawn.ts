// Run a child process to completion with node:child_process, so core runs
// under plain Node (the desktop's local engine) as well as Bun.
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";

export interface SpawnResult { code: number; stdout: string; stderr: string }

export function spawnText(command: string, args: string[], opts: { stdin?: string; signal?: AbortSignal; timeoutMs?: number; cwd?: string } = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...(opts.cwd ? { cwd: opts.cwd } : {}), stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    const kill = () => child.kill();
    opts.signal?.addEventListener("abort", kill, { once: true });
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;
    const done = () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", kill); };
    // bun-types drop ChildProcess's EventEmitter side; node has it.
    const events = child as unknown as EventEmitter;
    events.on("error", (error: Error) => { done(); reject(error); });
    events.on("close", (code: number | null) => {
      done();
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
  });
}
