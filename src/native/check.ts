// What the local editor needs on this machine beyond bun and ffmpeg: the
// Python env (OpenCV, numpy) with the face finder and subject mask models,
// and the pixel font. `bun run setup` makes all of it; the server checks at
// start and says what is missing, so zooms never fall back to the middle
// without a word.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnText} from '../spawn';
import {PYTHON,REPO_ROOT} from './bridge';

export const FACE_MODEL='face_detection_yunet_2023mar.onnx';
export const SUBJECT_MODEL='u2netp.onnx';
export const PIXEL_FONT='PixelifySans-Regular.ttf';

export interface NativeCheck {
  /** The venv runs and imports cv2 and numpy. */
  python:boolean;
  faceModel:boolean;
  subjectModel:boolean;
  /** Pixelify Sans in the fonts folder (undefined: no fonts folder given). */
  pixelFont?:boolean;
  /** One line per missing piece, with what it costs; empty when all is there. */
  missing:string[];
}

export interface CheckOptions {root?:string;python?:string;fontsDir?:string;
  /** Runs the interpreter; true when `import cv2, numpy` works. Injected in tests. */
  probe?:(python:string,root:string)=>Promise<boolean>;}

const probePython=async(python:string,root:string)=>
  spawnText(python,['-c','import cv2, numpy'],{cwd:root,timeoutMs:60_000}).then(r=>r.code===0,()=>false);

export async function checkNatives(o:CheckOptions={}):Promise<NativeCheck> {
  const root=o.root??REPO_ROOT,python=o.python??PYTHON;
  const faceModel=existsSync(join(root,'models',FACE_MODEL)),subjectModel=existsSync(join(root,'models',SUBJECT_MODEL));
  const ok=await (o.probe??probePython)(python,root);
  const pixelFont=o.fontsDir?existsSync(join(o.fontsDir,PIXEL_FONT)):undefined;
  const missing:string[]=[];
  if(!ok)missing.push(`Python env (${python}) with OpenCV and numpy: no face finder (zooms aim at the middle) and no subject mask (text goes over the speaker, not behind)`);
  if(!faceModel)missing.push(`models/${FACE_MODEL}: no face finder (zooms aim at the middle)`);
  if(!subjectModel)missing.push(`models/${SUBJECT_MODEL}: no subject mask (text goes over the speaker, not behind)`);
  if(pixelFont===false)missing.push(`fonts/${PIXEL_FONT}: pixel-art graphics fall back to Inter`);
  return {python:ok,faceModel,subjectModel,...(pixelFont!==undefined?{pixelFont}:{}),missing};
}

/** The warning the server prints and hands the agent; empty when nothing is missing. */
export function missingNote(c:NativeCheck):string {
  return c.missing.length?`Missing on this machine (fix: run \`bun run setup\` in the editor repo, then restart the server):\n- ${c.missing.join('\n- ')}`:'';
}

