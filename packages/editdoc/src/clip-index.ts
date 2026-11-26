// Footage index (plan §2): what the desktop uploads for a clip and what the
// cloud returns after labelling it. Our segments own time; the model only
// describes segments by ID.
import { z } from "zod";
import { fpsSchema } from "./time";
import { CLIP_ROLES, loudnessSchema } from "./schema";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const segmentId = z.string().regex(/^S\d{3,5}$/);
const time = z.number().finite().nonnegative();
const frac = z.number().min(0).max(1);

export const ingestSegmentSchema = z.object({
  id: segmentId,
  start: time,
  end: time,
  stills: z.array(time).min(1).max(2),
}).strict();

/** Probe + segments for one clip, written by the desktop at ingest. */
export const clipIngestSchema = z.object({
  hash,
  name: z.string().trim().min(1).max(260),
  kind: z.enum(["video", "audio", "image"]),
  duration: z.number().finite().positive(),
  fps: fpsSchema.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  hasAudio: z.boolean(),
  vfr: z.boolean().default(false),
  timecodeStart: time.default(0),
  /** Creator's role pick; absent means "let the index guess". */
  role: z.enum(CLIP_ROLES).optional(),
  segments: z.array(ingestSegmentSchema).max(5000),
  loudness: loudnessSchema.optional(),
}).strict();
export type ClipIngest = z.infer<typeof clipIngestSchema>;

/** Storage key of a still: `stills/<segmentId>-<index>.jpg` under the clip. */
export function stillName(segmentId: string, index: number): string {
  return `stills/${segmentId}-${index}.jpg`;
}

export const SHOT_TYPES = ["talking-head", "screen", "wide", "medium", "close", "insert", "other"] as const;

export const indexSegmentSchema = z.object({
  id: segmentId,
  start: time,
  end: time,
  description: z.string().max(1000),
  subjects: z.array(z.string().max(120)).max(20),
  action: z.string().max(300),
  setting: z.string().max(300),
  shotType: z.enum(SHOT_TYPES),
  onScreenText: z.array(z.string().max(200)).max(10),
  quality: z.object({ blur: z.boolean(), exposure: z.enum(["ok", "dark", "blown"]), shaky: z.boolean() }).strict(),
  /** null when the model never labelled this segment. */
  usable: z.boolean().nullable(),
  mustShow: z.string().max(300).optional(),
  /** Words spoken in the segment, from the transcript (ours, not the model's). */
  words: z.string().max(4000).optional(),
  /** Largest face in the first still (centre and size, fractions of the frame), from a face detector. */
  face: z.object({ x: frac, y: frac, w: frac, h: frac }).strict().optional(),
}).strict();
export type IndexSegment = z.infer<typeof indexSegmentSchema>;

export const clipIndexSchema = z.object({
  clipHash: hash,
  promptVersion: z.string().min(1).max(80),
  model: z.string().max(120),
  summary: z.string().max(2000),
  roleGuess: z.enum(CLIP_ROLES),
  segments: z.array(indexSegmentSchema),
  transcriptRef: z.string().max(300).optional(),
  /** Segments the model left unlabelled after one retry. */
  missing: z.array(segmentId).default([]),
  costUsd: z.number().nonnegative().optional(),
}).strict();
export type ClipIndex = z.infer<typeof clipIndexSchema>;

/** Creator corrections that survive re-indexing. */
export const indexOverridesSchema = z.object({
  role: z.enum(CLIP_ROLES).optional(),
  segments: z.record(segmentId, z.object({ description: z.string().max(1000).optional(), usable: z.boolean().optional() }).strict()).default({}),
}).strict();
export type IndexOverrides = z.infer<typeof indexOverridesSchema>;

export function applyIndexOverrides(index: ClipIndex, o: IndexOverrides | undefined): ClipIndex {
  if (!o) return index;
  return {
    ...index,
    roleGuess: o.role ?? index.roleGuess,
    segments: index.segments.map(s => {
      const fix = o.segments[s.id];
      return fix ? { ...s, ...(fix.description !== undefined ? { description: fix.description } : {}), ...(fix.usable !== undefined ? { usable: fix.usable } : {}) } : s;
    }),
  };
}
