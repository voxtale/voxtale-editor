// VoxTale graphics kit. The only module generated graphics may import
// besides `react` and `remotion`. Reads style tokens; keeps motion consistent.
import React, {createContext, useContext} from 'react';
import {AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
export {AbsoluteFill, Sequence, Series, interpolate, spring, useCurrentFrame, useVideoConfig, Easing, random} from 'remotion';
export {z} from 'zod';

export interface Tokens {
  colors: {primary: string; accent: string; background: string; text: string; muted: string};
  fonts: {heading: string; body: string};
  radius: number;   // px at 1920 wide
  safe: number;     // fraction of width kept clear at each edge
}
export const defaultTokens: Tokens = {
  colors: {primary: '#6D5EF6', accent: '#FFB020', background: '#0E1016', text: '#FFFFFF', muted: '#9AA3B2'},
  fonts: {heading: 'Inter, Arial, sans-serif', body: 'Inter, Arial, sans-serif'},
  radius: 18, safe: 0.05,
};
// Text contrast is enforced here, by code, whatever colour a graphic asks for.
const rgb=(hex: string) => {const h = hex.replace('#', ''); const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6); return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) || 0);};
const lum=(c: number[]) => {const [r, g, b] = c.map(v => {const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;}); return 0.2126 * r + 0.7152 * g + 0.0722 * b;};
const ratio=(a: number[], b: number[]) => {const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05);};
/** `color` pushed toward white or black until it reads on `background` at `min`. Non-hex colours pass through. */
export function readable(color: string, background: string, min = 4.5): string {
  if (!/^#[0-9a-f]{3,8}$/i.test(color) || !/^#[0-9a-f]{3,8}$/i.test(background)) return color;
  const fg = rgb(color), bg = rgb(background);
  if (ratio(fg, bg) >= min) return color;
  const to = lum(bg) > 0.18 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0.05; t <= 1.0001; t += 0.05) {const c = fg.map((v, i) => Math.round(v + (to[i] - v) * t)); if (ratio(c, bg) >= min) return `rgb(${c.join(',')})`;}
  return `rgb(${to.join(',')})`;
}
const TokensContext = createContext<Tokens>(defaultTokens);
export const TokensProvider = TokensContext.Provider;
export function useTokens(): Tokens { return useContext(TokensContext); }

/** Scale px values authored for 1920 wide to the real canvas. */
export function useUnit(): (px: number) => number {
  const {width, height} = useVideoConfig();
  const base = Math.min(width, height * 16 / 9);
  return (px) => (px * base) / 1920;
}

/** 0→1 entrance spring starting at `delay` frames. */
export function useEnter(delay = 0): number {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return spring({frame: frame - delay, fps, config: {damping: 200}, durationInFrames: Math.round(fps * 0.5)});
}
/** 1→0 over the last `frames` frames of the composition. */
export function useExit(frames = 10): number {
  const frame = useCurrentFrame(); const {durationInFrames} = useVideoConfig();
  return interpolate(frame, [durationInFrames - frames, durationInFrames], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic)});
}

/** Transparent full frame inside the safe area. Never paints a background. */
export function Stage({children, align = 'center', justify = 'center'}: {children: React.ReactNode; align?: 'start' | 'center' | 'end'; justify?: 'start' | 'center' | 'end'}) {
  const {safe} = useTokens(); const {width} = useVideoConfig();
  const map = {start: 'flex-start', center: 'center', end: 'flex-end'} as const;
  return <AbsoluteFill style={{padding: width * safe, alignItems: map[align], justifyContent: map[justify], display: 'flex', flexDirection: 'column'}}>{children}</AbsoluteFill>;
}

export function Panel({children, style}: {children: React.ReactNode; style?: React.CSSProperties}) {
  const t = useTokens(); const u = useUnit();
  return <div style={{background: t.colors.background + 'EE', color: t.colors.text, borderRadius: u(t.radius), padding: `${u(36)}px ${u(48)}px`, boxShadow: `0 ${u(12)}px ${u(40)}px #0006`, fontFamily: t.fonts.body, ...style}}>{children}</div>;
}

export function Heading({children, size = 64, color, style}: {children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties}) {
  const t = useTokens(); const u = useUnit();
  return <div style={{fontFamily: t.fonts.heading, fontWeight: 800, fontSize: u(size), lineHeight: 1.1, ...style, color: readable(String(style?.color ?? color ?? t.colors.text), t.colors.background, 3)}}>{children}</div>;
}

export function Label({children, size = 30, color, style}: {children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties}) {
  const t = useTokens(); const u = useUnit();
  return <div style={{fontFamily: t.fonts.body, fontWeight: 500, fontSize: u(size), lineHeight: 1.25, ...style, color: readable(String(style?.color ?? color ?? t.colors.muted), t.colors.background)}}>{children}</div>;
}

/** Number that counts up from 0 as `progress` goes 0→1. */
export function CountUp({value, progress, decimals = 0, prefix = '', suffix = ''}: {value: number; progress: number; decimals?: number; prefix?: string; suffix?: string}) {
  const shown = (value * Math.min(1, Math.max(0, progress))).toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals});
  return <span style={{fontVariantNumeric: 'tabular-nums'}}>{prefix}{shown}{suffix}</span>;
}

/** Horizontal bar, grows with `progress`. `fraction` 0..1 of full width. */
export function Bar({fraction, progress, color, height = 28}: {fraction: number; progress: number; color?: string; height?: number}) {
  const t = useTokens(); const u = useUnit();
  return <div style={{height: u(height), borderRadius: u(height / 2), background: t.colors.muted + '33', overflow: 'hidden', width: '100%'}}>
    <div style={{height: '100%', width: `${Math.max(0, Math.min(1, fraction)) * Math.min(1, Math.max(0, progress)) * 100}%`, background: color ?? t.colors.primary, borderRadius: u(height / 2)}} />
  </div>;
}
