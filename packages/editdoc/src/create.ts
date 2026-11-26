// A blank document: empty tracks, default mix and policy, a style snapshot.
import { EDITDOC_VERSION, type ClipRef, type EditDoc, type StoryBrief, type TrackPolicy } from "./schema";
import { FPS_30, type Fps } from "./time";
import { STYLE_PRESETS, type EditStyle } from "./style";
import { defaultPolicy } from "./policy";
import { parseEditDoc } from "./validate";

export interface NewEditDoc {
  id: string;
  name: string;
  clips: ClipRef[];
  fps?: Fps;
  canvas?: { width: number; height: number };
  style?: EditStyle;
  policy?: Partial<TrackPolicy>;
  brief?: StoryBrief;
}

export function newEditDoc(o: NewEditDoc): EditDoc {
  const style = o.style ?? STYLE_PRESETS["calm-explainer"];
  return parseEditDoc({
    version: EDITDOC_VERSION, id: o.id, revision: 0, name: o.name,
    fps: o.fps ?? FPS_30, canvas: o.canvas ?? { width: 1920, height: 1080 },
    clips: o.clips, tracks: {}, markers: [], mix: { loudnessLufs: style.audio.loudnessLufs },
    brief: o.brief ?? { source: "none" },
    styleRef: { id: style.id, revision: style.revision, snapshot: style },
    policy: { ...defaultPolicy(), ...o.policy }, provenance: [],
  }).doc;
}
