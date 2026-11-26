// An edit in a style: the EditStyle it runs on (base preset, brand colours,
// measured pace and loudness), the lines its brief gets (rules.md, measured
// targets, brand, saved animations), its learned rules, and the brand files
// graphics need.
import {STYLE_PRESETS,type EditStyle} from '@voxtale/editdoc';
import {styleFor} from '../agent/session';
import {animations,learnedRules,mustStyle,rulesBody,type Style} from './folder';
import {brandKit,brandLines,graphicsBrand,type GraphicsBrand} from './brand';
import {withTargets} from './targets';
import {RULES_MAX} from '../rules';

/** What an edit keeps of its style (in .edit/project.json, with the job). */
export interface StyleUse {
  slug:string;
  dir:string;
  usage?:string;
  /** Brief lines: the style's own words and numbers. */
  lines:string[];
  /** Accepted rules from rules.md: the brief's standing rules. */
  rules:string[];
  graphics?:GraphicsBrand;
}

/** rules.md past this many characters is cut in the brief: the file stays whole. */
export const RULES_MD_MAX=6000;

export const isPreset=(id:string)=>id in STYLE_PRESETS;

/** The style folder as an edit uses it. `usage` picks a measured set; default the only one, or "default". */
export async function useStyle(root:string,name:string,usage?:string):Promise<{use:StyleUse;style:EditStyle}> {
  const s=await mustStyle(root,name);
  const sets=Object.keys(s.info.measured??{});
  const u=usage&&s.info.measured?.[usage]?usage:sets.length===1?sets[0]:s.info.measured?.default?'default':undefined;
  if(usage&&!s.info.measured?.[usage])throw new Error(`style ${s.slug} has no measured "${usage}"${sets.length?` (it has: ${sets.join(', ')})`:''}`);
  const m=u?s.info.measured![u]:undefined;
  const base=styleFor(s.info.base,brandKit(s.info.brand));
  const style:EditStyle={...(m?withTargets(base,m.targets):base),id:s.slug.slice(0,80),name:s.info.name.slice(0,80)};
  const g=graphicsBrand(s);
  return {style,use:{slug:s.slug,dir:s.dir,...(u?{usage:u}:{}),lines:await styleLines(s,u,g),rules:learnedRules(s.rules).slice(0,RULES_MAX).map(r=>r.text),...(g?{graphics:g}:{})}};
}

export async function styleLines(s:Style,usage:string|undefined,g:GraphicsBrand|undefined):Promise<string[]> {
  const body=rulesBody(s.rules);
  const m=usage?s.info.measured?.[usage]:undefined;
  const anims=await animations(s);
  return [
    `Edit style "${s.info.name}" (folder ${s.dir}). Follow its rules.md, below; pace numbers above come from it.${s.info.references?.length?` Contact sheets of its references: ${s.dir}/references/analysis/*/sheets/.`:''}`,
    body?`--- rules.md ---\n${body.length>RULES_MD_MAX?`${body.slice(0,RULES_MD_MAX)}\n[cut: read the whole file]`:body}\n--- end of rules.md ---`:'',
    m?`Measured on ${m.videos.length} reference(s) (${usage}), a range to land in, not a rule:\n${m.summary.map(l=>`- ${l}`).join('\n')}`:'',
    s.info.look?.captions?`Caption look for this style: ${s.info.look.captions}.`:'',
    ...brandLines(s.info.brand,g),
    anims.length?`Saved animations (reuse them: read the HTML, adapt the words, render_graphic): ${anims.map(a=>`${a.name} (${s.dir}/${a.file}${a.note?`: ${a.note}`:''})`).join('; ')}.`:'',
  ].filter(Boolean);
}
