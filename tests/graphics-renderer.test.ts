import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {dockerGraphicsRenderer,graphicsEngine,localGraphicsRenderer} from '../src/video/editor/agent/remotion';

const SANDBOX=join(import.meta.dir,'../src/video/editor/agent/sandbox/remotion');

describe('graphics engine choice',()=>{
  test('Remotion unless HyperFrames is picked',()=>{
    expect(graphicsEngine(undefined)).toBe('remotion');
    expect(graphicsEngine('')).toBe('remotion');
    expect(graphicsEngine('remotion')).toBe('remotion');
    expect(graphicsEngine(' HyperFrames ')).toBe('hyperframes');
    expect(graphicsEngine('hf')).toBe('hyperframes');
    expect(graphicsEngine('nonsense')).toBe('remotion');
  });
  test('both engines give a renderer',()=>{
    for(const e of ['remotion','hyperframes'] as const) {
      expect(typeof dockerGraphicsRenderer(e)).toBe('function');
      expect(typeof localGraphicsRenderer({home:'/tmp/none'},e)).toBe('function');
    }
  });
});

describe('Remotion sandbox wiring',()=>{
  test('entry seeks the HyperFrames timeline each frame',()=>{
    const entry=readFileSync(join(SANDBOX,'entry.jsx'),'utf8');
    expect(entry).toContain('__timelines?.main?.seek(frame / fps');
    expect(entry).toContain("staticFile('index.html')");
  });
  test('render writes transparent VP9 and pins one Remotion version',()=>{
    const r=readFileSync(join(SANDBOX,'render.mjs'),'utf8');
    expect(r).toContain("pixelFormat: 'yuva420p'");
    expect(r).toContain("codec: 'vp9'");
    const deps=JSON.parse(readFileSync(join(SANDBOX,'package.json'),'utf8')).dependencies as Record<string,string>;
    const v=new Set(Object.entries(deps).filter(([k])=>k==='remotion'||k.startsWith('@remotion/')).map(([,x])=>x));
    expect(v.size).toBe(1);
  });
});

import {CURVES,MOTION_KIT_JS,snap,withMotionKit} from '../src/video/editor/agent/motion';
import {templateHtml,templateSchema} from '../src/video/editor/agent/templates';
import {AGENT_SKILL_PROMPT_ID} from '../src/video/editor/agent/skill';
import {promptTextVersion} from '../src/services/prompts';

describe('motion kit',()=>{
  const load=()=>{const w:any={};new Function('window','document','getComputedStyle',MOTION_KIT_JS)(w,{},()=>({}));return w.kit;};
  test('window.kit has every curve, ends pinned',()=>{
    const kit=load();
    for(const k of Object.keys(CURVES)){expect(kit.curves[k](0)).toBe(0);expect(kit.curves[k](1)).toBe(1);}
    expect(kit.curves.flowIn(1/29)).toBeGreaterThan(0.3); // a smear on the first frame
  });
  test('snap overshoots ~14% once, then settles',()=>{
    const kit=load();
    const v=Array.from({length:36},(_,f)=>snap(f,30,0,1));
    expect(Math.max(...v)).toBeGreaterThan(1.1);expect(Math.max(...v)).toBeLessThan(1.18);
    expect(kit.snapEase(1.2)(1)).toBe(1);
  });
  test('kit goes in right after GSAP, once',()=>{
    const html='<head><script src="./gsap.min.js"></script></head>';
    const once=withMotionKit(html);
    expect(once.indexOf('window.kit=')).toBeGreaterThan(once.indexOf('gsap.min.js'));
    expect(withMotionKit(once)).toBe(once);
    expect(withMotionKit('<head></head>')).toBe('<head></head>');
  });
});

describe('templates use the kit',()=>{
  const at=(_w:number|undefined,fb:number)=>fb;
  test('no default GSAP eases; title card renders',()=>{
    for(const t of [{kind:'stat',value:40,of:100,label:'x'},{kind:'title',kicker:'Part 2',text:'Why the loop matters'}]) {
      const html=templateHtml(templateSchema.parse(t),{width:1920,height:1080,seconds:6,at});
      expect(html).not.toMatch(/ease:'(power|back)/);
      expect(html).toContain('kit.');
    }
  });
});

describe('skill v27',()=>{
  test('builds on v26',()=>{
    expect(promptTextVersion(AGENT_SKILL_PROMPT_ID,27).length).toBeGreaterThan(promptTextVersion(AGENT_SKILL_PROMPT_ID,26).length);
  });
});
