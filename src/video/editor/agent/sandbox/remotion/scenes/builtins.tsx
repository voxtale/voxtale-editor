// Built-in scenes as native Remotion components.
// Timing rule: entrance and exit keep a fixed length at the ends; any move that
// lasts the whole scene (float, slow zoom) runs on `life` (0 → 1), so it stretches with it.
import {useMemo} from 'react';
import type {z} from 'zod/v4';
import {AbsoluteFill, accentParts, clamp, curves, floatOffset, fontFamily, hookLines, interpolate, moderate, MotionBlur, proTimes, random,
  shadow, stackPath, textWidth, transitionLevel, useCurrentFrame, useInOut, useVideoConfig} from './kit';
import {AnnotateSchema, BUILTIN_SCENES, FlashSchema, HookSchema, LowerThirdSchema, ProgressBarSchema, RecSchema, SparklesSchema, TitleSchema, WordStackSchema,
  type BuiltinScene} from './schemas';

type P<S extends z.ZodType> = z.infer<S> & {durationFrames: number};
const ease = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

function Title(p: P<typeof TitleSchema>) {
  const {progress, opacity} = useInOut(p.durationFrames);
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pro = p.motion === 'pro';
  // Pro: a straight sweep (1.77 s word by word); each word rises its own height on the moderate curve, no bounce. Whole: all words together.
  const tokens = accentParts(p.text).flatMap(part => part.text.split(/( |\n)/).filter(w => w && w !== ' ').map(w => ({w, accent: part.accent})));
  const order = tokens.map((_, i) => tokens.slice(0, i).filter(t => t.w !== '\n').length);
  const words = tokens.filter(t => t.w !== '\n');
  const each = Math.round((0.8 * fps) / p.speed);
  const sweep = p.reveal === 'words' ? Math.max(each, Math.round((1.77 * fps) / p.speed)) : each;
  const gap = words.length > 1 ? (sweep - each) / (words.length - 1) : 0;
  return (
    <AbsoluteFill style={{background: p.background, opacity: p.fade ? opacity : 1}}>
      <div style={{
        position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: 'max-content', maxWidth: '88%',
        fontFamily: fontFamily(p.font), fontWeight: p.fontWeight, fontSize: p.fontSize, color: p.color, textAlign: 'center',
        lineHeight: 1.05, whiteSpace: 'pre-line', transform: pro ? 'translate(-50%, -50%)' : `translate(-50%, calc(-50% + ${(1 - progress) * 60}px))`,
        textShadow: shadow(p.shadowBlur, p.shadowOpacity, p.shadowBlur / 3),
      }}>
        {pro
          ? tokens.map(({w, accent}, i) => {
            if (w === '\n') return <br key={i} />;
            const at = order[i]! * gap;
            const rise = interpolate(frame, [at, at + each], [0, 1], {easing: moderate, ...clamp});
            const shown = interpolate(frame, [at, at + each * 0.4], [0, 1], clamp);
            return (
              <span key={i}>
                {i > 0 && tokens[i - 1]!.w !== '\n' && ' '}
                <span style={{display: 'inline-block', opacity: shown, transform: `translateY(${(1 - rise) * 1.05 * p.fontSize}px)`, color: accent ? p.accent : undefined}}>{w}</span>
              </span>
            );
          })
          : accentParts(p.text).map((part, i) => <span key={i} style={part.accent ? {color: p.accent} : undefined}>{part.text}</span>)}
      </div>
    </AbsoluteFill>
  );
}

function LowerThird(p: P<typeof LowerThirdSchema>) {
  const {progress, opacity, life} = useInOut(p.durationFrames);
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const dir = p.x < 0.5 ? -1 : 1; // arrives from the nearest edge
  // Pro: flies in on flowIn (0.9 s), leaves at once on flowOut (0.8 s) to the same edge, with motion blur; no fade out.
  const {enter, leave} = proTimes(p.durationFrames, fps, p.speed);
  const away = p.durationFrames - leave, far = width / 2;
  const x = (f: number) => (p.motion !== 'pro' ? dir * (1 - progress) * 120
    : f < away ? interpolate(f, [0, enter], [dir * far, 0], {easing: curves.flowIn, ...clamp})
      : interpolate(f, [away, p.durationFrames - 1], [0, dir * far], {easing: curves.flowOut, ...clamp}));
  const style: React.CSSProperties = {
    position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: 'max-content', maxWidth: '80%',
    opacity: p.motion === 'pro' ? interpolate(frame, [0, 3], [0, 1], clamp) : opacity,
    transform: `translate(calc(-50% + ${x(frame)}px), calc(-50% + ${floatOffset(life, p.float)}px))`,
    background: p.background, color: p.color, borderRadius: p.radius, padding: '28px 40px',
    fontFamily: fontFamily(p.font), boxShadow: shadow(p.shadowBlur, p.shadowOpacity, p.shadowDistance),
    ...(p.glassBlur > 0 && {backdropFilter: `blur(${p.glassBlur}px) saturate(1.4)`, border: '1.5px solid rgba(255,255,255,0.35)'}),
  };
  const content = <>
    <div style={{fontSize: p.fontSize, fontWeight: p.fontWeight, lineHeight: 1.1}}>{p.title}</div>
    {p.subtitle && <div style={{fontSize: p.subtitleSize, opacity: 0.75, marginTop: 8}}>{p.subtitle}</div>}
  </>;
  return <AbsoluteFill>{p.motion === 'pro' ? <MotionBlur x={x} style={style}>{content}</MotionBlur> : <div style={style}>{content}</div>}</AbsoluteFill>;
}

function Sparkles(p: P<typeof SparklesSchema>) {
  const {opacity, life} = useInOut(p.durationFrames);
  return (
    <AbsoluteFill style={{opacity}}>
      {Array.from({length: p.count}, (_, i) => {
        const r = (k: number) => random(`${p.seed}-${i}-${k}`);
        const pulse = Math.max(0, Math.sin((life * p.twinkles + r(3)) * Math.PI * 2)); // each star twinkles `twinkles` times, offset
        const s = p.size * (0.5 + r(2) * 0.7);
        return (
          <svg key={i} viewBox="-10 -10 20 20" width={s} height={s} style={{
            position: 'absolute', left: `${(p.x + r(0) * p.width) * 100}%`, top: `${(p.y + r(1) * p.height) * 100}%`,
            transform: `translate(-50%, -50%) scale(${pulse}) rotate(${life * 180 + r(4) * 90}deg)`,
            filter: p.glow ? `drop-shadow(0 0 ${p.glow / 3}px ${p.color})` : undefined,
          }}>
            <path d="M0-10 Q1.2-1.2 10 0 Q1.2 1.2 0 10 Q-1.2 1.2 -10 0 Q-1.2-1.2 0-10Z" fill={p.color} />
          </svg>
        );
      })}
    </AbsoluteFill>
  );
}

function ProgressBar(p: P<typeof ProgressBarSchema>) {
  const {life} = useInOut(p.durationFrames); // no fade: visible start to end
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 0, right: 0, top: `${p.y * 100}%`, height: p.height, background: p.track}}>
        <div style={{width: `${life * 100}%`, height: '100%', background: p.color}} />
      </div>
    </AbsoluteFill>
  );
}

function Rec(p: P<typeof RecSchema>) {
  const {opacity} = useInOut(p.durationFrames);
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const on = Math.floor((frame / fps) * p.blinksPerSecond * 2) % 2 === 0; // fixed rate, not `life`: a REC light does not slow down
  return (
    <AbsoluteFill style={{opacity}}>
      <div style={{
        position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: 'translate(-50%, -50%)',
        display: 'flex', alignItems: 'center', gap: p.size * 0.35,
        fontFamily: fontFamily(p.font), fontWeight: 800, fontSize: p.size, color: p.textColor, letterSpacing: '0.05em', textShadow: '0 2px 8px rgba(0,0,0,0.5)',
      }}>
        <div style={{width: p.size * 0.7, height: p.size * 0.7, borderRadius: '50%', background: p.color, opacity: on ? 1 : 0.15}} />
        {p.text}
      </div>
    </AbsoluteFill>
  );
}

// A transition: at least one fully opaque frame over the whole image at its middle (transitionLevel), which hides the cut.
function Flash(p: P<typeof FlashSchema>) {
  const level = transitionLevel(useCurrentFrame(), p.durationFrames);
  return <AbsoluteFill style={{
    opacity: level,
    background: level >= 1 ? p.color : `radial-gradient(circle at ${p.x * 100}% ${p.y * 100}%, ${p.color} 0%, ${p.color} ${p.spread * 25 * level}%, transparent ${p.spread * 70}%)`,
  }} />;
}

const rand = (seed: number) => () => {seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646;};

// Words land one by one, each at its own size and place, revealed by a blur; the group pulls back slowly,
// each word at its depth (near ones faster), which gives relief. Editors' recipe: one layer per word, blur reveal, zoom out.
function WordStack(p: P<typeof WordStackSchema>) {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const life = Math.min(1, frame / Math.max(1, p.durationFrames - 1));
  const words = useMemo(() => p.text.split(/\s+/).filter(Boolean).map(w => (/^\*.+\*$/.test(w) ? {text: w.slice(1, -1), key: true} : {text: w, key: false})), [p.text]);
  const times = p.times.split(/[\s,;]+/).map(Number).filter(n => Number.isFinite(n) && p.times.trim() !== '');
  // Each word at the spot farthest from the earlier ones out of 24 tries; random size and depth.
  const spots = useMemo(() => {
    const r = rand(p.seed * 7919), out: {x: number; y: number; size: number; depth: number}[] = [];
    for (const w of words) {
      let best = {x: 0, y: 0}, far = -1;
      for (let k = 0; k < 24; k++) {
        const c = {x: (r() - 0.5) * p.width * width, y: (r() - 0.5) * p.height * height};
        const d = Math.min(...out.map(o => Math.hypot((o.x - c.x) / 1.6, o.y - c.y)), Infinity);
        if (d > far) {far = d; best = c;}
      }
      out.push({...best, size: w.key ? p.keySize : p.fontSize * [1, 0.55, 0.8, 1.25, 0.65][out.length % 5]!, depth: 0.4 + r() * 0.6});
    }
    return out;
  }, [words, p.seed, p.width, p.height, p.fontSize, p.keySize, width, height]);
  return (
    <AbsoluteFill>
      {words.map((w, k) => {
        const at = Math.round((times[k] ?? (times.length ? (times.at(-1) ?? 0) + p.every * (k - times.length + 1) : p.every * k)) * fps);
        if (frame < at) return null;
        const r = ease((frame - at) / (0.3 * fps)); // 0.3 s out of the blur
        const s = spots[k]!, depth = 1 + p.zoom * (1 - life) * s.depth * 2;
        return (
          <div key={k} style={{
            position: 'absolute', left: p.x * width + s.x * depth, top: p.y * height + s.y * depth, transform: `translate(-50%, -50%) scale(${depth * (1.12 - 0.12 * r)})`,
            fontFamily: fontFamily(w.key ? p.keyFont : p.font), fontStyle: w.key && p.keyItalic ? 'italic' : 'normal', fontWeight: w.key ? 400 : p.fontWeight,
            fontSize: s.size, color: w.key ? p.keyColor : p.color, whiteSpace: 'nowrap', lineHeight: 1, opacity: r,
            filter: r < 1 ? `blur(${(1 - r) * p.blur}px)` : undefined, textShadow: shadow(p.shadowBlur, p.shadowOpacity, p.shadowBlur / 4),
          }}>{w.text}</div>
        );
      })}
    </AbsoluteFill>
  );
}

// Draw time (s) per shape; past ~0.47 s a moving stroke reads as a loading bar. Then it leaves from its tail.
const DRAW = {underline: 0.33, strike: 0.33, box: 0.5, circle: 0.55}, ERASE = 0.25;

/** SVG path of a hand-drawn mark on the area (px): a little uneven, the same for the same seed. */
export function annotationPath(shape: z.infer<typeof AnnotateSchema>['shape'], x: number, y: number, w: number, h: number, seed: number) {
  const r = (k: string) => random(`annotate-${seed}-${k}`) * 2 - 1;
  const f = (n: number) => n.toFixed(1);
  if (shape === 'underline' || shape === 'strike') {
    const at = shape === 'underline' ? y + h * 1.02 : y + h * 0.55;
    const x0 = x - w * 0.02, x1 = x + w * 1.02, y0 = at + h * 0.03 * r('a'), y1 = at - h * (0.04 + 0.03 * r('b'));
    return `M ${f(x0)} ${f(y0)} Q ${f((x0 + x1) / 2)} ${f(at + h * 0.06 * r('c'))} ${f(x1)} ${f(y1)}`;
  }
  if (shape === 'box') {
    const pad = Math.min(w, h) * 0.12, j = (k: string) => Math.min(w, h) * 0.04 * r(k);
    const L = x - pad, T = y - pad, R = x + w + pad, B = y + h + pad;
    const pts = [[L + j('1'), T + j('2')], [R + j('3'), T + j('4')], [R + j('5'), B + j('6')], [L + j('7'), B + j('8')], [L + j('9'), T + j('10')], [L + (R - L) * 0.12, T + j('11')]];
    return pts.map(([px, py], i) => `${i ? 'L' : 'M'} ${f(px!)} ${f(py!)}`).join(' ');
  }
  // An ellipse a little larger than the area, from the top left, overshooting its start (1.1 turns) as it tightens.
  const cx = x + w / 2, cy = y + h / 2, rx = (w / 2) * 1.14, ry = (h / 2) * 1.45, a0 = -Math.PI * 0.62, phase = r('p') * Math.PI;
  return Array.from({length: 61}, (_, i) => {
    const t = i / 60, a = a0 + t * Math.PI * 2 * 1.1, k = (1 + 0.035 * Math.sin(2 * a + phase)) * (1 - 0.07 * t);
    return `${i ? 'L' : 'M'} ${f(cx + Math.cos(a) * rx * k)} ${f(cy + Math.sin(a) * ry * k)}`;
  }).join(' ');
}

function Annotate(p: P<typeof AnnotateSchema>) {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const d = useMemo(() => annotationPath(p.shape, p.x * width, p.y * height, p.width * width, p.height * height, p.seed),
    [p.shape, p.x, p.y, p.width, p.height, p.seed, width, height]);
  const draw = Math.max(1, Math.round((DRAW[p.shape] * fps) / p.speed)), erase = Math.max(1, Math.round((ERASE * fps) / p.speed));
  // Stroke of length 1 (pathLength): offset 1 hidden, 0 drawn, −1 erased from its start.
  const offset = frame < p.durationFrames - erase
    ? interpolate(frame, [0, draw], [1, 0], {easing: curves.glide, ...clamp})
    : interpolate(frame, [p.durationFrames - erase, p.durationFrames - 1], [0, -1], {easing: curves.glide, ...clamp});
  return (
    <AbsoluteFill>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{position: 'absolute', overflow: 'visible'}}>
        <path d={d} pathLength={1} strokeDasharray="1 1" strokeDashoffset={offset} fill="none" stroke={p.color} strokeWidth={p.thickness}
          strokeLinecap="round" strokeLinejoin="round" style={p.glow ? {filter: `drop-shadow(0 0 ${p.glow}px ${p.color})`} : undefined} />
      </svg>
    </AbsoluteFill>
  );
}

function Hook(p: P<typeof HookSchema>) {
  const frame = useCurrentFrame();
  const {fps, height, width: videoWidth} = useVideoConfig();
  // Rises on flowIn (0.9 s), leaves upward on flowOut (0.8 s) with motion blur; opacity in over 3 frames, out over the last 3. No pop.
  const {enter, leave} = proTimes(p.durationFrames, fps, p.speed);
  const away = p.durationFrames - leave, far = height * 0.12;
  const y = (f: number) => (f < away
    ? interpolate(f, [0, enter], [far, 0], {easing: curves.flowIn, ...clamp})
    : interpolate(f, [away, p.durationFrames - 1], [0, -far], {easing: curves.flowOut, ...clamp}));
  const opacity = Math.min(interpolate(frame, [0, 3], [0, 1], clamp), interpolate(frame, [p.durationFrames - 4, p.durationFrames - 1], [1, 0], clamp));
  const family = fontFamily(p.font), cssFont = `${p.fontWeight} ${p.fontSize}px ${family}`;
  const padX = 0.42 * p.fontSize, lh = 1.42 * p.fontSize;
  const lines = useMemo(() => hookLines(accentParts(p.text), t => textWidth(t, cssFont), p.maxWidth * videoWidth - 2 * padX - 1)
    .map(l => ({...l, half: textWidth(l.text, cssFont) / 2 + padX})), [p.text, cssFont, p.maxWidth, videoWidth, padX]);
  if (!lines.length) return null;
  const boxW = 2 * Math.max(...lines.map(l => l.half)), boxH = lines.length * lh;
  return (
    <AbsoluteFill>
      <MotionBlur y={y} style={{position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: boxW, height: boxH, opacity, transform: `translate(-50%, calc(-50% + ${y(frame)}px))`}}>
        <svg width={boxW} height={boxH} style={{position: 'absolute', inset: 0, overflow: 'visible', filter: p.shadowOpacity > 0 ? `drop-shadow(${shadow(24, p.shadowOpacity, 8)})` : undefined}}>
          <path d={stackPath(lines.map(l => l.half), lh, p.radius)} fill={p.boxColor} />
        </svg>
        {lines.map((l, i) => (
          <div key={i} style={{position: 'relative', height: lh, lineHeight: `${lh}px`, textAlign: 'center', whiteSpace: 'pre', fontFamily: family, fontWeight: p.fontWeight, fontSize: p.fontSize, color: p.color}}>
            {l.segs.map((s, j) => <span key={j} style={s.accent ? {color: p.accent} : undefined}>{s.text}</span>)}
          </div>
        ))}
      </MotionBlur>
    </AbsoluteFill>
  );
}

const COMPONENTS = {Title, LowerThird, Hook, Annotate, Sparkles, ProgressBar, Rec, WordStack, Flash} satisfies Record<BuiltinScene, unknown>;

/** Built-in scene registry: schema and defaults from schemas.ts, plus the component. */
export const SCENES = Object.fromEntries(Object.entries(BUILTIN_SCENES).map(([k, v]) => [k, {...v, Component: COMPONENTS[k as BuiltinScene] as React.FC<any>}])) as
  Record<BuiltinScene, (typeof BUILTIN_SCENES)[BuiltinScene] & {Component: React.FC<any>}>;
