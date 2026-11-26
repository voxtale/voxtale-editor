// The part of a screen recording worth showing: the frame inside its window
// bars, side strips and dock. Read by code from the frames about to be shown,
// no model.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Part of a frame, fractions of it. */
export interface Box {x:number;y:number;w:number;h:number}

const r3=(x:number)=>Math.round(x*1000)/1000;

/** Grey frame size the content area is read at. */
export const CONTENT_W=320,CONTENT_H=200;
/** A grey step (0-255) between two neighbouring pixels that counts as an edge. */
const EDGE_STEP=6;
/** A bar's edge is one unbroken run this long, as a share of the frame, in every frame looked at. Text and pictures give edges too, in short broken runs. */
const LINE_SHARE=0.5;
/** Pixels a run may skip (an icon or a tab sitting on the edge). */
const LINE_GAP=2;
/**
 * How far in from each side a bar, strip or dock can reach, as a share of the
 * frame. On the recordings measured, browser bars end 5-8% down, side strips
 * 3-7% in, a dock starts 7% up.
 */
const BAND_TOP=0.14,BAND_BOTTOM=0.1,BAND_SIDE=0.09;

/**
 * The part of a screen recording inside its bars. `frames`: grey frames of the
 * stretch to be shown, CONTENT_W x CONTENT_H each. A bar ends on a straight
 * edge that runs most of the frame and stays put while the page inside moves;
 * the innermost such edge near each side is where the content starts.
 * Undefined when no side has one.
 */
export function contentBox(frames:Uint8Array[],W=CONTENT_W,H=CONTENT_H):Box|undefined {
  if(!frames.length||frames.some(f=>f.length<W*H))return undefined;
  // An edge counts only where every frame has it, stepping the same way: +1 lighter, -1 darker, 0 none.
  const step=(i:number,j:number)=>{
    let sign=0;
    for(const f of frames) {
      const d=f[j]!-f[i]!,s=d>=EDGE_STEP?1:d<=-EDGE_STEP?-1:0;
      if(!s||(sign&&s!==sign))return 0;
      sign=s;
    }
    return sign;
  };
  /** Longest unbroken same-way run of `n` steps, as a share of `n`. */
  const run=(n:number,at:(k:number)=>number)=>{
    let best=0,len=0,gap=0,sign=0;
    for(let k=0;k<n;k++) {
      const s=at(k);
      if(s&&(!sign||s===sign)){sign=s;len+=gap+1;gap=0;best=Math.max(best,len);}
      else if(!s&&sign&&gap<LINE_GAP)gap++;
      else{sign=s;len=s?1:0;gap=0;}
    }
    return best/n;
  };
  const rowLine=(y:number,x0:number,x1:number)=>run(x1-x0+1,k=>step(y*W+x0+k,(y+1)*W+x0+k))>=LINE_SHARE;
  const colLine=(x:number,y0:number,y1:number)=>run(y1-y0+1,k=>step((y0+k)*W+x,(y0+k)*W+x+1))>=LINE_SHARE;
  let top=0,bottom=H-1,left=0,right=W-1;
  for(let y=Math.floor(H*BAND_TOP);y>=0;y--)if(rowLine(y,0,W-1)){top=y+1;break;}
  for(let y=Math.ceil(H*(1-BAND_BOTTOM))-1;y<H-1;y++)if(rowLine(y,0,W-1)){bottom=y;break;}
  for(let x=Math.floor(W*BAND_SIDE);x>=0;x--)if(colLine(x,top,bottom)){left=x+1;break;}
  for(let x=Math.ceil(W*(1-BAND_SIDE))-1;x<W-1;x++)if(colLine(x,top,bottom)){right=x;break;}
  if(top===0&&bottom===H-1&&left===0&&right===W-1)return undefined;
  return {x:r3(left/W),y:r3(top/H),w:r3((right-left+1)/W),h:r3((bottom-top+1)/H)};
}

/** JPEG frames as grey frames of CONTENT_W x CONTENT_H, for `contentBox`. Frames that fail to decode are left out. */
export async function greyFrames(jpegs:(Uint8Array|null)[],dir:string,ff:(args:string[])=>Promise<void>):Promise<Uint8Array[]> {
  await mkdir(dir,{recursive:true});
  const out:Uint8Array[]=[];
  for(const [k,j] of jpegs.entries()) {
    if(!j)continue;
    const src=join(dir,`f${k}.jpg`),raw=join(dir,`f${k}.raw`);
    try {
      await writeFile(src,j);
      await ff(['-i',src,'-vf',`scale=${CONTENT_W}:${CONTENT_H}:flags=area,format=gray`,'-f','rawvideo',raw]);
      out.push(new Uint8Array(await readFile(raw)));
    } catch {/* skipped */}
  }
  return out;
}

/** Up to `n` source seconds spread over the stretches shown. */
export function spreadTimes(spans:[number,number][],n=5):number[] {
  const total=spans.reduce((s,[a,b])=>s+Math.max(0,b-a),0);
  if(total<=0)return spans.length?[spans[0]![0]]:[];
  return Array.from({length:n},(_,k)=>{
    let at=total*(k+0.5)/n;
    for(const [a,b] of spans){const d=Math.max(0,b-a);if(at<=d)return Math.round((a+at)*100)/100;at-=d;}
    return spans.at(-1)![1];
  });
}
