// EditStyle: every tunable value a planning stage uses. Stages keep no
// constants of their own, so learned styles (v2) are a data change.
import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const name = z.string().trim().min(1).max(80);
/** A colour every renderer reads: #RRGGBB, rgb() or rgba(). */
export const cssColor = z.string().trim().regex(/^(#[0-9a-fA-F]{6}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/);
/** A font weight, in hundreds. */
export const fontWeight = z.number().int().min(100).max(900).multipleOf(100);

export const captionStyleSchema = z.object({
  size: z.number().min(16).max(160).default(64),       // px at 1080 tall
  weight: fontWeight.default(800),
  color: hex.default("#FFFFFF"),
  highlight: hex.default("#FFB020"),
  background: cssColor.default("rgba(0,0,0,0.45)"),
  font: name.optional(),                              // unset = the brand's body font
  position: z.enum(["bottom", "middle", "top"]).default("bottom"),
  maxWords: z.number().int().min(1).max(12).default(7),
  maxChars: z.number().int().min(10).max(120).default(42),
  maxWordsPerSecond: z.number().min(1).max(8).default(4.5), // reading-speed limit
  case: z.enum(["none", "upper"]).default("none"),
  /** Outline around the letters; width is px at 1080 tall, 0 = none. */
  strokeColor: hex.default("#000000"),
  strokeWidth: z.number().min(0).max(24).default(0),
  /** Soft drop shadow, px of blur at 1080 tall; 0 = none. */
  shadow: z.number().min(0).max(40).default(0),
  /** What `background` sits behind: the whole line, or nothing. */
  box: z.enum(["line", "none"]).default("line"),
  /**
   * How the spoken word shows. "highlight": it takes the highlight colour.
   * "pop": the same, and it grows. "pill": a box in the highlight colour sits
   * behind it. "karaoke": words not yet said are dim. "word": one word on
   * screen at a time.
   */
  animation: z.enum(["none", "highlight", "pop", "pill", "karaoke", "word"]).default("none"),
}).strict();
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export type CaptionAnimation = CaptionStyle["animation"];

/**
 * Ready-made caption looks. Each is laid over the current caption style, so
 * the brand's font and position stay unless the look sets them. `maxWords`
 * and `maxChars` apply when captions are next built: big type needs short
 * lines.
 */
export const CAPTION_PRESETS = {
  classic: { name: "Classic", style: { size: 56, weight: 700, color: "#FFFFFF", highlight: "#FFFFFF", background: "rgba(0,0,0,0.6)", box: "line", case: "none", strokeWidth: 0, shadow: 0, animation: "none", maxWords: 7, maxChars: 42 } },
  clean: { name: "Clean", style: { size: 60, weight: 600, color: "#FFFFFF", highlight: "#FFFFFF", box: "none", case: "none", strokeColor: "#000000", strokeWidth: 3, shadow: 12, animation: "none", maxWords: 6, maxChars: 36 } },
  bold: { name: "Bold", style: { size: 84, weight: 900, color: "#FFFFFF", highlight: "#FFE600", box: "none", case: "upper", strokeColor: "#000000", strokeWidth: 10, shadow: 6, animation: "pop", maxWords: 3, maxChars: 20 } },
  highlighter: { name: "Highlighter", style: { size: 72, weight: 800, color: "#FFFFFF", highlight: "#7C3AED", box: "none", case: "none", strokeColor: "#000000", strokeWidth: 4, shadow: 8, animation: "pill", maxWords: 4, maxChars: 24 } },
  karaoke: { name: "Karaoke", style: { size: 72, weight: 800, color: "#FFFFFF", highlight: "#22D3EE", box: "none", case: "none", strokeColor: "#000000", strokeWidth: 6, shadow: 6, animation: "karaoke", maxWords: 5, maxChars: 28 } },
  "one-word": { name: "One word", style: { size: 112, weight: 900, color: "#FFFFFF", highlight: "#FFFFFF", box: "none", case: "upper", strokeColor: "#000000", strokeWidth: 12, shadow: 8, animation: "word", maxWords: 3, maxChars: 20 } },
  boxed: { name: "Boxed", style: { size: 64, weight: 800, color: "#111111", highlight: "#E5484D", background: "rgba(255,255,255,0.94)", box: "line", case: "none", strokeWidth: 0, shadow: 0, animation: "highlight", maxWords: 4, maxChars: 26 } },
} as const satisfies Record<string, { name: string; style: Partial<CaptionStyle> }>;
export type CaptionPresetId = keyof typeof CAPTION_PRESETS;
export const CAPTION_PRESET_IDS = Object.keys(CAPTION_PRESETS) as CaptionPresetId[];

/** A caption style with a preset laid over it. */
export function withCaptionPreset(style: CaptionStyle, preset: CaptionPresetId): CaptionStyle {
  return captionStyleSchema.parse({ ...style, ...CAPTION_PRESETS[preset].style });
}

export const TEMPLATE_SLOTS = ["lowerThird", "chapter", "callout"] as const;

export const editStyleSchema = z.object({
  id: name,
  revision: z.number().int().nonnegative(),
  name,
  brand: z.object({
    colors: z.object({ primary: hex, accent: hex, background: hex, text: hex }).strict(),
    fonts: z.object({ heading: name, body: name }).strict(),
    logoAssetId: z.string().max(200).optional(),
    captionStyle: captionStyleSchema,
    templates: z.object({ lowerThird: name, chapter: name, callout: name }).strict(),
    graphicsKitVariant: name,
    safeMargins: z.number().min(0).max(0.2),            // fraction of width per edge
  }).strict(),
  pace: z.object({
    targetCutsPerMinute: z.number().min(0).max(120),
    maxPauseSeconds: z.number().min(0.1).max(10),
    minShotSeconds: z.number().min(0.2).max(30),
    brollCoverage: z.number().min(0).max(1),
    zoomFrequency: z.enum(["none", "low", "medium", "high"]),
    textDensity: z.enum(["minimal", "normal", "dense"]),
    captions: z.enum(["full", "keywords", "off"]),
  }).strict(),
  audio: z.object({
    musicLevelDb: z.number().min(-60).max(0),
    sfx: z.enum(["off", "subtle", "punchy"]),
    loudnessLufs: z.number().min(-30).max(-8),
  }).strict(),
  content: z.object({ keepFillers: z.boolean(), keepAsides: z.boolean(), keepRecaps: z.boolean() }).strict(),
  /** Below this model confidence an agent change is suggested, not applied. */
  applyConfidence: z.number().min(0).max(1).default(0.85),
}).strict();
export type EditStyle = z.infer<typeof editStyleSchema>;

const baseBrand: EditStyle["brand"] = {
  colors: { primary: "#6D5EF6", accent: "#FFB020", background: "#0E1016", text: "#FFFFFF" },
  fonts: { heading: "Inter", body: "Inter" },
  captionStyle: captionStyleSchema.parse({}),
  templates: { lowerThird: "lower-third", chapter: "chapter-card", callout: "callout" },
  graphicsKitVariant: "default",
  safeMargins: 0.05,
};
const baseContent: EditStyle["content"] = { keepFillers: false, keepAsides: true, keepRecaps: false };

function preset(id: string, name: string, pace: EditStyle["pace"], audio: EditStyle["audio"], content: Partial<EditStyle["content"]> = {}): EditStyle {
  return editStyleSchema.parse({ id, revision: 0, name, brand: baseBrand, pace, audio, content: { ...baseContent, ...content } });
}

/** v1 presets. Brand colours, fonts and logo come from the creator's brand assets via `withBrand`. */
export const STYLE_PRESETS = {
  "calm-explainer": preset("calm-explainer", "Calm explainer",
    { targetCutsPerMinute: 6, maxPauseSeconds: 0.8, minShotSeconds: 2.5, brollCoverage: 0.25, zoomFrequency: "low", textDensity: "normal", captions: "full" },
    { musicLevelDb: -26, sfx: "off", loudnessLufs: -14 }),
  "fast-paced": preset("fast-paced", "Fast-paced",
    { targetCutsPerMinute: 18, maxPauseSeconds: 0.35, minShotSeconds: 0.8, brollCoverage: 0.45, zoomFrequency: "high", textDensity: "dense", captions: "keywords" },
    { musicLevelDb: -22, sfx: "punchy", loudnessLufs: -14 }),
  podcast: preset("podcast", "Podcast",
    { targetCutsPerMinute: 3, maxPauseSeconds: 1.2, minShotSeconds: 4, brollCoverage: 0.05, zoomFrequency: "none", textDensity: "minimal", captions: "full" },
    { musicLevelDb: -30, sfx: "off", loudnessLufs: -16 }, { keepAsides: true, keepRecaps: true }),
  tutorial: preset("tutorial", "Tutorial",
    { targetCutsPerMinute: 8, maxPauseSeconds: 0.6, minShotSeconds: 1.5, brollCoverage: 0.15, zoomFrequency: "medium", textDensity: "normal", captions: "full" },
    { musicLevelDb: -30, sfx: "subtle", loudnessLufs: -14 }, { keepAsides: false }),
} as const satisfies Record<string, EditStyle>;
export type StylePresetId = keyof typeof STYLE_PRESETS;

/** Preset + the creator's brand. Returns a new style; presets are never mutated. */
export function withBrand(style: EditStyle, brand: {
  colors?: Partial<EditStyle["brand"]["colors"]>;
  fonts?: Partial<EditStyle["brand"]["fonts"]>;
  logoAssetId?: string;
}): EditStyle {
  return editStyleSchema.parse({
    ...structuredClone(style),
    brand: { ...structuredClone(style.brand), ...structuredClone(brand), colors: { ...style.brand.colors, ...brand.colors }, fonts: { ...style.brand.fonts, ...brand.fonts } },
  });
}
