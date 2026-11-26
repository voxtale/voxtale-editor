// The speaker's eyes for zoom, through uv: `uv run --script uv_faces.py`
// fetches Python and OpenCV on first use (~40 MB, once), so a machine with
// uv and no .venv still finds faces. No uv, script or model: undefined, and
// zoom frames the middle.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnText} from '../spawn';
import type {FaceFinder} from '../video/footage-index';

const ROOT=join(import.meta.dir,'../..');
const SCRIPT=join(ROOT,'voxtale_native/uv_faces.py');
const MODEL=join(ROOT,'models/face_detection_yunet_2023mar.onnx');

/** The face finder, or undefined when it cannot run here. uv binary: VOXTALE_EDITOR_UV (or SUPERTALE_UV), else `uv` on PATH. */
export async function uvFaceFinder(uv=process.env.VOXTALE_EDITOR_UV??process.env.SUPERTALE_UV??'uv'):Promise<FaceFinder|undefined> {
  if(!existsSync(SCRIPT)||!existsSync(MODEL))return undefined;
  try {if((await spawnText(uv,['--version'],{timeoutMs:10_000})).code)return undefined;}
  catch {return undefined;}
  return async jpegs=>{
    if(!jpegs.length)return [];
    // The first run downloads Python and OpenCV: give it minutes.
    const r=await spawnText(uv,['run','--quiet','--script',SCRIPT,MODEL],
      {stdin:JSON.stringify({images_b64:jpegs.map(j=>Buffer.from(j).toString('base64'))}),timeoutMs:10*60_000});
    if(r.code&&!r.stdout.trim())throw new Error(`faces: ${r.stderr.trim().slice(-300)}`);
    const out=JSON.parse(r.stdout) as {faces?:Awaited<ReturnType<FaceFinder>>;error?:string};
    if(out.error||!out.faces)throw new Error(`faces: ${out.error??'no answer'}`);
    return out.faces;
  };
}
