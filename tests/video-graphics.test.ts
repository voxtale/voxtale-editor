// Motion graphics (P5): contrast fixed by code, the per-minute cap, stable
// asset ids, and the write → gate → stills → check → repair → render loop
// with a fake writer, renderer and perceiver.
import {describe,expect,test} from 'bun:test';
import {STYLE_PRESETS} from '@voxtale/editdoc';
import {
  BODY_CONTRAST,HEADING_CONTRAST,checkFrames,contrast,graphicAssetId,graphicCap,graphicTokens,makeGraphic,readable,rerenderGraphic,
  type GraphicRenderer,type GraphicRequest,type RenderOutput,
} from '../src/video';

const GOOD=`import {z} from './kit';
import {AbsoluteFill} from 'remotion';
export const schema=z.object({value:z.number()});
export const defaultProps={value:3};
export default function G({value}:{value:number}){return <AbsoluteFill>{value}</AbsoluteFill>;}
`;
const BAD=`export const schema=1;\nexport default function G(){return <iframe/>;}\n`;
const fence=(s:string)=>'```tsx\n'+s+'```';

const request:GraphicRequest={purpose:'show the price',kind:'stat',title:'Cost',facts:[{label:'price',value:'$300'}],anchorWords:'it costs three hundred dollars',
  placement:'right',width:1920,height:1080,fps:30,durationInFrames:120};
const tokens=graphicTokens(STYLE_PRESETS['calm-explainer']);

function renderer(fail:(input:any,calls:number)=>Partial<RenderOutput>|null=()=>null) {
  const calls:any[]=[];
  const render:GraphicRenderer=async(_source,input)=>{
    calls.push(input);
    const bad=fail(input,calls.length);
    if(bad)return {ok:false,stage:'render',stills:new Map(),...bad};
    return {ok:true,stage:'done',props:input.props??{value:3},jsonSchema:{type:'object'},
      stills:new Map((input.stills??[]).map((f:number)=>[f,new Uint8Array([f])])),webm:input.stillsOnly?undefined:new Uint8Array([1,2,3])};
  };
  return {render,calls};
}
function writer(answers:string[]) {
  const seen:any[][]=[];
  return {seen,write:async(messages:any[])=>{seen.push([...messages]);return {text:answers[Math.min(seen.length-1,answers.length-1)]!,model:'m-writer',costUsd:0.01};}};
}

describe('tokens',()=>{
  test('every text colour reaches its contrast against the panel',()=>{
    for(const style of Object.values(STYLE_PRESETS)) {
      const t=graphicTokens(style);
      expect(contrast(t.colors.text,t.colors.background)).toBeGreaterThanOrEqual(BODY_CONTRAST);
      expect(contrast(t.colors.muted,t.colors.background)).toBeGreaterThanOrEqual(BODY_CONTRAST);
      expect(contrast(t.colors.primary,t.colors.background)).toBeGreaterThanOrEqual(HEADING_CONTRAST);
      expect(contrast(t.colors.accent,t.colors.background)).toBeGreaterThanOrEqual(HEADING_CONTRAST);
      expect(t.safe).toBeGreaterThanOrEqual(0.03);
    }
  });
  test('readable leaves good colours alone and pushes weak ones away from the background',()=>{
    expect(readable('#ffffff','#000000',4.5)).toBe('#FFFFFF');
    const fixed=readable('#777777','#666666',4.5);
    expect(contrast(fixed,'#666666')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#000000','#ffffff')).toBeCloseTo(21,5);
  });
});

describe('plan limits',()=>{
  test('cap per minute by density, at least one in a normal edit of 20 s, never more than 8',()=>{
    expect(graphicCap(120,'normal')).toBe(2);
    expect(graphicCap(120,'dense')).toBe(4);
    expect(graphicCap(120,'minimal')).toBe(1);
    expect(graphicCap(30,'minimal')).toBe(0);
    expect(graphicCap(25,'normal')).toBe(1);
    expect(graphicCap(15,'dense')).toBe(0);
    expect(graphicCap(3600,'dense')).toBe(8);
  });
  test('asset id follows the content, so the same graphic reuses its render',()=>{
    const a=graphicAssetId('e1',request);
    expect(a).toMatch(/^ga-[0-9a-f]{24}$/);
    expect(graphicAssetId('e1',{...request,purpose:'other words',anchorWords:'x'})).toBe(a);
    expect(graphicAssetId('e1',{...request,title:'Price'})).not.toBe(a);
    expect(graphicAssetId('e2',request)).not.toBe(a);
  });
  test('check frames sit after the entrance, in the middle and before the exit',()=>{
    expect(checkFrames(120)).toEqual([24,60,106]);
    expect(checkFrames(15)).toEqual([1,3,8]);
  });
});

describe('makeGraphic',()=>{
  test('clean first attempt: stills, check, then one final render',async()=>{
    const w=writer([fence(GOOD)]);
    const r=renderer();
    const vision=async()=>({json:{defects:[]},model:'v',costUsd:0.002});
    const g=await makeGraphic(request,tokens,{write:w.write,render:r.render,vision} as never);
    expect(g).toMatchObject({ok:true,attempts:1,model:'m-writer',props:{value:3}});
    expect(g.source).toBe(GOOD);
    expect(g.webm).toEqual(new Uint8Array([1,2,3]));
    expect(g.still).toEqual(new Uint8Array([60]));
    expect(g.costUsd).toBeCloseTo(0.012,6);
    expect(r.calls.map(c=>!!c.stillsOnly)).toEqual([true,false]);
    expect(r.calls[0].stills).toEqual([24,60,106]);
    expect(g.log.map(l=>l.step)).toEqual(['write','gate','stills','check','render']);
  });

  test('a gate reject gets one repair turn that names the problem',async()=>{
    const w=writer([BAD,fence(GOOD)]);
    const r=renderer();
    const g=await makeGraphic(request,tokens,{write:w.write,render:r.render});
    expect(g).toMatchObject({ok:true,attempts:2});
    const repair=w.seen[1]!.at(-1);
    expect(repair.role).toBe('user');
    expect(repair.content).toContain('static check');
    expect(repair.content).toContain('iframe');
    expect(r.calls).toHaveLength(2); // nothing rendered for the rejected module
  });

  test('a major defect is sent back; minor ones are not',async()=>{
    const w=writer([fence(GOOD)]);
    const r=renderer();
    let n=0;
    const vision=async()=>({json:{defects:n++===0?[{frame:60,kind:'clipped',detail:'title cut off',major:true}]:[{frame:24,kind:'tight',detail:'close to edge',major:false}]},model:'v'});
    const g=await makeGraphic(request,tokens,{write:w.write,render:r.render,vision} as never);
    expect(g).toMatchObject({ok:true,attempts:2});
    expect(w.seen[1]!.at(-1).content).toContain('title cut off');
  });

  test('still failing after the repair turn: not ok, with the problem in plain words',async()=>{
    const w=writer([BAD]);
    const r=renderer();
    const g=await makeGraphic(request,tokens,{write:w.write,render:r.render});
    expect(g.ok).toBe(false);
    expect(g.attempts).toBe(2);
    expect(g.problem).toContain('static check');
    expect(g.webm).toBeUndefined();
  });

  test('a render error goes back to the writer too',async()=>{
    const w=writer([fence(GOOD)]);
    const r=renderer((_input,calls)=>calls===1?{stage:'bundle',error:'Cannot find name foo'}:null);
    const g=await makeGraphic(request,tokens,{write:w.write,render:r.render});
    expect(g.ok).toBe(true);
    expect(w.seen[1]!.at(-1).content).toContain('Cannot find name foo');
  });
});

describe('rerenderGraphic',()=>{
  test('new values go through the same source with no model call',async()=>{
    const r=renderer();
    const out=await rerenderGraphic(GOOD,{value:9},request,tokens,r.render);
    expect(out.props).toEqual({value:9});
    expect(r.calls[0]).toMatchObject({props:{value:9},stills:[60]});
  });
  test('values the graphic rejects say so plainly',async()=>{
    const r=renderer(()=>({stage:'props',error:'Expected number, received string\n at value'}));
    await expect(rerenderGraphic(GOOD,{value:'x'},request,tokens,r.render)).rejects.toThrow(/do not fit this graphic: Expected number/);
  });
});
