// The local editor's style tools: style folders (create, look at, add brand
// files, set colours), learning one from reference videos, choosing one for
// the open edit, and the rule loop: the agent proposes, the creator answers,
// decide_rule writes the answer into the style's rules.md.
import {STYLE_PRESETS} from '@voxtale/editdoc';
import {z} from '../agent/port';
import type {McpTool} from '../agent/mcp-protocol';
import type {Workspace} from '../agent/tools';
import {addFile,createStyle,learnedRules,listStyles,mustStyle,saveAnimation,saveInfo,type BrandInfo,type FileRole} from '../styles/folder';
import {fetchReference,learnStyle} from '../styles/learn';
import {decideStyleRule,loadProposals,proposeStyleRule,type StyleRule} from '../styles/style-rules';
import {useStyle} from '../styles/use';

export interface StyleToolsHost {
  /** Style folders' root (the old global rules moved in). */
  root():Promise<string>;
  /** The open edit, and how to keep its job after a change. */
  current():{ws:Workspace;keep():Promise<void>}|undefined;
}

const PRESETS=Object.keys(STYLE_PRESETS) as [string,...string[]];
const hex=z.string().regex(/^#[0-9a-fA-F]{6}$/);
const ruleLine=(r:StyleRule)=>`${r.id} [${r.status}] ${r.text}${r.said?` (from: "${r.said}")`:''}`;

export function styleTools(h:StyleToolsHost):McpTool[] {
  /** The open edit's style changed on disk: its brief lines and rules follow. */
  async function refresh(slug:string) {
    const c=h.current(),u=c?.ws.job.styleUse;
    if(!c||!u||u.slug!==slug)return;
    const r=await useStyle(await h.root(),slug,u.usage);
    c.ws.job.styleUse=r.use;c.ws.job.rules=r.use.rules;
    await c.keep();
  }
  const styleOfEdit=(given?:string)=>given??h.current()?.ws.job.styleUse?.slug;

  return [
    {name:'styles',description:'The creator\'s style folders (rules, measured pace, brand) and the built-in presets. An edit follows one: open with style, or use_style.',
      input:{},run:async()=>{
        const all=await listStyles(await h.root());
        const using=h.current()?.ws.job.styleUse?.slug;
        return {text:[all.length?all.map(s=>`- ${s.slug}${s.slug===using?' (this edit)':''}: ${s.info.name}${s.info.description?` — ${s.info.description}`:''}; ${learnedRules(s.rules).length} rule(s)${s.info.measured?`, measured: ${Object.keys(s.info.measured).join(', ')}`:''}${s.info.brand?', brand':''}`).join('\n'):'No style folders yet (create_style makes one).',
          `Presets: ${PRESETS.join(', ')}.`,`Folder: ${await h.root()}`].join('\n')};
      }},

    {name:'style',description:'One style folder in full: rules.md, measured targets, brand, files, and rules waiting for the creator\'s answer.',
      input:{name:z.string()},run:async({name})=>{
        const root=await h.root(),s=await mustStyle(root,name);
        const pending=(await loadProposals(root)).filter(r=>r.style===s.slug&&r.status==='proposed');
        return {text:[`${s.info.name} (${s.dir})${s.info.base?`, from preset ${s.info.base}`:''}`,'--- rules.md ---',s.rules.trim(),'---',
          s.info.measured?Object.entries(s.info.measured).map(([u,m])=>`Measured "${u}" (${m.videos.length} video(s)):\n${m.summary.map(l=>`- ${l}`).join('\n')}`).join('\n'):'Not measured: learn_style.',
          s.info.brand?`Brand: ${JSON.stringify(s.info.brand)}`:'No brand: add_style_file and set_brand.',
          pending.length?`Waiting for the creator:\n${pending.map(ruleLine).join('\n')}`:''].filter(Boolean).join('\n')};
      }},

    {name:'create_style',description:'Make a style folder: style.json, rules.md (the creator\'s words on how to edit), brand/, references/, animations/. Start it from a preset for the numbers nothing has measured yet.',
      input:{name:z.string().min(1).max(60),description:z.string().max(300).optional(),base:z.enum(PRESETS).optional().describe('preset for unmeasured pace and sound; default calm-explainer')},
      run:async({name,description,base})=>{
        const s=await createStyle(await h.root(),{name,...(description?{description}:{}),...(base?{base}:{})});
        return {text:`Created ${s.slug} in ${s.dir}. Next: write the creator's rules into rules.md (their words), learn_style on reference videos, add_style_file for logo and fonts.`};
      }},

    {name:'add_style_file',description:'Copy a file into a style: logo (png/svg/jpg/webp), heading_font or body_font (otf/ttf/woff/woff2) into brand/ — graphics then use them —, other brand files, or a reference video into references/.',
      input:{style:z.string(),path:z.string().describe('absolute path on this machine'),role:z.enum(['logo','heading_font','body_font','brand','reference'])},
      run:async({style,path,role})=>{
        const r=await addFile(await mustStyle(await h.root(),style),path,role as FileRole);
        await refresh(r.style.slug);
        return {text:`${role}: ${r.file} in ${r.style.slug}.`};
      }},

    {name:'set_brand',description:'Set a style\'s brand colours (#RRGGBB), its tone, and its caption look in words. Graphics take the accent as --accent; captions and cards take the colours. Only what you pass changes.',
      input:{style:z.string(),colors:z.object({primary:hex.optional(),accent:hex.optional(),background:hex.optional(),text:hex.optional()}).optional(),
        tone:z.string().max(200).optional(),captions:z.string().max(200).optional().describe('caption look, in words, for the brief')},
      run:async({style,colors,tone,captions})=>{
        const s=await mustStyle(await h.root(),style);
        const brand:BrandInfo={...s.info.brand,...(colors?{colors:{...s.info.brand?.colors,...colors}}:{}),...(tone?{tone}:{})};
        const saved=await saveInfo(s,{...s.info,brand,...(captions?{look:{...s.info.look,captions}}:{})});
        await refresh(saved.slug);
        return {text:`Brand of ${saved.slug}: ${JSON.stringify(saved.info.brand)}${h.current()?.ws.job.styleUse?.slug===saved.slug?' (new graphics in this edit use it; colours on captions take effect at the next open)':''}`};
      }},

    {name:'learn_style',description:'Measure reference videos on this machine (no model, no cost): cuts and shot lengths, punch-in zooms, jump cuts, flashes, slow transitions, still inserts, cuts on the beat, captions against the words, words per minute and pauses, loudness and music under the voice, picture look. Writes ranges into the style (style.json, rules.md) and REPORT.md, and contact sheets to look at. Word times come from <video>.words.json next to each video; without it, speech and caption timing are skipped. url: download one reference with yt-dlp first (only a link the creator gave). Takes a few minutes per 10 minutes of video. Look at the sheets, then write what they show into rules.md with the creator.',
      input:{style:z.string(),paths:z.array(z.string()).optional().describe('video files or folders of them (absolute)'),url:z.string().url().optional(),
        usage:z.string().max(40).optional().describe('what these references are for: long, short, intro... (default: default)'),
        only:z.string().max(200).optional().describe('only these parts, e.g. "0-30,1:00-"'),exclude:z.string().max(200).optional().describe('leave out these parts, e.g. "5:14-6:31"')},
      run:async({style,paths,url,usage,only,exclude},ctx)=>{
        const root=await h.root();
        let s=await mustStyle(root,style);
        const lines:string[]=[],log=(l:string)=>{lines.push(l);ctx.progress(lines.length,undefined,l);};
        const videos=[...(paths??[])];
        if(url){log(`downloading ${url}`);const f=await fetchReference(s,url);log(`saved ${f}`);videos.push(f);}
        if(!videos.length)return {text:'Give paths (video files or folders) or a url.',isError:true};
        const r=await learnStyle(root,s.slug,{videos,...(usage?{usage}:{}),...(only?{only}:{}),...(exclude?{exclude}:{}),log});
        s=r.style;
        await refresh(s.slug);
        return {text:[`Measured "${r.usage}" for ${s.slug}:`,...r.summary.map(l=>`- ${l}`),`Report: ${r.report}`,
          r.sheets.length?`Contact sheets (${r.sheets.length}; look at hook-*, cuts-* and text-* first):\n${r.sheets.slice(0,40).join('\n')}`:'',
          r.skipped.length?`Skipped:\n${r.skipped.join('\n')}`:'',
          'The ranges are in style.json and rules.md. Look at the sheets, tell the creator what you see, and write the rules they agree with into rules.md.'].filter(Boolean).join('\n')};
      }},

    {name:'use_style',description:'Make the open edit follow a style folder: its rules.md, measured pace and loudness, brand and learned rules load into the brief. Ask the creator which style when they have several.',
      input:{name:z.string(),usage:z.string().max(40).optional()},
      run:async({name,usage})=>{
        const c=h.current();
        if(!c)return {text:'No edit open: open (with style) or resume first.',isError:true};
        const r=await useStyle(await h.root(),name,usage);
        // The caption look the agent or creator already set stays.
        c.ws.job.style={...r.style,brand:{...r.style.brand,captionStyle:c.ws.job.style.brand.captionStyle}};
        c.ws.job.styleUse=r.use;c.ws.job.rules=r.use.rules;
        await c.keep();
        const p=r.style.pace;
        return {text:[`This edit follows ${r.use.slug}${r.use.usage?` (${r.use.usage})`:''}: about ${p.targetCutsPerMinute} cuts/min, pauses over ${p.maxPauseSeconds}s trimmed, shots at least ${p.minShotSeconds}s, zooms ${p.zoomFrequency}, ${r.style.audio.loudnessLufs} LUFS.`,
          ...r.use.lines,r.use.rules.length?`Standing rules:\n${r.use.rules.map(x=>`- ${x}`).join('\n')}`:''].filter(Boolean).join('\n')};
      }},

    {name:'save_animation',description:'Keep a graphic\'s HTML in a style (animations/) so later edits in that style reuse it. Only when the creator wants it kept.',
      input:{style:z.string().optional().describe('default: the open edit\'s style'),name:z.string().min(1).max(60),html:z.string().min(20).max(200_000),note:z.string().max(200).optional()},
      run:async({style,name,html,note})=>{
        const slug=styleOfEdit(style);
        if(!slug)return {text:'Which style? Ask the creator (styles lists them).',isError:true};
        const s=await mustStyle(await h.root(),slug);
        const a=await saveAnimation(s,{name,html,...(note?{note}:{})});
        await refresh(s.slug);
        return {text:`Saved ${a.name} as ${s.dir}/${a.file}.`};
      }},

    {name:'propose_rule',description:'When the creator asks for something to last ("always", "every time", "from now on", "in every video"), propose it as a rule of a style, once, after doing it in this edit. One or two plain sentences an editor can follow on any video. Then show it to the creator, word for word, and ask: keep it, change the wording, or drop it. Their answer goes to decide_rule. Not for one-off fixes.',
      input:{rule:z.string().min(5).max(300),said:z.string().max(300).describe('the creator\'s own words it comes from'),
        style:z.string().optional().describe('default: the open edit\'s style; with none, ask the creator which')},
      run:async({rule,said,style})=>{
        const slug=styleOfEdit(style);
        if(!slug)return {text:'This edit follows no style: ask the creator which style the rule belongs to (styles lists them; create_style makes one), then propose again with style.',isError:true};
        const r=await proposeStyleRule(await h.root(),slug,{text:rule,said,...(h.current()?{editId:h.current()!.ws.job.id}:{})});
        if(!r.fresh)return {text:`Not proposed: ${r.note}. ${ruleLine(r.rule)}`};
        return {text:`Proposed for ${r.rule.style}: "${r.rule.text}" (id ${r.rule.id}).\nShow the creator this rule in a short block, word for word, and ask: keep it, change the wording, or drop it. Then decide_rule with their answer. Never decide on your own.`};
      }},

    {name:'rules',description:'Standing rules, by style: accepted (in rules.md, in the brief of every edit in that style), proposed and waiting for the creator, refused.',
      input:{style:z.string().optional()},run:async({style})=>{
        const root=await h.root(),all=await loadProposals(root),styles=await listStyles(root);
        const out:string[]=[];
        for(const s of styles.filter(x=>!style||x.slug===(style as string).toLowerCase()||x.info.name===style)) {
          const learned=learnedRules(s.rules),mine=all.filter(r=>r.style===s.slug);
          if(!learned.length&&!mine.some(r=>r.status!=='accepted'))continue;
          out.push(`## ${s.slug}`,...learned.map(r=>`${r.id} [accepted] ${r.text}`),
            ...mine.filter(r=>r.status==='proposed').map(ruleLine),...mine.filter(r=>r.status==='refused').map(ruleLine));
        }
        return {text:out.length?out.join('\n'):'No standing rules yet.'};
      }},

    {name:'decide_rule',description:'Record the creator\'s answer to a proposed rule, only after they answered: accept (as proposed), edit (text: their wording), refuse (never proposed again). retire takes an accepted rule out of the style\'s rules.md (style: needed for a rule written by hand, id line-N).',
      input:{id:z.string(),decision:z.enum(['accept','edit','refuse','retire']),text:z.string().min(5).max(300).optional(),style:z.string().optional()},
      run:async({id,decision,text,style})=>{
        const root=await h.root();
        const d=decision==='accept'&&text?'edit':decision;
        const r=await decideStyleRule(root,id,d,{...(text?{text}:{}),...(style?{style}:{})});
        await refresh(r.style);
        const s=await mustStyle(root,r.style),waiting=(await loadProposals(root)).filter(x=>x.style===r.style&&x.status==='proposed').length;
        return {text:`${id} [${r.status==='refused'&&decision==='retire'?'retired':r.status}] ${r.text}\n${r.style}: ${learnedRules(s.rules).length} rule(s) in rules.md, in every edit in this style.${waiting?` ${waiting} still waiting.`:''}`};
      }},
  ];
}
