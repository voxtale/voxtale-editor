// Agent tools for multicam picks and A/V offset. Text lives in media-skill-text.ts.
import {z} from 'zod/v4';
import {groupOf,PIP_CORNERS} from '@voxtale/editdoc';
import {measureAvOffset} from '../../sound-sync';
import {clipOf} from './cut';
import type {AngleChoice} from './multicam';
import {SET_ANGLES_DESCRIPTION,SET_AV_OFFSET_DESCRIPTION} from './media-skill-text';
import {defineTool,type ToolDef} from './port';
import type {Workspace} from './tools';

type Change=(ws:Workspace,f:()=>void)=>Promise<void>;

export function mediaTools(ws:Workspace,change:Change):ToolDef<any>[] {
  const tools:ToolDef<any>[]=[];
  if(ws.syncGroups?.groups.length)tools.push(defineTool({name:'set_angles',description:SET_ANGLES_DESCRIPTION,
    input:{choices:z.array(z.object({clip:z.string().describe('the talk clip'),from:z.number().int(),to:z.number().int(),
        angle:z.string().optional().describe('camera clip id to show'),mic:z.string().optional().describe('clip id to hear'),
        layout:z.enum(['camera','split','pip']).optional(),companion:z.string().optional().describe('second camera for split/pip'),
        pipCorner:z.enum(PIP_CORNERS).optional(),why:z.string().max(200).optional()}).strict()).max(200).optional(),
      auto:z.object({mic:z.boolean().optional(),angle:z.boolean().optional()}).strict().optional(),
      clear:z.boolean().optional()},
    run:async({choices,auto,clear})=>{
      const groups=ws.syncGroups!.groups;
      if(clear){await change(ws,()=>{ws.angles=undefined;});return {text:'back to the talk camera and its own sound'};}
      for(const [k,c] of ((choices??[]) as AngleChoice[]).entries()) {
        const g=groupOf(groups,c.clip);
        if(!g)throw new Error(`choice ${k+1}: ${c.clip} is not in a sync group`);
        const j=clipOf(ws.job,c.clip);
        for(const w of [c.from,c.to])if(!j.words.some(x=>x.id===w))throw new Error(`choice ${k+1}: no word ${w} in ${c.clip}`);
        for(const id of [c.angle,c.mic,c.companion])if(id&&!g.members.some(m=>m.clipId===id))throw new Error(`choice ${k+1}: ${id} is not recorded with ${c.clip}. In its group: ${g.members.map(m=>m.clipId).join(', ')}`);
      }
      await change(ws,()=>{ws.angles={...(choices?.length?{choices:choices as AngleChoice[]}:{}),...(auto?{auto}:ws.angles?.auto?{auto:ws.angles.auto}:{})};});
      const a=ws.doc?.tracks['a-roll']??[];
      const lines=a.filter(i=>i.angle||i.mic||i.layout).map(i=>`${i.id}: ${i.angle??i.clipId}${i.layout&&i.layout!=='camera'?` ${i.layout} with ${i.companions?.[0]?.clipId}`:''}, sound ${i.mic??i.clipId}`);
      return {text:[`${lines.length} of ${a.length} pieces use another camera, mic or layout`,...lines.slice(0,40)].join('\n')};
    }}));
  tools.push(defineTool({name:'set_av_offset',description:SET_AV_OFFSET_DESCRIPTION,
    input:{clip:z.string(),offset:z.number().min(-2).max(2).optional(),measure:z.boolean().optional()},
    run:async({clip,offset,measure})=>{
      const c=clipOf(ws.job,clip);
      if(c.ref.kind!=='video'||!c.ref.hasAudio)throw new Error(`${clip} needs both picture and sound`);
      let v=offset,note='set by hand';
      if(measure) {
        const path=ws.media?.[c.ref.hash];
        if(!path)throw new Error(`${clip}: source file not known`);
        const fps=c.ref.fps?c.ref.fps.num/c.ref.fps.den:30;
        const r=await measureAvOffset(path,fps);
        if(!r)return {text:`${clip}: no sure match between mouth movement and sound; left as is (set offset by hand if you see it)`};
        v=r.offset;note=`measured, match ${r.confidence.toFixed(1)}`;
      }
      if(v===undefined)throw new Error('give offset or measure:true');
      const set=Math.abs(v)<0.001?undefined:v;
      await change(ws,()=>{
        const all={...ws.clipSettings},now={...all[clip]};
        if(set===undefined)delete now.avOffset;else now.avOffset=set;
        if(Object.keys(now).length)all[clip]=now;else delete all[clip];
        ws.clipSettings=Object.keys(all).length?all:undefined;
      });
      return {text:set===undefined?`${clip}: sound back in place (${note})`:`${clip}: sound moved ${set>0?'later':'earlier'} by ${Math.abs(set).toFixed(3)}s (${note})`};
    }}));
  return tools;
}
