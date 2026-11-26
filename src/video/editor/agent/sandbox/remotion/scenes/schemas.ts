// Props of the built-in scenes: zod schemas and defaults. Pure data, so the
// agent tools (Bun) and the Remotion sandbox share them.
import {z} from 'zod/v4';

/** Fonts the renderer ships (public/fonts). */
export const FONTS = ['Inter', 'JetBrains Mono'] as const;

export const color = (d = '') => z.string().meta({ui: 'color', label: d});
export const num = (min: number, max: number, step = 1) => z.number().min(min).max(max).meta({step});
export const font = () => z.string().meta({ui: 'font', options: FONTS});
export const weight = () => num(100, 900, 100);

const xy = {x: num(0, 1, 0.01), y: num(0, 1, 0.01)};
const motion = z.enum(['classic', 'pro']).describe('classic: spring and fade; pro: flowIn/flowOut with motion blur');
const speed = num(0.5, 2, 0.05).describe('tempo of entrance and exit, shape unchanged');

export const TitleSchema = z.object({
  text: z.string().describe('*word* takes the accent colour; a newline breaks the line'),
  ...xy,
  background: color('Background'), color: color('Text'), accent: color('Accent word'),
  font: font(), fontWeight: weight(), fontSize: num(40, 240),
  shadowBlur: num(0, 80), shadowOpacity: num(0, 1, 0.05),
  fade: z.boolean().describe('fade in and out; without it, hard cut'),
  motion,
  reveal: z.enum(['words', 'whole']).describe('pro: word by word when the title follows the voice, whole when it adds unsaid context'),
  speed,
});

export const LowerThirdSchema = z.object({
  title: z.string(), subtitle: z.string(), ...xy,
  background: color('Background'), color: color('Text'),
  font: font(), fontWeight: weight(), fontSize: num(24, 120), subtitleSize: num(12, 120),
  radius: num(0, 60), shadowBlur: num(0, 80), shadowOpacity: num(0, 1, 0.05), shadowDistance: num(0, 40),
  float: num(0, 40), glassBlur: num(0, 60).describe('frosted glass; pair with a semi-transparent background'),
  motion, speed,
});

export const SparklesSchema = z.object({
  count: num(1, 40), ...xy, width: num(0.05, 1, 0.01), height: num(0.05, 1, 0.01),
  size: num(10, 200), color: color('Sparkle'), glow: num(0, 60), twinkles: num(1, 10), seed: num(0, 999),
});

export const ProgressBarSchema = z.object({y: num(0, 1, 0.01), height: num(2, 60), color: color('Bar'), track: color('Track')});

export const RecSchema = z.object({
  text: z.string(), ...xy, size: num(16, 160), color: color('Dot'), textColor: color('Text'), font: font(), blinksPerSecond: num(0.2, 4, 0.1),
});

export const FlashSchema = z.object({
  ...xy, color: color('Flash'), spread: num(0.2, 3, 0.05).describe('glow radius in frame widths (over 1.5: whole frame)'),
});

export const WordStackSchema = z.object({
  text: z.string().describe('words in arrival order; *word* = key word (key font and colour)'),
  times: z.string().describe('one time per word (s from start); empty = one word every `every` s'),
  every: num(0.05, 1, 0.01), ...xy, width: num(0.2, 1, 0.01), height: num(0.1, 1, 0.01), seed: num(1, 99),
  font: font(), fontWeight: weight(), fontSize: num(30, 240), color: color('Text'),
  keyFont: font(), keyItalic: z.boolean(), keySize: num(40, 400), keyColor: color('Key word'),
  zoom: num(0, 0.6, 0.01).describe('group pull-back over the whole duration (0.25 = starts at 125%)'),
  blur: num(0, 60), shadowBlur: num(0, 80), shadowOpacity: num(0, 1, 0.05),
});

export const AnnotateSchema = z.object({
  shape: z.enum(['underline', 'circle', 'strike', 'box']),
  x: num(0, 1, 0.01).describe('marked area: top-left corner, width and height as frame fractions'),
  y: num(0, 1, 0.01), width: num(0.02, 1, 0.01), height: num(0.02, 1, 0.01),
  color: color('Stroke'), thickness: num(2, 40), glow: num(0, 30), speed, seed: num(1, 99),
});

export const HookSchema = z.object({
  text: z.string().describe('newline breaks the line; *word* = accent colour'),
  ...xy, maxWidth: num(0.3, 1, 0.01).describe('max width as a frame fraction; wraps past it'),
  color: color('Text'), boxColor: color('Box'), accent: color('Accent word'),
  font: font(), fontWeight: weight(), fontSize: num(24, 200), radius: num(0, 60), shadowOpacity: num(0, 1, 0.05), speed,
});

export const BUILTIN_SCENES = {
  Title: {
    schema: TitleSchema, about: 'Full-screen title on a solid background; pro reveals word by word.',
    defaults: {text: 'Title', x: 0.5, y: 0.5, background: '#111111', color: '#ffffff', accent: '#ffd400', font: 'Inter', fontWeight: 800, fontSize: 120, shadowBlur: 0, shadowOpacity: 0.5, fade: false, motion: 'classic', reveal: 'words', speed: 1},
  },
  LowerThird: {
    schema: LowerThirdSchema, about: 'Name card on a transparent frame; arrives from the nearest edge.',
    defaults: {title: 'Name', subtitle: '', x: 0.15, y: 0.25, background: '#ffffff', color: '#111111', font: 'Inter', fontWeight: 800, fontSize: 56, subtitleSize: 31, radius: 24, shadowBlur: 30, shadowOpacity: 0.35, shadowDistance: 12, float: 0, glassBlur: 0, motion: 'classic', speed: 1},
  },
  Hook: {
    schema: HookSchema, about: 'Short-form hook: text on one rounded box with hollow joins between lines.',
    defaults: {text: 'The hook\non two lines', x: 0.5, y: 0.3, maxWidth: 0.8, color: '#111111', boxColor: '#ffffff', accent: '#fe2c55', font: 'Inter', fontWeight: 800, fontSize: 76, radius: 16, shadowOpacity: 0, speed: 1},
  },
  Annotate: {
    schema: AnnotateSchema, about: 'Hand-drawn underline, circle, strike or box drawn on, then erased from its tail.',
    defaults: {shape: 'underline', x: 0.3, y: 0.45, width: 0.4, height: 0.1, color: '#ffd400', thickness: 10, glow: 0, speed: 1, seed: 1},
  },
  Sparkles: {
    schema: SparklesSchema, about: 'Twinkling star icons over an area.',
    defaults: {count: 14, x: 0.05, y: 0.05, width: 0.9, height: 0.5, size: 60, color: '#ffe27a', glow: 18, twinkles: 3, seed: 1},
  },
  ProgressBar: {
    schema: ProgressBarSchema, about: 'Bar that fills left to right over its whole duration.',
    defaults: {y: 0, height: 12, color: '#ffd400', track: '#ffffff33'},
  },
  Rec: {
    schema: RecSchema, about: 'Blinking REC dot and label.',
    defaults: {text: 'REC', x: 0.85, y: 0.05, size: 48, color: '#ff2a2a', textColor: '#ffffff', font: 'Inter', blinksPerSecond: 1},
  },
  WordStack: {
    schema: WordStackSchema, about: '"3D" stacked words: each lands with a blur reveal while the group pulls back.',
    defaults: {text: 'Let me show you how *3D* this can look', times: '', every: 0.22, x: 0.5, y: 0.45, width: 0.6, height: 0.3, seed: 1, font: 'Inter', fontWeight: 700, fontSize: 90, color: '#ffffff', keyFont: 'Inter', keyItalic: true, keySize: 220, keyColor: '#ffffff', zoom: 0.25, blur: 24, shadowBlur: 20, shadowOpacity: 0.4},
  },
  Flash: {
    schema: FlashSchema, about: 'Transition: glow grows to a full white frame at its middle; place it across a cut.', transition: true,
    defaults: {x: 0.5, y: 0.5, color: '#ffffff', spread: 2},
  },
} as const satisfies Record<string, {schema: z.ZodObject; about: string; defaults: Record<string, unknown>; transition?: boolean}>;

export type BuiltinScene = keyof typeof BUILTIN_SCENES;
export const BUILTIN_NAMES = Object.keys(BUILTIN_SCENES) as BuiltinScene[];
