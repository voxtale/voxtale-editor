// Entry the sandbox bundles. `./graphic` is the generated module. Props are
// parsed against the graphic's own schema before any frame renders, and the
// schema goes back to the host as JSON Schema so the editor can offer a form.
import React from 'react';
import {AbsoluteFill, Composition, registerRoot} from 'remotion';
import Graphic, {schema, defaultProps} from './graphic';
import {TokensProvider, defaultTokens, z, type Tokens} from './kit';

type Input = {props?: Record<string, unknown>; tokens: Tokens; width: number; height: number; fps: number; durationInFrames: number; checker?: boolean};
function Wrapped({props, tokens, checker}: Input) {
  const parsed = schema.parse(props ?? defaultProps);
  return <TokensProvider value={tokens}>
    {checker ? <AbsoluteFill style={{backgroundColor: '#eee', backgroundImage: 'repeating-conic-gradient(#bbb 0% 25%, transparent 0% 50%)', backgroundSize: '48px 48px'}} /> : null}
    <Graphic {...parsed} />
  </TokensProvider>;
}
function Root() {
  return <Composition id="Graphic" component={Wrapped as any} width={1920} height={1080} fps={30} durationInFrames={150}
    defaultProps={{props: defaultProps, tokens: defaultTokens, width: 1920, height: 1080, fps: 30, durationInFrames: 150} as any}
    calculateMetadata={({props}: {props: any}) => {
      const parsed = schema.parse(props.props ?? defaultProps);
      let jsonSchema: unknown = null;
      try { jsonSchema = (z as any).toJSONSchema(schema, {unrepresentable: "any"}); /* zod 4 in the sandbox */ } catch { jsonSchema = null; }
      return {width: props.width, height: props.height, fps: props.fps, durationInFrames: props.durationInFrames,
        props: {...props, props: parsed, resolved: {props: parsed, defaultProps, jsonSchema}}};
    }} />;
}
registerRoot(Root);
