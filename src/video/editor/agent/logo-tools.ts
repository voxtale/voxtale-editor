// place_logo: the brand logo over the cut (bd voxtale-editor-jo6.1). Text in logo-templates-skill-text.ts.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {z} from 'zod/v4';
import {ffprobePath} from '../../ffmpeg-path';
import {LOGO_CORNERS,logoClip,type LogoPlacement} from './logo';
import {defineTool,type ToolDef} from './port';
import {PLACE_LOGO_DESCRIPTION} from './logo-templates-skill-text';
import type {Workspace} from './tools';

type Change=(ws:Workspace,f:()=>void)=>Promise<void>;

/** The style's logo file on this machine: the brand file whose name its CSS url ends with. */
export function brandLogoPath(ws:Workspace):string|undefined {
  const g=ws.job.styleUse?.graphics;
  if(!g?.logo)return undefined;
  return g.files.find(f=>g.logo!.endsWith(`/${encodeURI(f.name).replace(/'/g,'%27')}`))?.path;
}

async function imageSize(path:string):Promise<{width:number;height:number}> {
  const p=Bun.spawn([ffprobePath(),'-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0',path],{stdout:'pipe',stderr:'pipe'});
  const [w,h]=(await new Response(p.stdout).text()).trim().split(',').map(Number);
  if(await p.exited||!w||!h)throw new Error(`cannot read the logo image ${basename(path)}`);
  return {width:w,height:h};
}

export function logoTools(ws:Workspace,change:Change):ToolDef<any>[] {
  const word=z.object({clip:z.string(),word:z.number().int()}).strict();
  return [defineTool({name:'place_logo',description:PLACE_LOGO_DESCRIPTION,
    input:{logos:z.array(z.object({id:z.string().min(1).max(40),corner:z.enum(LOGO_CORNERS).optional(),x:z.number().min(0).max(1).optional(),y:z.number().min(0).max(1).optional(),
      size:z.number().min(0.02).max(1),from:word.optional(),to:word.optional(),opacity:z.number().min(0.05).max(1).optional(),
      fade:z.object({in:z.number().min(0).max(2).optional(),out:z.number().min(0).max(2).optional()}).strict().optional()}).strict()).max(20)},
    run:async({logos})=>{
      const items=logos as LogoPlacement[];
      for(const l of items)for(const p of [l.from,l.to])if(p&&!ws.job.clips.find(c=>c.ref.id===p.clip)?.words.some(w=>w.id===p.word))throw new Error(`${l.id}: no word ${p.word} in ${p.clip}`);
      if(!items.length){await change(ws,()=>{ws.logo=undefined;});return {text:'no logo on the cut'};}
      // A logo clip the creator gave wins over the style's brand kit.
      const given=ws.job.clips.find(c=>c.ref.role==='logo'&&c.ref.kind==='image');
      let ref=given?.ref,path=given?ws.media?.[given.ref.hash]:undefined;
      if(!ref) {
        path=brandLogoPath(ws);
        if(!path)throw new Error('no logo: add one to the style (add_style_file role logo) or open the project with a logo file');
        const bytes=await readFile(path);
        ref=logoClip({hash:createHash('sha256').update(bytes).digest('hex'),name:basename(path),...await imageSize(path)});
      }
      await change(ws,()=>{ws.logo={ref:ref!,...(path?{path}:{}),items};});
      const placed=ws.doc?.logos??[];
      return {text:[`${placed.length} of ${items.length} logo placements on the cut (${ref.name})`,
        ...placed.map(l=>`${l.id}: ${l.start.toFixed(2)}-${l.end.toFixed(2)}s at ${l.x.toFixed(2)},${l.y.toFixed(2)} width ${l.w.toFixed(2)}${l.opacity<1?` opacity ${l.opacity}`:''}`),
        ...(placed.length<items.length?['the rest lost their words to the cut or have no length']:[])].join('\n')};
    }})];
}
