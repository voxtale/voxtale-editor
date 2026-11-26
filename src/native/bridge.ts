// Bridge to the Python face finder (voxtale_native/). Spawns
// `python -m voxtale_native faces` with a JSON request on stdin and parses
// the JSON response on stdout. See voxtale_native/__main__.py.
import { spawnText, type SpawnResult } from "../spawn";

/** Interpreter: VOXTALE_EDITOR_PYTHON (or the old SUPERTALE_PYTHON), else the project venv. */
export const PYTHON = process.env.VOXTALE_EDITOR_PYTHON ?? process.env.SUPERTALE_PYTHON ?? ".venv/bin/python";

async function callNative<T>(op: string, request: unknown): Promise<T> {
  let result: SpawnResult;
  try {
    result = await spawnText(PYTHON, ["-m", "voxtale_native", op], { stdin: JSON.stringify(request) });
  } catch (error) {
    throw new Error(`native bridge failed to spawn ${PYTHON}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { stdout: out, stderr: err, code: status } = result;
  if (status !== 0 && !out) throw new Error(`native op '${op}' exited ${status}: ${err.trim().slice(0, 300)}`);
  const parsed = JSON.parse(out) as T | { error: string };
  if (parsed && typeof parsed === "object" && "error" in parsed) throw new Error(`native op '${op}': ${parsed.error}`);
  return parsed as T;
}

export interface NativeFace { x: number; y: number; w: number; h: number; eyes?: { x: number; y: number } }

/** Largest face per JPEG (YuNet) with its eyes' midpoint, as fractions of the frame; null where none is found. */
export async function nativeFaceFinder(jpegs: Uint8Array[]): Promise<(NativeFace | null)[]> {
  if (!jpegs.length) return [];
  const { faces } = await callNative<{ faces: (NativeFace | null)[] }>("faces", {
    images_b64: jpegs.map((j) => Buffer.from(j).toString("base64")),
  });
  return faces;
}

/**
 * Subject (person) mask video for source seconds [start, end) of `video` at `fps`, written to `out`
 * (voxtale_native/subject.py, U2-Net-p through cv2.dnn). False when it cannot: no model
 * (tools/fetch-subject-model.sh), no Python, or a failed read; `warn` gets why.
 */
export async function nativeSubjectMask(o: { video: string; start: number; end: number; fps: number; out: string }, warn: (why: string) => void = () => {}): Promise<boolean> {
  try {
    await callNative<{ out: string; frames: number }>("subject", o);
    return true;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    warn(why.includes("no-model:") ? "subject mask model missing (tools/fetch-subject-model.sh): graphics drawn over the speaker" : `subject mask failed: ${why.slice(0, 200)}`);
    return false;
  }
}

/** One still's subject mask (greyscale PNG, white = subject) for preview frames; false when it cannot, as nativeSubjectMask. */
export async function nativeSubjectStill(image: string, out: string, warn: (why: string) => void = () => {}): Promise<boolean> {
  try {
    await callNative<{ out: string }>("subject_still", { image, out });
    return true;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    warn(why.includes("no-model:") ? "subject mask model missing (tools/fetch-subject-model.sh): stills show graphics over the speaker" : `subject mask failed: ${why.slice(0, 200)}`);
    return false;
  }
}
