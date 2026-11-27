// Bridge to the Python face finder (voxtale_native/). Spawns
// `python -m voxtale_native faces` with a JSON request on stdin and parses
// the JSON response on stdout. See voxtale_native/__main__.py.
import { join } from "node:path";
import { spawnText, type SpawnResult } from "../spawn";
import type { SubjectMaskRequest } from "../video/render-edit";

/** What a preview still's mask holds: the person (subject) and picked objects, prompts as fractions of the still. */
export interface StillMask { subject: boolean; objects: ObjectPrompt[] }
export interface ObjectPrompt { mode: "add" | "remove"; points?: [number, number][]; exclude?: [number, number][]; box?: [number, number, number, number] }
/** What the segmenter found for one prompt: share of the frame, box (fractions), its own score. */
export interface PickedObject { mode: "add" | "remove"; area: number; box: [number, number, number, number] | null; score: number }

/** The repo root: `bun run setup` makes the venv and the models here. */
export const REPO_ROOT = join(import.meta.dir, "../..");

/** The venv's interpreter under `root` (Scripts\\python.exe on Windows). */
export const venvPython = (root = REPO_ROOT, win = process.platform === "win32") =>
  win ? join(root, ".venv", "Scripts", "python.exe") : join(root, ".venv", "bin", "python");

/**
 * Interpreter: VOXTALE_EDITOR_PYTHON (or the old SUPERTALE_PYTHON), else the
 * repo's venv by absolute path, so it works from any working folder (an MCP
 * client starts the server in the footage folder).
 */
export const PYTHON = process.env.VOXTALE_EDITOR_PYTHON ?? process.env.SUPERTALE_PYTHON ?? venvPython();

async function callNative<T>(op: string, request: unknown): Promise<T> {
  let result: SpawnResult;
  try {
    result = await spawnText(PYTHON, ["-m", "voxtale_native", op], { stdin: JSON.stringify(request), cwd: REPO_ROOT });
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

export interface NativeAsrResult { engine: string; model: string; words: { text: string; start: number; end: number; confidence: number }[] }

/**
 * Local speech-to-text of a 16 kHz mono 16-bit WAV (voxtale_native/asr.py, Parakeet v3:
 * MLX on Apple Silicon, sherpa-onnx elsewhere). Words in seconds from the WAV's start.
 * Throws `no-model:` when tools/fetch-parakeet.sh has not run.
 */
export async function nativeAsr(wav: string, models?: string): Promise<NativeAsrResult> {
  return callNative<NativeAsrResult>("asr", { wav, ...(models ? { models } : {}) });
}

/**
 * Subject (person) mask video for source seconds [start, end) of `video` at `fps`, written to `out`
 * (voxtale_native/subject.py, U2-Net-p through cv2.dnn). False when it cannot: no model
 * (bun run setup), no Python, or a failed read; `warn` gets why.
 */
export async function nativeSubjectMask(o: SubjectMaskRequest, warn: (why: string) => void = () => {}): Promise<boolean> {
  try {
    if (o.objects?.length) {
      // Picked objects (voxtale_native/objects.py, MobileSAM through onnxruntime). Without that model, the plain
      // person mask when one was asked for; nothing when the mask was the objects alone.
      try {
        await callNative<{ out: string; frames: number }>("objects", o);
        return true;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        warn(why.includes("no-model:") ? `object model missing (tools/fetch-object-model.sh): picked objects left out of the mask` : `object mask failed: ${why.slice(0, 200)}`);
        if (o.subject === false) return false;
      }
    }
    const { objects: _, subject: __, ...plain } = o;
    await callNative<{ out: string; frames: number }>("subject", plain);
    return true;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    warn(why.includes("no-model:") ? "subject mask model missing (bun run setup): graphics drawn over the speaker" : `subject mask failed: ${why.slice(0, 200)}`);
    return false;
  }
}

/**
 * One still's subject mask (greyscale PNG, white = subject) for preview frames; false when it cannot, as nativeSubjectMask.
 * With `mask.objects`, picked objects are segmented again on this still from their prompt (not followed from their own
 * still, so an object that moved far is missed in the preview; the export follows it).
 */
export async function nativeSubjectStill(image: string, out: string, warn: (why: string) => void = () => {}, mask?: StillMask): Promise<boolean> {
  try {
    if (mask?.objects.length) {
      try {
        await callNative<{ out: string }>("objects_still", { image, out, subject: mask.subject, objects: mask.objects });
        return true;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        warn(why.includes("no-model:") ? "object model missing (tools/fetch-object-model.sh): stills leave picked objects out" : `object mask failed: ${why.slice(0, 200)}`);
        if (!mask.subject) return false;
      }
    }
    await callNative<{ out: string }>("subject_still", { image, out });
    return true;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    warn(why.includes("no-model:") ? "subject mask model missing (tools/fetch-subject-model.sh): stills show graphics over the speaker" : `subject mask failed: ${why.slice(0, 200)}`);
    return false;
  }
}

/** Subject path rows from voxtale_native/track.py: [t, cx, cy, w, h, kind], nulls when nobody is seen. */
export type NativeSubjectRow=[number,number|null,number|null,number|null,number|null,'face'|'person'|null];

/** Where the speaker is over source seconds [start, end] of `video`, sampled `rate` times a second (YuNet faces, HOG people when no face). */
export async function nativeSubjectPath(o:{video:string;start:number;end:number;rate?:number;people?:boolean}):Promise<{frames:NativeSubjectRow[];faces:number;people:number}> {
  return callNative('subject_path',o);
}

/** A set point followed over source seconds [start, end] of `video`, anchored at `at` (OpenCV Lucas-Kanade + RANSAC similarity). Rows: [t, x, y, scale, rotation]. */
export async function nativeTrackPoint(o:{video:string;start:number;end:number;at:number;point:[number,number];zone?:[number,number,number,number]}):Promise<{at:number;frames:[number,number,number,number,number][]}> {
  return callNative('track_point',o);
}

/**
 * Segment picked objects on one still: writes the mask PNG to `out` and an overlay JPEG (each object tinted, outlined,
 * numbered; its points and box drawn) to `overlay`. Throws when the object model or onnxruntime is missing ("no-model:").
 */
export async function nativePickObjects(image: string, out: string, overlay: string, objects: ObjectPrompt[], subject = false): Promise<PickedObject[]> {
  const r = await callNative<{ objects: PickedObject[] }>("objects_still", { image, out, overlay, objects, subject });
  return r.objects;
}
