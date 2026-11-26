// Papercraft kit for scenes: import from './paper' only.
// crosses, folds, platforms; createLife = the world's life (leaves, birds, smoke); builtGround = bridge, stairs, house.
// Typed any on purpose: the original JS defaults its options to null, and TypeScript would refuse every value passed.
/* eslint-disable @typescript-eslint/no-explicit-any */
import {useLayoutEffect, useRef, useState} from 'react';
import {AbsoluteFill, continueRender, delayRender, useCurrentFrame, useVideoConfig} from 'remotion';
import * as builtGroundLib from './papercraft/examples/built-ground.js';
import {viewFigure as viewFigureLib} from './papercraft/figure.js';
import * as P2lib from './papercraft/lib/paperkit-2d.js';
import * as P3lib from './papercraft/lib/paperkit-3d.js';
import {createLife as createLifeLib} from './papercraft/lib/paper-life.js';
import * as motionLib from './papercraft/lib/paper-motion.js';
import {createStage} from './papercraft/stage.js';
export {COUNTRYSIDE, countryside} from './papercraft/examples/countryside-scene.js';

export const P2: any = P2lib;
export const P3: any = P3lib;
export const paperMotion: any = motionLib;
export const createLife: any = createLifeLib;
export const builtGround: any = builtGroundLib;
/** A character as a paper puppet: a front, back or side card depending on where it goes (figure.js). */
export const viewFigure: (H: PaperHarness, o: Record<string, any>) => any = viewFigureLib as any;

type Box = {x0: number; x1: number; z0: number; z1: number};
/** Stage options (createStage): ground, paper, camera, light, lens; all optional. */
export type PaperOptions = {
  ground?: string; stock?: string; mood?: 'day' | 'golden' | 'dusk' | 'night' | (string & {}); bounds?: Box; heroHeight?: number;
  view?: {yaw?: number; pitch?: number; dist?: number; fov?: number; target?: number[]};
  light?: Record<string, unknown>; lens?: Record<string, unknown>; moods?: Record<string, unknown>; focus?: number[] | null;
  walkArea?: Box | null; camBox?: Box | null; ss?: number;
};
/** The stage harness: what build(H) receives (stage.js), plus what start() adds. */
export type PaperHarness = {[tool: string]: any} & {
  riseAt?: number; seek(t: number): void; restart(): void; setOpen(open: boolean): void; render(): void; dispose(): void;
  printGround(draw: (tools: any) => void, o?: {ppu?: number; seed?: number}): any;
  popup(pts: number[][] | null, paint: ((P: any) => void) | null, o?: Record<string, any>): any;
  printed(pts: number[][], paint: (P: any) => void, o?: Record<string, any>): any;
  stack(x: number, z: number, layers: {pts: number[][]; paint?: (P: any) => void; d?: number; dx?: number; yaw?: number; scale?: number}[], o?: Record<string, any>): any[];
  dome(x: number, z: number, o?: Record<string, any>): any[];
  onStep(fn: (time: number, dt: number) => void): void; onRestart(fn: () => void): void;
  setHero(hinge: any, o?: {stride?: (walked: number, gait: number) => void}): void;
  heroWalk(points: {at: number; x: number; z: number}[], o?: {follow?: boolean; lead?: number[]; smooth?: number}): void;
};

/**
 * A full-frame papercraft scene, computed frame by frame: `build(H)` lays the printed ground and the pieces
 * (H.printGround, H.popup, H.stack, H.dome, H.setHero…) once; then each video frame replays the stage clock up to its time.
 * `deps`: what rebuilds the scene when it changes (the scene's props). `start`: stage second shown at frame 0.
 */
export function PaperStage({build, options = {}, deps = [], start = 0}: {
  build: (H: PaperHarness) => void; options?: PaperOptions; deps?: unknown[]; start?: number;
}) {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const canvas = useRef<HTMLCanvasElement>(null);
  const now = useRef(0);
  now.current = start + frame / fps;
  const [stage, setStage] = useState<PaperHarness | null>(null);
  const key = JSON.stringify([options, deps]);
  useLayoutEffect(() => {
    // A fresh canvas per rebuild (the <canvas> key): the old one gave up its WebGL context on dispose.
    // Building prints every card (a few seconds for 200 pieces): the render waits for it.
    const handle = delayRender('papercraft scene');
    const H = createStage({...options, canvas: canvas.current, width, height}) as PaperHarness;
    try {
      build(H);
      H.start();
      H.seek(now.current);
      setStage(H);
    } finally {continueRender(handle);}
    return () => {setStage(null); H.dispose?.();};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, width, height]);
  useLayoutEffect(() => {stage?.seek(now.current);}, [stage, frame, start, fps]);
  return <AbsoluteFill><canvas key={`${key}${width}x${height}`} ref={canvas} style={{width: '100%', height: '100%', display: 'block'}} /></AbsoluteFill>;
}
