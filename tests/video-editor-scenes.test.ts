import {describe,expect,test} from 'bun:test';
import {mkdtemp,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderGraphic} from '@voxtale/frames';
import {checkScene} from '../src/video/editor/agent/scene-check';
import {propsText} from '../src/video/editor/agent/scene-tools';
import {BUILTIN_NAMES,BUILTIN_SCENES} from '../src/video/editor/agent/sandbox/remotion/scenes/schemas';
import {designSize,fontFace} from '../src/video/editor/agent/sandbox/remotion/scenes/root';
import {localHtmlRenderer} from '../src/video/editor/agent/hyperframes';

const good=`import {AbsoluteFill, z} from './kit';
import type {SceneBase} from './types';
export const schema = z.object({n: z.number()});
export const defaultProps: z.infer<typeof schema> = {n: 3};
export default function Scene(p: z.infer<typeof schema> & SceneBase) {
  return <AbsoluteFill>{p.n * p.durationFrames}</AbsoluteFill>;
}`;

describe('native scenes',()=>{
  test('every built-in parses its own defaults and lists its props',()=>{
    for(const n of BUILTIN_NAMES) {
      const s=BUILTIN_SCENES[n];
      expect(s.schema.safeParse(s.defaults).success).toBe(true);
      expect(propsText(s.schema,s.defaults)).toContain('=');
    }
    expect(propsText(BUILTIN_SCENES.Title.schema,BUILTIN_SCENES.Title.defaults)).toContain('motion: string classic|pro = "classic"');
  });

  test('scene gate: imports, clock, shape and types',()=>{
    expect(checkScene(good)).toMatchObject({ok:true});
    expect(checkScene(good.replace("'./kit';","'./kit';\nimport x from 'three';")).errors.join()).toContain('"three" not allowed');
    expect(checkScene(good.replace('p.n *','Date.now() *')).ok).toBe(false);
    expect(checkScene(good.replace('p.n *','p.m *')).errors.join()).toContain("'m'");
    expect(checkScene(good.replace('{n: 3}',"{n: 'x'}")).ok).toBe(false);
    // A default export that ignores the props type still has to accept them.
    expect(checkScene(good.replace('(p: z.infer<typeof schema> & SceneBase)','(p: {q: string})').replace('p.n * p.durationFrames','p.q')).errors.join()).toContain('scene shape');
  },20_000);

  test('design size keeps the short side at 1080; font files map to faces',()=>{
    expect(designSize(3840,2160)).toEqual({width:1920,height:1080});
    expect(designSize(1080,1920)).toEqual({width:1080,height:1920});
    expect(fontFace('Inter-SemiBold.otf')).toEqual({family:'Inter',weight:600,style:'normal'});
    expect(fontFace('JetBrainsMono-Bold.ttf').family).toBe('JetBrains Mono');
  });

  test('a scene job writes scene.json and scene.tsx; HyperFrames refuses it',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'scene-job-'));
    let seen:string[]=[];
    const r=await renderGraphic(join(dir,'g'),{id:'g',html:'<html></html>',kitCss:'',width:1920,height:1080,seconds:2,stills:[1],backdrop:{clip:'x',t:0},
      scene:{name:'custom',props:{n:1},source:good}},'/nope',async({dir:d})=>{
        seen=[await readFile(join(d,'scene.json'),'utf8'),await readFile(join(d,'scene.tsx'),'utf8')];
        return {ok:false,report:'stub'};
      });
    expect(r.ok).toBe(false);
    expect(JSON.parse(seen[0]!)).toEqual({scene:'custom',props:{n:1}});
    expect(seen[1]).toBe(good);
    const inDir=join(dir,'hf-in');await mkdir(inDir,{recursive:true});await writeFile(join(inDir,'scene.json'),'{}');
    const hf=await localHtmlRenderer({home:join(dir,'hf-home')})({dir:inDir,width:1920,height:1080,seconds:2});
    expect(hf.report).toContain('need the Remotion renderer');
  });
});
