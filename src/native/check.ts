// What the local editor needs on this machine beyond bun and ffmpeg: the
// Python env (OpenCV, numpy) with the face finder and subject mask models,
// and the pixel font. `bun run setup` makes all of it; the server checks at
// start and says what is missing, so zooms never fall back to the middle
// without a word.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnText} from '../spawn';
import {PYTHON,REPO_ROOT} from './bridge';
import {chooseEngine,FETCH_SCRIPT,localModel,type LocalModel} from '../video/local-transcribe';

export const FACE_MODEL='face_detection_yunet_2023mar.onnx';
export const SUBJECT_MODEL='u2netp.onnx';
export const PIXEL_FONT='PixelifySans-Regular.ttf';
/** Optional, not in git (tools/fetch-object-model.sh): pick_object and objects in the subject mask. */
export const OBJECT_MODELS=['mobile_sam_image_encoder.onnx','sam_mask_decoder_single.onnx'] as const;

/** Both object model files are in models/ (or where VOXTALE_OBJECT_ENCODER / _DECODER point). */
export function objectModel(root=REPO_ROOT):boolean {
  const enc=process.env.VOXTALE_OBJECT_ENCODER??join(root,'models',OBJECT_MODELS[0]),dec=process.env.VOXTALE_OBJECT_DECODER??join(root,'models',OBJECT_MODELS[1]);
  return existsSync(enc)&&existsSync(dec);
}

export interface NativeCheck {
  /** The venv runs and imports cv2 and numpy. */
  python:boolean;
  faceModel:boolean;
  subjectModel:boolean;
  /** Optional object model (pick_object); never in `missing`, as the editor works without it. */
  objectModel:boolean;
  /** Pixelify Sans in the fonts folder (undefined: no fonts folder given). */
  pixelFont?:boolean;
  /** One line per missing piece, with what it costs; empty when all is there. */
  missing:string[];
  /** The local transcription model and the engine `open` would use. */
  transcriber:{model:LocalModel;engine:'local'|'assemblyai'|'none'};
  /** Reported, never failing setup: the local transcription model is a separate, large fetch. */
  optional:string[];
}

export interface CheckOptions {root?:string;python?:string;fontsDir?:string;
  /** Local model state (tests inject one); default checks models/parakeet/ under root. */
  transcriber?:LocalModel;env?:Record<string,string|undefined>;
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
  const model=o.transcriber??localModel({root,...(o.env?{env:o.env}:{})});
  let engine:NativeCheck['transcriber']['engine']='none';
  const optional:string[]=[];
  try {engine=chooseEngine({model,...(o.env?{env:o.env}:{})}).engine;}
  catch {optional.push(`Parakeet transcription model (${model.backend}) in ${model.dir}: talk clips cannot be transcribed. Run ${FETCH_SCRIPT} (free, ${model.backend==='mlx'?'2.5 GB':'490 MB'}), or set ASSEMBLYAI_API_KEY (paid)`);}
  return {python:ok,faceModel,subjectModel,objectModel:objectModel(root),...(pixelFont!==undefined?{pixelFont}:{}),missing,transcriber:{model,engine},optional};
}

/** The warning the server prints and hands the agent; empty when nothing is missing. */
export function missingNote(c:Pick<NativeCheck,'missing'>&Partial<Pick<NativeCheck,'optional'>>):string {
  const parts=[];
  if(c.missing.length)parts.push(`Missing on this machine (fix: run \`bun run setup\` in the editor repo, then restart the server):\n- ${c.missing.join('\n- ')}`);
  if(c.optional?.length)parts.push(`Not fetched yet:\n- ${c.optional.join('\n- ')}`);
  return parts.join('\n');
}

/** One line on the transcription engine, for setup and the start check. */
export const transcriberLine=(c:Pick<NativeCheck,'transcriber'>)=>
  c.transcriber.engine==='local'?`transcription: local Parakeet v3 (${c.transcriber.model.backend}, free)`
  :c.transcriber.engine==='assemblyai'?'transcription: AssemblyAI (paid; ASSEMBLYAI_API_KEY set or VOXTALE_EDITOR_TRANSCRIBE=assemblyai)'
  :`transcription: no engine (run ${FETCH_SCRIPT}, or set ASSEMBLYAI_API_KEY)`;

