// EditDoc v6: multi-clip edit on a fixed set of tracks. Plan §1. v3 moved
// zoom off a-roll items onto its own track; v4 added transitions, J/L cuts,
// zoom curves, picture fades, word fixes and variants; v5 added a colour
// grade per clip and a beat's confidence and lively point; v6 added sync
// groups (cameras and mics recorded together), a piece's angle, mic and
// split / picture-in-picture layout, a clip's sound offset and its colour
// space (log, HDR, input LUT), and a graphic's behindSubject (text behind
// the speaker), all optional (`upgradeEditDoc` lifts v2-v5).
// Pure zod; no I/O. Times are seconds, frame-snapped by `validateEditDoc`.
import { z } from "zod";
import { fpsSchema } from "./time";
import { cssColor, editStyleSchema, fontWeight } from "./style";
import { gradeSchema } from "./grade";

export const EDITDOC_VERSION = 6 as const;

const id = z.string().regex(/^[A-Za-z0-9_.:~-]{1,120}$/); // "~" marks suggestion ids ("a1~r4")
const time = z.number().finite().nonnegative();
const text = (max: number) => z.string().trim().min(1).max(max);
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const TRACK_KINDS = ["a-roll", "b-roll", "captions", "text", "graphics", "music", "sfx", "voiceover", "zoom"] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];
/** Markers are policy-controlled like a track (structure stage owns them). */
export const POLICY_KEYS = [...TRACK_KINDS, "markers"] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];

/** mic: a sound-only file recorded with the cameras (lav, recorder), heard in step with them. */
export const CLIP_ROLES = ["a-roll", "b-roll", "screen", "music", "sfx", "voiceover", "logo", "other", "mic"] as const;

/** Integrated loudness and true peak of the clip's audio (EBU R128), measured on the creator's machine. */
export const loudnessSchema = z.object({
  lufs: z.number().min(-70).max(10),
  truePeakDb: z.number().min(-70).max(20),
}).strict();
export type Loudness = z.infer<typeof loudnessSchema>;

/** A steady beat: tempo, and seconds into the file of the first beat. */
export const beatsSchema = z.object({
  bpm: z.number().min(30).max(300),
  first: z.number().finite().nonnegative(),
  /** 0–1: how many beats of the grid land on a clear hit. Under BEAT_CONFIDENCE_MIN nothing snaps to it. */
  confidence: z.number().min(0).max(1).optional(),
  /** Seconds into the file where the track comes alive (past the intro): the default music in-point. */
  livelyFrom: z.number().finite().nonnegative().optional(),
}).strict();
/** Below this beat confidence, picture changes do not snap to the beat. REDACTED's ~0.4. */
export const BEAT_CONFIDENCE_MIN = 0.4;
export type ClipBeats = z.infer<typeof beatsSchema>;

export const clipColorSchema = z.object({
  /** Log profile name (LOG_PROFILES, or "Log" when the brand's is unknown). */
  log: z.string().trim().min(1).max(80).optional(),
  /** HDR transfer the camera wrote: HLG or PQ (BT.2020). */
  hdr: z.enum(["hlg", "pq"]).optional(),
  /** Tagged full range (Sony 8-bit HD log): code values read as is. */
  fullRange: z.boolean().optional(),
  /** camera: written in the file; picture: guessed from the darkest point. */
  from: z.enum(["camera", "picture"]).optional(),
  why: z.string().trim().max(200).optional(),
}).strict();
export type ClipColor = z.infer<typeof clipColorSchema>;

export const clipRefSchema = z.object({
  id,
  hash,                                   // sha256 of the original bytes
  name: text(260),                        // original file name, for people and relinking
  kind: z.enum(["video", "audio", "image"]),
  role: z.enum(CLIP_ROLES),
  roleSource: z.enum(["creator", "index"]),
  duration: z.number().finite().positive(),
  fps: fpsSchema.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  hasAudio: z.boolean().default(false),
  /** Source start timecode in seconds (camera files). Resolve links by it. */
  timecodeStart: time.default(0),
  indexRef: z.string().max(300).optional(),
  loudness: loudnessSchema.optional(),
  /** Music only: the file's tempo and the time of its first beat, when it has a steady pulse. */
  beats: beatsSchema.optional(),
  /** Colour grade for every frame of this clip, wherever it shows (video and image clips). */
  grade: gradeSchema.optional(),
  /**
   * Seconds the file's sound must be moved later to meet the lips (negative:
   * earlier). A camera that writes its sound ahead of the picture needs a
   * positive one. Every piece that plays this clip's sound is shifted.
   */
  avOffset: z.number().min(-2).max(2).optional(),
  /** What ingest read about the picture's colour: a log profile, HDR, full range. */
  color: clipColorSchema.optional(),
  /**
   * The creator's choice of colour space, as Premiere's "Override Media
   * Color Space": a profile from LOG_PROFILES, "hlg", "pq", or "Rec.709"
   * (no conversion). Unset: the detected one.
   */
  colorSpace: z.string().trim().min(1).max(80).optional(),
  /** A .cube (path on this machine) applied before the grade instead of the built-in conversion. */
  inputLut: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type ClipRef = z.infer<typeof clipRefSchema>;

export const evidenceSchema = z.object({
  kind: z.enum(["word", "shot", "segment", "beat", "claim", "note"]),
  ref: z.string().min(1).max(200),        // "clipId:wordId", segment id, beat id, …
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;

export const ITEM_STATUS = ["applied", "suggested", "remove-suggested"] as const;

const itemBase = {
  id,
  start: time,                            // output timeline seconds
  end: time,
  owner: z.enum(["agent", "creator"]),
  stage: z.string().max(60).optional(),
  reason: z.string().trim().max(300).optional(),
  evidence: z.array(evidenceSchema).max(40).optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(ITEM_STATUS).default("applied"),
  /** A suggestion that would replace this applied item when accepted. */
  replaces: id.optional(),
};
const clipRange = { clipId: id, in: time, out: time };

export const PIP_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type PipCorner = (typeof PIP_CORNERS)[number];

export const TRANSITION_KINDS = ["crossfade", "dip-black", "dip-white", "whip", "zoom"] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];
/** Kinds that show both pieces at once, so both need source past the join. */
export const OVERLAP_TRANSITIONS: readonly TransitionKind[] = ["crossfade", "whip"];
/**
 * A transition into this piece from the one before it on the same track,
 * which must end where this one starts. Its middle sits on the join: it plays
 * duration/2 either side. It rides on the piece, so ripple edits keep it on
 * the join and a join holds at most one. None = a hard cut.
 */
export const transitionSchema = z.object({
  kind: z.enum(TRANSITION_KINDS),
  duration: z.number().min(0.2).max(1),
}).strict();
export type Transition = z.infer<typeof transitionSchema>;

/** Longest picture fade: past this it reads as a slow dissolve, not a fade. Our pick. */
export const FADE_MAX = 5;
/**
 * Picture fades on any visual item, seconds: in from see-through at its start,
 * out to see-through at its end (over a-roll that shows the black under it).
 * Sound is untouched. In + out never exceed the item's length.
 */
const pictureFade = {
  fadeIn: z.number().positive().max(FADE_MAX).optional(),
  fadeOut: z.number().positive().max(FADE_MAX).optional(),
};

export const A_ROLL_LAYOUTS = ["camera", "screen", "split", "pip"] as const;
export const aRollItemSchema = z.object({
  ...itemBase, ...clipRange,
  /**
   * camera / screen: one picture. split: the picture and the first companion
   * side by side (top and bottom on a tall canvas). pip: the picture full
   * frame, the first companion small in `pipCorner`.
   */
  layout: z.enum(A_ROLL_LAYOUTS).optional(),
  /** Other clips of the same take shown alongside (screen + camera): companion time = this piece's source time + offset. */
  companions: z.array(z.object({ clipId: id, offset: z.number().finite() }).strict()).max(4).optional(),
  pipCorner: z.enum(PIP_CORNERS).optional(),
  /**
   * Picture from this member of the clip's sync group, in step: `in`/`out`
   * stay in `clipId`'s time (its words, captions and zooms hold), the
   * render reads the angle at the same moment.
   */
  angle: id.optional(),
  /** Sound from this member of the clip's sync group (a lav, the other camera), in step, as `angle`. */
  mic: id.optional(),
  gainDb: z.number().min(-60).max(12).default(0),
  transition: transitionSchema.optional(),
  /**
   * J-cut: this piece's sound starts this many seconds before its picture,
   * under the end of the piece before (whose sound stops there).
   */
  audioLead: z.number().positive().max(3).optional(),
  /**
   * L-cut: this piece's sound runs this many seconds past its picture, under
   * the start of the piece after (whose sound starts there).
   */
  audioLag: z.number().positive().max(3).optional(),
  ...pictureFade,
}).strict();
export const bRollItemSchema = z.object({
  ...itemBase, ...clipRange,
  fit: z.enum(["cover", "contain"]).default("cover"),
  muted: z.boolean().default(true),
  opacity: z.number().min(0).max(1).default(1),
  /** Other shots that fit the same moment, for "try another shot". Same length as the item. */
  alternatives: z.array(z.object({ ...clipRange, reason: z.string().trim().max(300).optional() }).strict()).max(3).optional(),
  /** Part of the source frame shown, as fractions of it: a region of a screen, blown up. */
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.05).max(1), h: z.number().min(0.05).max(1) }).strict().optional(),
  /** Source seconds per output second (a slow stretch sped up). Source length = output length x speed. */
  speed: z.number().min(1).max(16).optional(),
  /** The speaker stays on screen in this corner, over the footage. */
  pip: z.enum(PIP_CORNERS).optional(),
  transition: transitionSchema.optional(),
  ...pictureFade,
}).strict();
export const captionItemSchema = z.object({
  ...itemBase,
  text: text(200),
  /** Source words this caption shows, as "clipId:wordId". Captions follow cuts through these. */
  words: z.array(z.string().max(160)).min(1).max(40),
  /**
   * When each word of `text` starts, in seconds from the caption's start, for
   * looks that follow the voice. One per word of `text`; a renderer that finds
   * a different count (the creator rewrote the line) shows the line whole.
   */
  wordStarts: z.array(z.number().min(0).max(600)).max(40).optional(),
}).strict();
const TEXT_TEMPLATES = ["lowerThird", "chapter", "callout", "title"] as const;
const TEXT_POSITIONS = ["auto", "top", "bottom", "left", "right", "center"] as const;
const GRAPHIC_PLACEMENTS = ["full", "left", "right", "top", "bottom", "center"] as const;
/** Most other versions an item keeps: enough to compare, few enough to look at. Our pick. */
export const VARIANTS_MAX = 3;
export const textItemSchema = z.object({
  ...itemBase,
  template: z.enum(TEXT_TEMPLATES),
  text: text(160),
  subtext: z.string().trim().max(160).optional(),
  position: z.enum(TEXT_POSITIONS).default("auto"),
  /** Other versions of this text, to try in its place; the item's own fields are the one shown. */
  variants: z.array(z.object({
    template: z.enum(TEXT_TEMPLATES).optional(),
    text: text(160),
    subtext: z.string().trim().max(160).optional(),
    position: z.enum(TEXT_POSITIONS).optional(),
  }).strict()).max(VARIANTS_MAX).optional(),
  /** Creator overrides on the template look; size is px at 1080 tall. */
  look: z.object({
    fontFamily: z.string().trim().min(1).max(80).optional(),
    fontSize: z.number().min(8).max(400).optional(),
    fontWeight: fontWeight.optional(),
    color: cssColor.optional(),
    backgroundColor: z.union([cssColor, z.literal("none")]).optional(),
  }).strict().optional(),
  ...pictureFade,
}).strict();
export const graphicItemSchema = z.object({
  ...itemBase,
  assetId: id,                            // graphicsAssets row; holds source, props, renders
  assetRevision: z.number().int().nonnegative().default(0),
  placement: z.enum(GRAPHIC_PLACEMENTS).default("full"),
  /** Other graphics for this moment, to try in its place; the item's own asset is the one shown. */
  variants: z.array(z.object({
    assetId: id,
    assetRevision: z.number().int().nonnegative().default(0),
    placement: z.enum(GRAPHIC_PLACEMENTS).optional(),
  }).strict()).max(VARIANTS_MAX).optional(),
  /** Drawn behind the speaker: the a-roll's subject (a person mask) goes back on top. Without a mask, drawn over as usual. */
  behindSubject: z.boolean().optional(),
  ...pictureFade,
}).strict();
export const musicItemSchema = z.object({
  ...itemBase, ...clipRange,
  gainDb: z.number().min(-60).max(6).default(-24),
  fadeIn: z.number().min(0).max(20).default(1),
  fadeOut: z.number().min(0).max(20).default(2),
  duck: z.boolean().default(true),
}).strict();
export const sfxItemSchema = z.object({
  ...itemBase, ...clipRange,
  gainDb: z.number().min(-60).max(6).default(-18),
  tiedTo: id.optional(),                  // item the effect belongs to
}).strict();
export const voiceoverItemSchema = z.object({
  ...itemBase, ...clipRange,
  gainDb: z.number().min(-60).max(12).default(0),
}).strict();

const unit = z.number().min(0).max(1);
/**
 * How a zoom moves, in time order. smooth: slow, fast, slow (the default);
 * linear: even; snap: fast start, slow landing; build: slow start, fast
 * landing; settle: fast, a touch past the target, back; hold: no move, then
 * a cut when the ease time is up.
 */
export const ZOOM_CURVES = ["smooth", "linear", "snap", "build", "settle", "hold"] as const;
export type ZoomCurve = (typeof ZOOM_CURVES)[number];
/**
 * A zoom on the a-roll over [start, end) of the output. It eases in from the
 * wide frame over `easeIn` seconds, holds, and eases back out over `easeOut`;
 * 0 is a cut; a slow push eases in over its whole length. Next to another
 * zoom it glides straight into it. The focus (x, y) stays fixed on screen;
 * `target: "face"` means editors re-aim it at the speaker when the zoom
 * moves, "point" means the creator placed it.
 */
export const zoomItemSchema = z.object({
  ...itemBase,
  scale: z.number().min(1).max(4),
  x: unit.default(0.5),
  y: unit.default(0.5),
  target: z.enum(["face", "point"]).default("face"),
  easeIn: z.number().min(0).max(60).default(0.35),
  easeOut: z.number().min(0).max(60).default(0.35),
  /** Shape of the move in over `easeIn`; default smooth. */
  curveIn: z.enum(ZOOM_CURVES).optional(),
  /** Shape of the move out over `easeOut`; default smooth. */
  curveOut: z.enum(ZOOM_CURVES).optional(),
  /** Focus glides here by the end of the zoom (code uses it to keep the eyes still across both cuts). */
  panTo: z.object({ x: unit, y: unit }).strict().optional(),
}).strict();

export const ITEM_SCHEMAS = {
  "a-roll": aRollItemSchema,
  "b-roll": bRollItemSchema,
  captions: captionItemSchema,
  text: textItemSchema,
  graphics: graphicItemSchema,
  music: musicItemSchema,
  sfx: sfxItemSchema,
  voiceover: voiceoverItemSchema,
  zoom: zoomItemSchema,
} as const satisfies Record<TrackKind, z.ZodType>;

export type ARollItem = z.infer<typeof aRollItemSchema>;
export type BRollItem = z.infer<typeof bRollItemSchema>;
export type CaptionItem = z.infer<typeof captionItemSchema>;
export type TextItem = z.infer<typeof textItemSchema>;
export type GraphicItem = z.infer<typeof graphicItemSchema>;
export type MusicItem = z.infer<typeof musicItemSchema>;
export type SfxItem = z.infer<typeof sfxItemSchema>;
export type VoiceoverItem = z.infer<typeof voiceoverItemSchema>;
export type ZoomItem = z.infer<typeof zoomItemSchema>;
export type ItemOf<K extends TrackKind> = z.infer<(typeof ITEM_SCHEMAS)[K]>;
export type Item = ItemOf<TrackKind>;
export type ClipItem = ARollItem | BRollItem | MusicItem | SfxItem | VoiceoverItem;
export const CLIP_TRACKS = ["a-roll", "b-roll", "music", "sfx", "voiceover"] as const satisfies readonly TrackKind[];

export const tracksSchema = z.object({
  "a-roll": z.array(aRollItemSchema).max(5000).default([]),
  "b-roll": z.array(bRollItemSchema).max(2000).default([]),
  captions: z.array(captionItemSchema).max(10000).default([]),
  text: z.array(textItemSchema).max(1000).default([]),
  graphics: z.array(graphicItemSchema).max(500).default([]),
  music: z.array(musicItemSchema).max(200).default([]),
  sfx: z.array(sfxItemSchema).max(2000).default([]),
  voiceover: z.array(voiceoverItemSchema).max(2000).default([]),
  zoom: z.array(zoomItemSchema).max(2000).default([]),
}).strict();
export type Tracks = z.infer<typeof tracksSchema>;

export const markerSchema = z.object({
  id,
  time,
  kind: z.enum(["chapter", "note"]),
  title: text(100),                       // YouTube chapter titles stay short
  owner: z.enum(["agent", "creator"]),
  stage: z.string().max(60).optional(),
  status: z.enum(ITEM_STATUS).default("applied"),
}).strict();
export type Marker = z.infer<typeof markerSchema>;

export const mixSchema = z.object({
  loudnessLufs: z.number().min(-30).max(-8).default(-14),
  truePeakDb: z.number().min(-9).max(0).default(-1),
  speechGainDb: z.number().min(-24).max(24).default(0),
  duckingDb: z.number().min(-40).max(0).default(-12),
  duckAttack: z.number().min(0).max(2).default(0.15),
  duckRelease: z.number().min(0).max(4).default(0.6),
  speechCleanup: z.enum(["off", "light", "strong"]).default("off"),
  cutFades: z.number().min(0).max(0.2).default(0.01), // seconds of audio crossfade at every cut
}).strict();
export type MixSettings = z.infer<typeof mixSchema>;

// Same fields as the outline agent's v2 beat (`outlineBeatSchema`), so an
// outline beat is a brief beat. tests-ts checks the two stay compatible.
export const BEAT_ROLES = ["hook", "setup", "context", "progress", "proof", "turn", "payoff", "ending"] as const;
export const briefBeatSchema = z.object({
  id: text(80),
  role: z.enum(BEAT_ROLES),
  title: text(150),
  content: text(1500),
  viewerChange: z.string().trim().max(500).default(""),
  proof: z.string().max(500).default(""),
  visual: z.string().max(500).default(""),
  visualStatus: z.enum(["available", "to-obtain", "idea", "none"]).default("none"),
  claimIds: z.array(z.string().max(80)).max(12).default([]),
  durationSeconds: z.number().int().min(0).max(3600).default(0),
  incoming: z.enum(["start", "cause", "obstacle", "contrast", "explanation", "example", "chronological", "list-item"]).default("explanation"),
  /** Footage matched to this beat. */
  footage: z.array(z.object({ clipId: id, in: time, out: time, segmentId: z.string().max(40).optional() }).strict()).max(40).default([]),
}).passthrough();
export type BriefBeat = z.infer<typeof briefBeatSchema>;

export const storyBriefSchema = z.object({
  source: z.enum(["outline", "inferred", "outline+inferred", "none"]),
  outlineRef: z.object({ sessionId: z.string().min(1).max(120), version: z.number().int().positive() }).strict().optional(),
  instruction: z.string().trim().max(2000).optional(),
  targetDuration: z.number().positive().max(6 * 3600).optional(),
  beats: z.array(briefBeatSchema).max(40).default([]),
  coverage: z.array(z.object({
    beatId: z.string().max(80),
    kind: z.enum(["no-footage", "visual-missing", "thin"]),
    note: text(300),
  }).strict()).max(80).default([]),
  /** Speech the structure stage cut outright (retakes, off-topic), for the review list. */
  dropped: z.array(z.object({
    clipId: id,
    in: time,
    out: time,
    text: z.string().trim().max(400),
    reason: z.string().trim().max(300),
    kind: z.enum(["retake", "false-start", "off-topic", "setup", "length"]),
    replacedBy: z.string().max(80).optional(),  // beat id holding the kept take
  }).strict()).max(1000).default([]),
}).strict();
export type StoryBrief = z.infer<typeof storyBriefSchema>;
export type StoryBriefInput = z.input<typeof storyBriefSchema>;

export const trackModeSchema = z.enum(["off", "suggest", "auto", "locked"]);
export type TrackMode = z.infer<typeof trackModeSchema>;
export const trackPolicySchema = z.object(
  Object.fromEntries(POLICY_KEYS.map(k => [k, trackModeSchema.default("auto")])) as Record<PolicyKey, z.ZodDefault<typeof trackModeSchema>>,
).strict();
export type TrackPolicy = z.infer<typeof trackPolicySchema>;

export const stageStampSchema = z.object({
  stage: z.string().min(1).max(60),
  revision: z.number().int().positive(),  // revision this stage produced
  at: z.string().datetime(),
  prompts: z.record(z.string(), z.object({ version: z.number().int(), hash: z.string() }).strict()).default({}),
  model: z.string().max(120).optional(),
  costUsd: z.number().nonnegative().optional(),
  range: z.object({ start: time, end: time }).strict().optional(), // revise requests scoped to a time range
  note: z.string().max(500).optional(),
}).strict();
export type StageStamp = z.infer<typeof stageStampSchema>;

/**
 * A misheard word put right once, for every caption built from that clip.
 * Keyed by the word's source time (seconds into the clip), not its id, so it
 * holds through a new transcript and through every recut.
 */
export const wordFixSchema = z.object({
  clipId: id,
  at: z.number().min(0),
  text: z.string().trim().min(1).max(60),
}).strict();
export type WordFix = z.infer<typeof wordFixSchema>;

/**
 * Sources recorded together (cameras, mics, a screen), on one clock. Each
 * member's file starts `start` seconds into the group's clock, so member
 * time = group time - start. `confidence`: how sure the sound match was
 * (peak over noise; 8 and up is sure); none when set by hand or by length.
 */
export const syncGroupSchema = z.object({
  id,
  via: z.enum(["sound", "length", "creator"]),
  members: z.array(z.object({
    clipId: id,
    start: z.number().finite().min(-86400).max(86400),
    confidence: z.number().min(0).max(999).optional(),
  }).strict()).min(2).max(16),
}).strict();
export type SyncGroup = z.infer<typeof syncGroupSchema>;

export const editDocSchema = z.object({
  version: z.literal(EDITDOC_VERSION),
  id,
  revision: z.number().int().nonnegative(),
  name: text(120),
  fps: fpsSchema,
  canvas: z.object({
    width: z.number().int().min(320).max(7680).refine(n => n % 2 === 0, "even width"),
    height: z.number().int().min(240).max(4320).refine(n => n % 2 === 0, "even height"),
  }).strict(),
  clips: z.array(clipRefSchema).max(2000),
  /** Clips recorded together; a clip is in one group at most. */
  groups: z.array(syncGroupSchema).max(100).default([]),
  tracks: tracksSchema,
  markers: z.array(markerSchema).max(500).default([]),
  mix: mixSchema,
  brief: storyBriefSchema,
  styleRef: z.object({ id: z.string().min(1).max(80), revision: z.number().int().nonnegative(), snapshot: editStyleSchema }).strict(),
  policy: trackPolicySchema,
  provenance: z.array(stageStampSchema).max(2000).default([]),
  /** Agent item ids the creator deleted or turned down; a replan never brings them back. */
  declined: z.array(z.string().min(1).max(200)).max(5000).default([]),
  /** Words of on-screen text the creator took off; a new cut drops text that says the same. */
  declinedText: z.array(z.string().min(1).max(160)).max(500).default([]),
  /** Caption word fixes, shared by every caption from their clip. */
  wordFixes: z.array(wordFixSchema).max(2000).default([]),
  editorExtras: z.unknown().optional(),   // desktop editor fields we do not model; kept as-is
}).strict();
export type EditDoc = z.infer<typeof editDocSchema>;
export type EditDocInput = z.input<typeof editDocSchema>;

/** The EditDoc as JSON Schema (what a file may hold), for agents rebuilding an edit in another editor. */
export function editDocJsonSchema(): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(editDocSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return schema;
}

type V2Key = { t: number; scale: number; x?: number; y?: number };
type Raw = Record<string, unknown>;

/** A v2 a-roll item's zoom keys as one zoom-track item, or nothing when it never zooms. */
function liftZoom(item: Raw, keys: V2Key[]): Raw | undefined {
  const start = item.start as number, end = item.end as number, len = end - start;
  const ks = [...keys].sort((a, b) => a.t - b.t).map(k => ({ ...k, t: Math.min(Math.max(k.t, 0), len), x: k.x ?? 0.5, y: k.y ?? 0.5 }));
  const scale = Math.max(...ks.map(k => k.scale));
  if (!(scale > 1)) return undefined;
  const top = ks.filter(k => k.scale === scale);
  const first = top[0]!, last = top.at(-1)!;
  const zoomedFromStart = ks[0]!.scale === scale;
  const zoomedToEnd = ks.at(-1)!.scale === scale;
  const panned = top.length > 1 && (first.x !== last.x || first.y !== last.y);
  return {
    id: `${item.id as string}-zoom`.slice(0, 120),
    start, end,
    owner: item.owner,
    ...(item.stage !== undefined ? { stage: item.stage } : {}),
    ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
    status: item.status ?? "applied",
    scale: Math.min(4, scale),
    x: first.x, y: first.y,
    target: "face",
    easeIn: zoomedFromStart ? 0 : first.t,
    easeOut: zoomedToEnd ? 0 : len - last.t,
    ...(panned ? { panTo: { x: last.x, y: last.y } } : {}),
  };
}

/**
 * Bring an older document up to EDITDOC_VERSION before parsing. v2 → v3: each
 * a-roll item's zoom keys become one item on the zoom track. v3 → v4: every
 * new field is optional, so only the number changes. Anything else passes
 * through for the schema to judge. v4 → v5 and v5 → v6: new fields are
 * optional (groups, angles, avOffset, graphics behindSubject).
 */
export function upgradeEditDoc(input: unknown): unknown {
  const doc = input as Raw | null;
  if (!doc || typeof doc !== "object") return input;
  if (doc.version === 2) return upgradeEditDoc(upgradeV2(doc));
  if (doc.version === 3 || doc.version === 4 || doc.version === 5) return { ...doc, version: EDITDOC_VERSION };
  return input;
}

function upgradeV2(doc: Raw): Raw {
  const tracks = { ...(doc.tracks as Raw | undefined) };
  const zoom: Raw[] = [];
  tracks["a-roll"] = ((tracks["a-roll"] as Raw[] | undefined) ?? []).map(item => {
    const { zoom: keys, ...rest } = item;
    const z = Array.isArray(keys) && keys.length ? liftZoom(item, keys as V2Key[]) : undefined;
    if (z) zoom.push(z);
    return rest;
  });
  tracks.zoom = zoom;
  // v2 zooms lived on the a-roll, so a locked a-roll locked them too.
  const policy = doc.policy as Raw | undefined;
  const aRoll = policy?.["a-roll"];
  const keepLock = policy && aRoll && aRoll !== "auto" && policy.zoom === undefined;
  return { ...doc, version: 3, tracks, ...(keepLock ? { policy: { ...policy, zoom: aRoll } } : {}) };
}
