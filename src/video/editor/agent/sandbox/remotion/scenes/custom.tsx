// Placeholder for the agent's scene. render.mjs overwrites this file in the
// work copy with the agent's source (checked by write_scene first).
import {AbsoluteFill, z} from './kit';
import type {SceneBase} from './types';

export const schema = z.object({});
export const defaultProps: z.infer<typeof schema> = {};
export default function Scene(_: z.infer<typeof schema> & SceneBase) {
  return <AbsoluteFill />;
}
