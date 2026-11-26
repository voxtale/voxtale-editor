// Remotion root for agent graphics. The agent's composition (index.html with a
// paused GSAP timeline in window.__timelines.main, the same contract as
// HyperFrames) loads in an iframe; each Remotion frame seeks that timeline.
// So one composition renders under either engine.
import React, {useEffect, useRef, useState} from 'react';
import {Composition, continueRender, delayRender, registerRoot, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';

export const FPS = 30;

function Graphic() {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const [loading] = useState(() => delayRender('graphic: load composition'));
  const onLoad = async () => {
    const w = ref.current.contentWindow;
    await w.document.fonts.ready;
    for (let i = 0; i < 200 && !w.__timelines?.main; i++) await new Promise(r => setTimeout(r, 25));
    setReady(true);
    continueRender(loading);
  };
  useEffect(() => {
    if (!ready) return;
    const h = delayRender('graphic: seek');
    ref.current.contentWindow.__timelines?.main?.seek(frame / fps, false);
    requestAnimationFrame(() => requestAnimationFrame(() => continueRender(h)));
  }, [frame, fps, ready]);
  return <iframe ref={ref} src={staticFile('index.html')} onLoad={onLoad}
    style={{position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: 'transparent'}} />;
}

const Root = () => <Composition id="main" component={Graphic} fps={FPS} width={1920} height={1080} durationInFrames={FPS}
  defaultProps={{width: 1920, height: 1080, seconds: 1}}
  calculateMetadata={({props}) => ({width: props.width, height: props.height, durationInFrames: Math.max(1, Math.round(props.seconds * FPS))})} />;

registerRoot(Root);
