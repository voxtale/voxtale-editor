// Standing rules: what a creator wants in every edit ("always put the logo
// in the corner", "from now on no music under the intro"). The agent only
// proposes one, when the creator's words ask for it to last; the creator
// accepts it (maybe reworded), or refuses it. Accepted rules load into every
// later edit's brief. Pure: hosts keep the list (a JSON file, a table).

export type RuleStatus='proposed'|'accepted'|'refused';
export interface EditRule {
  id:string;
  /** The rule as the agent will read it in later edits. */
  text:string;
  /** The creator's own words it came from. */
  said:string;
  status:RuleStatus;
  proposedAt:number;
  decidedAt?:number;
  /** The edit it was proposed in. */
  editId?:string;
}

/** Words that ask for a change to last past this edit. */
export const RULE_WORDS=/\b(always|every time|each time|every video|from now on|going forward|in future|never again|by default|whenever)\b/i;
export const asksToLast=(text:string|undefined)=>!!text&&RULE_WORDS.test(text);

export const RULE_MAX_CHARS=300;
/** More than this many accepted rules and the brief would bury the edit. */
export const RULES_MAX=20;

const norm=(t:string)=>t.toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();

/** Add a proposal. The same rule already proposed or accepted is returned as is, not proposed twice. */
export function proposeRule(rules:EditRule[],p:{text:string;said:string;editId?:string},now=Date.now()):{rules:EditRule[];rule:EditRule;fresh:boolean} {
  const text=p.text.trim().slice(0,RULE_MAX_CHARS);
  if(text.length<5)throw new Error('a rule needs a few words');
  const same=rules.find(r=>r.status!=='refused'&&norm(r.text)===norm(text));
  if(same)return {rules,rule:same,fresh:false};
  const id=`rule-${(rules.length+1).toString(36)}-${now.toString(36)}`;
  const rule:EditRule={id,text,said:p.said.trim().slice(0,RULE_MAX_CHARS),status:'proposed',proposedAt:now,...(p.editId?{editId:p.editId}:{})};
  return {rules:[...rules,rule],rule,fresh:true};
}

/** The creator's answer: accept (with their wording, when they changed it) or refuse. */
export function decideRule(rules:EditRule[],id:string,decision:'accept'|'refuse',text?:string,now=Date.now()):EditRule[] {
  const r=rules.find(x=>x.id===id);
  if(!r)throw new Error(`no rule ${id}`);
  if(decision==='accept'&&rules.filter(x=>x.status==='accepted'&&x.id!==id).length>=RULES_MAX)throw new Error(`already ${RULES_MAX} rules: retire one first`);
  const t=text?.trim().slice(0,RULE_MAX_CHARS);
  return rules.map(x=>x.id!==id?x:{...x,status:decision==='accept'?'accepted':'refused',decidedAt:now,...(decision==='accept'&&t?{text:t}:{})});
}

/** Retire a rule the creator no longer wants: it stays on record as refused. */
export const retireRule=(rules:EditRule[],id:string,now=Date.now())=>decideRule(rules,id,'refuse',undefined,now);

export const acceptedRules=(rules:EditRule[])=>rules.filter(r=>r.status==='accepted').slice(0,RULES_MAX);
export const pendingRules=(rules:EditRule[])=>rules.filter(r=>r.status==='proposed');

/** Lines for an edit's brief: the accepted rules, in the order they were made. */
export function rulesBrief(rules:string[]):string[] {
  if(!rules.length)return [];
  return [`Creator's standing rules (they accepted these on earlier edits; follow them unless this edit's instruction says otherwise, and say in finish if one could not be kept):`,
    ...rules.map(r=>`- ${r}`)];
}

/** Rules as JSON, read leniently: a broken entry is dropped, not fatal. */
export function parseRules(raw:unknown):EditRule[] {
  if(!Array.isArray(raw))return [];
  return raw.filter((r):r is EditRule=>!!r&&typeof r==='object'&&typeof (r as EditRule).id==='string'&&typeof (r as EditRule).text==='string'
    &&['proposed','accepted','refused'].includes((r as EditRule).status));
}
