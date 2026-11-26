// The scene kit: what a scene (built-in or agent-written) may use besides
// react and remotion. Lib code, so scenes never touch document or the clock.
import {createElement, Fragment, useId} from 'react';
import {Easing, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {CURVES, type CurveName, proTimes, smearStd} from './motion';

export {AbsoluteFill, Easing, interpolate, random, Sequence, spring, useCurrentFrame, useVideoConfig} from 'remotion';
export {z} from 'zod/v4';
export {accentParts, countSteps, CURVES, driftOffset, fitFont, floatOffset, hookLines, proTimes, snap, stackPath, stagger, transitionLevel, type CurveName} from './motion';

export {color, FONTS, font, num, weight} from './schemas';
/** CSS font-family for a font name; names the renderer does not ship fall back to Inter. */
export const fontFamily = (name = 'Inter') => (name === 'JetBrains Mono' ? `'JetBrains Mono', monospace` : `${name === 'Inter' ? '' : `'${name}', `}Inter, sans-serif`);

/** The pro curves as Remotion easings: interpolate(f,[a,b],[from,to],{easing:curves.flowIn,...clamp}). */
export const curves = Object.fromEntries(Object.entries(CURVES).map(([name, [x1, y1, x2, y2]]) => [name, Easing.bezier(x1, y1, x2, y2)])) as Record<CurveName, (t: number) => number>;
/** The moderate curve: for short rises (under ~150 px), where glide and flowIn look frozen. */
export const moderate = Easing.bezier(0.2, 0.6, 0.35, 1);
export const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

/**
 * Motion blur, 180° shutter as in After Effects, on the moving element (its style places it).
 * `x`/`y`: its position in px at a given frame. Blurs only along the motion; gone at rest.
 */
export function MotionBlur({x, y, shutter = 180, style, children}: {
  x?: (frame: number) => number; y?: (frame: number) => number; shutter?: number; style?: React.CSSProperties; children?: React.ReactNode;
}) {
  const frame = useCurrentFrame();
  const id = 'mb' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const open = shutter / 360;
  const trail = (at?: (f: number) => number) => (at ? at(frame + open) - at(frame) : 0);
  const dx = trail(x), dy = trail(y), sx = smearStd(dx), sy = smearStd(dy);
  const on = sx > 0.3 || sy > 0.3;
  const filter = on && createElement('svg', {width: 0, height: 0, style: {position: 'absolute'}},
    createElement('filter', {id, x: '-100%', y: '-100%', width: '300%', height: '300%', colorInterpolationFilters: 'sRGB'},
      createElement('feGaussianBlur', {stdDeviation: `${sx} ${sy}`})));
  const moved = on ? {filter: `url(#${id})`, transform: `translate(${dx / 2}px, ${dy / 2}px) ${style?.transform ?? ''}`} : {};
  return createElement(Fragment, null, filter, createElement('div', {style: {...style, ...moved}}, children));
}

/** text-shadow / box-shadow value (much cheaper per frame than filter: drop-shadow). */
export const shadow = (blur: number, opacity: number, distance: number) => `0 ${distance}px ${blur}px rgba(0,0,0,${opacity})`;

/** Shared fade in and out (0 → 1 → 0) at `frame`. */
export function inOutOpacity(frame: number, durationFrames: number, fps: number) {
  const enter = spring({frame, fps, config: {damping: 200}});
  const exit = interpolate(frame, [durationFrames - 8, durationFrames], [1, 0], clamp);
  return Math.min(enter, exit);
}

/**
 * Shared entrance/exit and `life` (0 → 1 over the whole duration).
 * classic: spring slide + fade in and out. pro: `progress` rises in 0.9 s on the moderate curve,
 * opacity arrives in 3 frames and does not fade out; `exit` (0 → 1, flowOut, 0.8 s) is the exit move to apply.
 */
export function useInOut(durationFrames: number, {motion = 'classic', speed = 1}: {motion?: 'classic' | 'pro'; speed?: number} = {}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const life = Math.min(1, frame / Math.max(1, durationFrames - 1));
  if (motion === 'pro') {
    const {enter, leave} = proTimes(durationFrames, fps, speed);
    return {
      progress: interpolate(frame, [0, enter], [0, 1], {easing: moderate, ...clamp}),
      opacity: interpolate(frame, [0, 3], [0, 1], clamp),
      exit: interpolate(frame, [durationFrames - leave, durationFrames - 1], [0, 1], {easing: curves.flowOut, ...clamp}),
      life,
    };
  }
  return {progress: spring({frame, fps, config: {damping: 200}}), opacity: inOutOpacity(frame, durationFrames, fps), exit: 0, life};
}

let measure: CanvasRenderingContext2D | null = null;
/** Width in px of `text` in a CSS font (`800 76px Inter`). Fonts are loaded before any scene renders. */
export function textWidth(text: string, font: string): number {
  const ctx = (measure ??= new OffscreenCanvas(1, 1).getContext('2d') as unknown as CanvasRenderingContext2D);
  ctx.font = font;
  return ctx.measureText(text).width;
}
