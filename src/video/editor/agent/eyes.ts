// The speaker's eyes on the exact frames each side of a cut, so zoom can put
// them back where they were (../../zoom). Small frames come from the frame
// host (where the files are); one native call finds the faces for a batch.
import {nativeFaceFinder} from '../../../native/bridge';
import type {FaceFinder} from '../../footage-index';
import type {Point} from '../../zoom';
import type {FrameHost} from './frames';

/** Eyes at each source time of one clip (by hash); null where no face was found or the frame failed. */
export type EyeFinder=(clip:string,times:number[])=>Promise<(Point|null)[]>;

const FRAME_WIDTH=640;

export function eyeFinder(frames:FrameHost['frames'],find:FaceFinder=nativeFaceFinder):EyeFinder {
  return async(clip,times)=>{
    const jpegs=await frames(clip,times,FRAME_WIDTH);
    const have=jpegs.flatMap((j,k)=>j?[k]:[]);
    const faces=have.length?await find(have.map(k=>jpegs[k]!)):[];
    const out:(Point|null)[]=new Array(times.length).fill(null);
    // A box without landmarks: the eyes sit about an eighth of its height above its centre.
    have.forEach((k,i)=>{const f=faces[i];if(f)out[k]=f.eyes??{x:f.x,y:f.y-f.h*0.12};});
    return out;
  };
}
