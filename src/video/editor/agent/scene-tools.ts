// Native Remotion scenes for the agent: list the built-ins, write its own
// (gated and type-checked before use), render either to a graphic.
import {z} from 'zod/v4';
import {BUILTIN_NAMES,BUILTIN_SCENES,type BuiltinScene} from './sandbox/remotion/scenes/schemas';
import {checkScene} from './scene-check';
import {defineTool,type ToolDef,type ToolResult} from './port';

export type SceneJob={name:string;props:Record<string,unknown>;source?:string};
/** Renders a scene as graphic `id` starting at a source word; same result shape as make_graphic. */
export type SceneRender=(id:string,scene:SceneJob,seconds:number,anchor:{clip:string;word:number},stills:number[])=>Promise<ToolResult>;

const isBuiltin=(n:string):n is BuiltinScene=>(BUILTIN_NAMES as string[]).includes(n);

/** One line per prop: name type [range|options] = default. */
export function propsText(schema:z.ZodObject,defaults:Record<string,unknown>):string {
  const js=z.toJSONSchema(schema,{unrepresentable:'any'}) as {properties?:Record<string,{type?:string;minimum?:number;maximum?:number;enum?:unknown[];description?:string;options?:readonly string[]}>};
  return Object.entries(js.properties??{}).map(([k,p])=>{
    const range=p.enum?` ${p.enum.join('|')}`:p.minimum!==undefined?` ${p.minimum}-${p.maximum}`:p.options?` ${p.options.join('|')}`:'';
    return `  ${k}: ${p.type??'any'}${range} = ${JSON.stringify(defaults[k])}${p.description?` (${p.description})`:''}`;
  }).join('\n');
}

export function sceneTools(ws:{scenes?:Record<string,string>},render:SceneRender):ToolDef<any>[] {
  return [
    defineTool({name:'list_scenes',description:'Native Remotion scenes you can render with render_scene: the built-ins (props, ranges, defaults) and the scenes you wrote with write_scene. Layout is in a 1080-px-short-side frame; x/y are frame fractions.',
      input:{},
      run:async()=>{
        const own=Object.keys(ws.scenes??{});
        return {text:[...BUILTIN_NAMES.map(n=>{const s=BUILTIN_SCENES[n];return `${n}${'transition' in s?' (transition)':''}: ${s.about}\n${propsText(s.schema,s.defaults)}`;}),
          own.length?`Yours: ${own.join(', ')}`:'Yours: none yet (write_scene)'].join('\n\n')};
      }}),
    defineTool({name:'write_scene',description:`Write your own Remotion scene (TSX) for render_scene. Shape: \`export const schema = z.object({...})\`, \`export const defaultProps: z.infer<typeof schema> = {...}\`, \`export default function Scene(p: z.infer<typeof schema> & SceneBase)\` (SceneBase from './types' gives durationFrames). Imports only from react, remotion, zod/v4, ./kit (AbsoluteFill, interpolate, spring, random, useCurrentFrame, useVideoConfig, curves, clamp, moderate, MotionBlur, shadow, useInOut, fontFamily, textWidth, z…), ./pixel, ./paper, ./types. Everything from the frame number: no Date, timers, Math.random (use random(seed)), DOM, network, images or <style>. Checked by a static gate and a strict type check before it is kept; errors come back to fix. Same name again replaces it.`,
      input:{name:z.string().regex(/^[a-z][a-z0-9-]{1,39}$/).describe('scene name, e.g. "orbit-stat"'),source:z.string().min(80).max(40_000)},
      run:async({name,source})=>{
        if(isBuiltin(name))throw new Error(`${name} is a built-in scene name`);
        const r=checkScene(source);
        if(!r.ok)return {text:`REJECTED ${name}: fix and write again\n${r.errors.join('\n')}`,isError:true};
        (ws.scenes??={})[name]=source;
        return {text:`kept scene ${name}${r.note?` (${r.note})`:''}; render it with render_scene`};
      }}),
    defineTool({name:'render_scene',description:'Render a native Remotion scene (a built-in from list_scenes, or one you wrote) to a transparent full-frame graphic, then place it with place_graphic. Props you leave out take the defaults. Returns stills over the speaker. Same id again revises. Needs the Remotion renderer.',
      input:{id:z.string().regex(/^[a-z0-9-]{2,40}$/).describe('graphic id'),scene:z.string().describe('built-in name or your scene name'),
        props:z.record(z.string(),z.unknown()).default({}),seconds:z.number().min(0.5).max(15),
        anchor:z.object({clip:z.string(),word:z.number().int()}).describe('the word the graphic starts on (for the backdrop)'),
        stills:z.array(z.number().min(0)).min(1).max(4).optional().describe('seconds into the scene to check; default entrance, middle, end')},
      run:async({id,scene,props,seconds,anchor,stills})=>{
        const at=stills?.filter(t=>t<seconds)??[Math.min(0.7,seconds/3),seconds*0.55,Math.max(seconds-0.5,seconds*0.8)];
        if(isBuiltin(scene)) {
          const s=BUILTIN_SCENES[scene];
          const parsed=(s.schema as z.ZodObject).safeParse({...s.defaults,...props});
          if(!parsed.success)throw new Error(`props do not fit ${scene}: ${z.prettifyError(parsed.error).slice(0,600)}`);
          return render(id,{name:scene,props},seconds,anchor,at);
        }
        const source=ws.scenes?.[scene];
        if(source===undefined)throw new Error(`no scene "${scene}"; built-ins: ${BUILTIN_NAMES.join(', ')}; yours: ${Object.keys(ws.scenes??{}).join(', ')||'none'}`);
        return render(id,{name:'custom',props,source},seconds,anchor,at);
      }}),
  ];
}
