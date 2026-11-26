// Remotion root for native scenes: one composition, `scene`, that renders a
// built-in (SCENES) or the agent's custom.tsx with validated props.
// inputProps: {scene, props, seconds, width, height, fonts}. The composition is
// laid out at a design size whose short side is 1080 px; render.mjs scales it.
import {useState} from 'react';
import {Composition, continueRender, delayRender, registerRoot, staticFile} from 'remotion';
import {SCENES} from './builtins';
import * as custom from './custom';
import type {SceneModule} from './types';

export const FPS = 30;
type Input = {scene: string; props: Record<string, unknown>; seconds: number; width: number; height: number; fonts: string[]};

const WEIGHTS: Record<string, number> = {Thin: 100, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, ExtraBold: 800, Black: 900};
const FAMILIES: Record<string, string> = {JetBrainsMono: 'JetBrains Mono', InstrumentSerif: 'Instrument Serif', PixelifySans: 'Pixelify Sans'};
/** `Inter-SemiBold.otf` → {family: Inter, weight: 600}. */
export function fontFace(file: string) {
  const [base = '', style = 'Regular'] = file.replace(/\.(ttf|otf|woff2?)$/i, '').split('-');
  const italic = /Italic$/.test(style), w = style.replace(/Italic$/, '') || 'Regular';
  return {family: FAMILIES[base] ?? base, weight: WEIGHTS[w] ?? 400, style: italic ? 'italic' : 'normal'};
}

/** Size the scene is laid out at: short side 1080, same aspect as the canvas. */
export function designSize(width: number, height: number) {
  const k = 1080 / Math.min(width, height);
  return {width: Math.round(width * k / 2) * 2, height: Math.round(height * k / 2) * 2};
}

function pick(name: string): {schema: SceneModule['schema']; defaults: Record<string, unknown>; Component: React.FC<any>} {
  if (name === 'custom') return {schema: custom.schema, defaults: custom.defaultProps, Component: custom.default};
  const s = (SCENES as Record<string, (typeof SCENES)[keyof typeof SCENES]>)[name];
  if (!s) throw new Error(`no scene "${name}"`);
  return {schema: s.schema, defaults: s.defaults, Component: s.Component};
}

function Scene({scene, props, seconds, fonts}: Input) {
  const [ready, setReady] = useState(false);
  useState(() => {
    const h = delayRender('scene: fonts');
    Promise.all(fonts.map(f => {
      const o = fontFace(f), face = new FontFace(o.family, `url(${staticFile(`fonts/${f}`)})`, {weight: String(o.weight), style: o.style});
      return face.load().then(l => {(document.fonts as unknown as {add(f: FontFace): void}).add(l);}, () => undefined);
    })).then(() => {setReady(true); continueRender(h);});
  });
  const s = pick(scene);
  const parsed = s.schema.safeParse({...s.defaults, ...props});
  if (!parsed.success) throw new Error(`props do not fit ${scene}: ${parsed.error.message.slice(0, 400)}`);
  return ready ? <s.Component {...parsed.data} durationFrames={Math.max(1, Math.round(seconds * FPS))} /> : null;
}

const Root = () => <Composition id="scene" component={Scene as React.FC<any>} fps={FPS} width={1920} height={1080} durationInFrames={FPS}
  defaultProps={{scene: 'Title', props: {}, seconds: 1, width: 1920, height: 1080, fonts: []} satisfies Input}
  calculateMetadata={({props}) => {const p = props as Input; return {...designSize(p.width, p.height), durationInFrames: Math.max(1, Math.round(p.seconds * FPS))};}} />;

registerRoot(Root);
