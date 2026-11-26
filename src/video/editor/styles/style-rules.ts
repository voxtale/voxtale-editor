// Standing rules belong to a style. The agent proposes one ("always put the
// logo top right"); the creator sees it and accepts it, rewords it, or
// refuses it. Accepted rules are written into that style's rules.md under
// "## Learned rules", where the creator can also edit them by hand; the
// proposals (and refusals, so they are not proposed again) stay in
// <root>/proposals.json.
import {existsSync} from 'node:fs';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {decideRule,parseRules,proposeRule,RULE_MAX_CHARS,RULES_MAX,type EditRule} from '../rules';
import {addLearned,createStyle,dropLearned,learnedRules,mustStyle,readStyle,saveRules,slugOf} from './folder';

export interface StyleRule extends EditRule {style:string}
export type RuleDecision='accept'|'edit'|'refuse'|'retire';

/** Style the old global rules (~/.voxtale-editor/rules.json) move into. */
export const DEFAULT_STYLE='my-style';

const file=(root:string)=>join(root,'proposals.json');
const norm=(t:string)=>t.toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();

export async function loadProposals(root:string):Promise<StyleRule[]> {
  const raw=await readFile(file(root),'utf8').then(JSON.parse).catch(()=>[]);
  return parseRules(raw).filter((r):r is StyleRule=>typeof (r as StyleRule).style==='string');
}
async function saveProposals(root:string,rules:StyleRule[]):Promise<void> {
  await writeFile(`${file(root)}.tmp`,JSON.stringify(rules,null,1));
  await rename(`${file(root)}.tmp`,file(root));
}

/** Propose a rule for a style. Already in its rules.md, or proposed, or refused before: not proposed again. */
export async function proposeStyleRule(root:string,style:string,p:{text:string;said:string;editId?:string},now=Date.now()):Promise<{rule:StyleRule;fresh:boolean;note?:string}> {
  const s=await mustStyle(root,style);
  const text=p.text.trim().slice(0,RULE_MAX_CHARS);
  const learned=learnedRules(s.rules).find(r=>norm(r.text)===norm(text));
  if(learned)return {rule:{id:learned.id,text:learned.text,said:'',status:'accepted',proposedAt:0,style:s.slug},fresh:false,note:'already in rules.md'};
  const all=await loadProposals(root);
  const mine=all.filter(r=>r.style===s.slug);
  const refused=mine.find(r=>r.status==='refused'&&norm(r.text)===norm(text));
  if(refused)return {rule:refused,fresh:false,note:'the creator refused this rule before'};
  const r=proposeRule(mine,p,now);
  if(!r.fresh)return {rule:r.rule as StyleRule,fresh:false,note:'already proposed'};
  const rule:StyleRule={...r.rule,id:`${s.slug.slice(0,20)}-${r.rule.id}`,style:s.slug};
  await saveProposals(root,[...all,rule]);
  return {rule,fresh:true};
}

/**
 * The creator's answer. accept: the proposal as written; edit: their wording (`text`); refuse: never proposed again;
 * retire: take an accepted rule out of rules.md (`style` needed for a rule they wrote by hand, id line-N).
 */
export async function decideStyleRule(root:string,id:string,decision:RuleDecision,o:{text?:string;style?:string}={},now=Date.now()):Promise<{style:string;text:string;status:EditRule['status']}> {
  const all=await loadProposals(root);
  const p=all.find(r=>r.id===id);
  if(decision==='retire') {
    const slug=p?.style??(o.style?slugOf(o.style):undefined);
    if(!slug)throw new Error(`no rule ${id}: pass the style it is in`);
    const s=await mustStyle(root,slug);
    const r=learnedRules(s.rules).find(x=>x.id===id);
    if(!r)throw new Error(`no rule ${id} in ${slug}/rules.md`);
    await saveRules(s,dropLearned(s.rules,id));
    if(p)await saveProposals(root,all.map(x=>x.id===id?{...x,status:'refused',decidedAt:now}:x));
    return {style:slug,text:r.text,status:'refused'};
  }
  if(!p)throw new Error(`no proposed rule ${id} (rules lists them)`);
  if(p.status!=='proposed')throw new Error(`rule ${id} is already ${p.status}`);
  if(decision==='edit'&&!o.text?.trim())throw new Error('edit needs the creator\'s wording in text');
  const s=await mustStyle(root,p.style);
  if(decision!=='refuse'&&learnedRules(s.rules).length>=RULES_MAX)throw new Error(`${s.slug} already has ${RULES_MAX} rules: retire one first`);
  const next=decideRule(all,id,decision==='refuse'?'refuse':'accept',decision==='edit'?o.text:undefined,now) as StyleRule[];
  const r=next.find(x=>x.id===id)!;
  if(r.status==='accepted')await saveRules(s,addLearned(s.rules,{id:r.id,text:r.text,said:r.said}));
  await saveProposals(root,next);
  return {style:s.slug,text:r.text,status:r.status};
}

/** The learned rules of a style, for the brief. */
export async function styleRules(root:string,style:string):Promise<string[]> {
  const s=await readStyle(root,style);
  return s?learnedRules(s.rules).slice(0,RULES_MAX).map(r=>r.text):[];
}

/**
 * Once: the global rules file (before styles) moves into the style DEFAULT_STYLE. Accepted rules go to its rules.md,
 * proposed and refused ones to the proposals. The old file stays where it was, untouched.
 */
export async function migrateGlobalRules(root:string,oldFile:string,now=Date.now()):Promise<number> {
  const mark=join(root,'.rules-migrated');
  if(existsSync(mark)||!existsSync(oldFile))return 0;
  const old=parseRules(await readFile(oldFile,'utf8').then(JSON.parse).catch(()=>[]));
  if(old.length) {
    const s=await readStyle(root,DEFAULT_STYLE)??await createStyle(root,{name:DEFAULT_STYLE,description:'Rules accepted before styles existed.'});
    let md=s.rules;
    for(const r of old.filter(x=>x.status==='accepted'))if(!learnedRules(md).some(x=>norm(x.text)===norm(r.text)))md=addLearned(md,r,new Date(r.decidedAt??now).toISOString().slice(0,10));
    await saveRules(s,md);
    const all=await loadProposals(root);
    const have=new Set(all.map(r=>r.id));
    await saveProposals(root,[...all,...old.filter(r=>!have.has(r.id)).map(r=>({...r,style:s.slug}))]);
  }
  await mkdir(root,{recursive:true});
  await writeFile(mark,new Date(now).toISOString());
  return old.length;
}
