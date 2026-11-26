// The shape every scene module has: a built-in, or the agent's own (custom.tsx).
import type {FC} from 'react';
import type {z} from 'zod/v4';

/** Props every scene receives on top of its own. */
export type SceneBase = {durationFrames: number};

/**
 * An agent-written scene file exports exactly this:
 *   export const schema = z.object({...});           // its props, every field with a default-able value
 *   export const defaultProps: z.infer<typeof schema> = {...};
 *   export default function Scene(p: z.infer<typeof schema> & SceneBase) {...}
 */
export type SceneModule<S extends z.ZodObject = z.ZodObject> = {
  schema: S;
  defaultProps: z.infer<S>;
  default: FC<z.infer<S> & SceneBase>;
};
