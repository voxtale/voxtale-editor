// Style folders: one per way of editing. The creator can read
// and edit every file by hand.
//   <root>/<slug>/style.json   look, brand, measured targets
//   <root>/<slug>/rules.md     their rules in plain words, learned rules, measured ranges
//   <root>/<slug>/animations.json + animations/   saved graphics to reuse
//   <root>/<slug>/brand/       logo, fonts
//   <root>/<slug>/references/  reference videos and their analysis
import {existsSync} from 'node:fs';
import {copyFile,mkdir,readdir,readFile,rename,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,extname,join,resolve} from 'node:path';
import type {Targets} from './targets';

export const stylesRoot=(root?:string)=>resolve(root??process.env.VOXTALE_STYLES??join(homedir(),'.voxtale-editor','styles'));

export interface BrandInfo {
  colors?:Partial<Record<'primary'|'accent'|'background'|'text',string>>;
  /** Font files in brand/. */
  fonts?:{heading?:string;body?:string};
  /** Logo file in brand/. */
  logo?:string;
  /** How the brand speaks, in the creator's words. */
  tone?:string;
}
export interface Measured {
  /** Five lines a person reads. */
  summary:string[];
  targets:Targets;
  /** Reference files measured. */
  videos:string[];
  at:string;
}
export interface Animation {name:string;file:string;note?:string}
export interface StyleInfo {
  name:string;
  description?:string;
  /** The built-in preset it starts from (calm-explainer, fast-paced, podcast, tutorial). */
  base?:string;
  look?:{captions?:string;accent?:string;format?:string};
  brand?:BrandInfo;
  /** Files in references/. */
  references?:string[];
  /** Measured targets per usage ("long", "short", "intro"...). */
  measured?:Record<string,Measured>;
}
export interface Style {slug:string;dir:string;info:StyleInfo;rules:string}

export const slugOf=(name:string)=>name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60);

const writeAtomic=async(path:string,text:string)=>{await writeFile(`${path}.tmp`,text);await rename(`${path}.tmp`,path);};

export const LEARNED='## Learned rules';
export const rulesTemplate=(name:string,description?:string)=>`# ${name}\n\n${description?`${description}\n\n`:''}Write how this style edits, in plain words. The agent reads this file before every edit in this style.\n\n${LEARNED}\n`;

export async function createStyle(root:string,p:{name:string;description?:string;base?:string}):Promise<Style> {
  const slug=slugOf(p.name);
  if(!slug)throw new Error('a style needs a name with letters or digits');
  const dir=join(root,slug);
  if(existsSync(join(dir,'style.json')))throw new Error(`style "${slug}" already exists`);
  for(const d of ['brand','references','animations'])await mkdir(join(dir,d),{recursive:true});
  const info:StyleInfo={name:p.name.trim(),...(p.description?{description:p.description.trim()}:{}),...(p.base?{base:p.base}:{})};
  await writeAtomic(join(dir,'style.json'),JSON.stringify(info,null,1));
  await writeAtomic(join(dir,'rules.md'),rulesTemplate(info.name,info.description));
  await writeFile(join(dir,'animations.json'),'[]');
  return {slug,dir,info,rules:await readFile(join(dir,'rules.md'),'utf8')};
}

/** The style named (slug or name). Undefined when there is none. */
export async function readStyle(root:string,name:string):Promise<Style|undefined> {
  const slug=slugOf(name),dir=join(root,slug);
  if(!slug||!existsSync(join(dir,'style.json')))return undefined;
  const info=JSON.parse(await readFile(join(dir,'style.json'),'utf8')) as StyleInfo;
  const rules=await readFile(join(dir,'rules.md'),'utf8').catch(()=>'');
  return {slug,dir,info:{...info,name:info.name||slug},rules};
}

export async function mustStyle(root:string,name:string):Promise<Style> {
  const s=await readStyle(root,name);
  if(!s)throw new Error(`no style "${name}" (styles lists them; create_style makes one)`);
  return s;
}

export async function listStyles(root:string):Promise<Style[]> {
  const names=await readdir(root).catch(()=>[] as string[]);
  const out:Style[]=[];
  for(const n of names.sort()){const s=await readStyle(root,n).catch(()=>undefined);if(s)out.push(s);}
  return out;
}

export async function saveInfo(s:Style,info:StyleInfo):Promise<Style> {
  await writeAtomic(join(s.dir,'style.json'),JSON.stringify(info,null,1));
  return {...s,info};
}
export async function saveRules(s:Style,rules:string):Promise<Style> {
  await writeAtomic(join(s.dir,'rules.md'),rules);
  return {...s,rules};
}

const FONT_EXT=['.otf','.ttf','.woff','.woff2'],IMAGE_EXT=['.png','.svg','.jpg','.jpeg','.webp'];
export type FileRole='logo'|'heading_font'|'body_font'|'brand'|'reference';

/** Copy a file into brand/ or references/; a logo or font also lands in style.json. Returns the style and the file name. */
export async function addFile(s:Style,path:string,role:FileRole):Promise<{style:Style;file:string}> {
  if(!existsSync(path))throw new Error(`no file ${path}`);
  const ext=extname(path).toLowerCase();
  if(role==='logo'&&!IMAGE_EXT.includes(ext))throw new Error(`a logo is ${IMAGE_EXT.join(', ')}`);
  if((role==='heading_font'||role==='body_font')&&!FONT_EXT.includes(ext))throw new Error(`a font is ${FONT_EXT.join(', ')}`);
  const sub=role==='reference'?'references':'brand',file=basename(path);
  await mkdir(join(s.dir,sub),{recursive:true});
  if(resolve(path)!==resolve(s.dir,sub,file))await copyFile(path,join(s.dir,sub,file));
  const info=structuredClone(s.info);
  if(role==='reference')info.references=[...new Set([...(info.references??[]),file])];
  else if(role==='logo')info.brand={...info.brand,logo:file};
  else if(role!=='brand')info.brand={...info.brand,fonts:{...info.brand?.fonts,[role==='heading_font'?'heading':'body']:file}};
  return {style:await saveInfo(s,info),file};
}

export async function animations(s:Style):Promise<Animation[]> {
  const raw=await readFile(join(s.dir,'animations.json'),'utf8').then(JSON.parse).catch(()=>[]);
  return Array.isArray(raw)?raw.filter((a):a is Animation=>!!a&&typeof a.name==='string'&&typeof a.file==='string'):[];
}

/** Keep a rendered graphic's HTML in animations/ to reuse in later edits of this style. */
export async function saveAnimation(s:Style,a:{name:string;html:string;note?:string}):Promise<Animation> {
  const file=`animations/${slugOf(a.name)||'graphic'}.html`;
  await mkdir(join(s.dir,'animations'),{recursive:true});
  await writeFile(join(s.dir,file),a.html);
  const all=(await animations(s)).filter(x=>x.name!==a.name);
  const entry:Animation={name:a.name,file,...(a.note?{note:a.note}:{})};
  await writeAtomic(join(s.dir,'animations.json'),JSON.stringify([...all,entry],null,1));
  return entry;
}

// ---- learned rules in rules.md

export interface LearnedRule {id:string;text:string;line:number}
const RULE_ID=/\s*<!--\s*rule:([\w-]+)\s*-->\s*$/;
const ADDED=/\s*_\(added [^)]*\)_\s*$/;

/** The bullets under "## Learned rules", until the next heading. A bullet the creator wrote by hand gets a line id. */
export function learnedRules(md:string):LearnedRule[] {
  const lines=md.split('\n'),start=lines.findIndex(l=>l.trim()===LEARNED);
  if(start<0)return [];
  const out:LearnedRule[]=[];
  for(let i=start+1;i<lines.length&&!/^#{1,2} /.test(lines[i]!);i++) {
    const m=/^\s*[-*] (.+)$/.exec(lines[i]!);
    if(!m)continue;
    const id=RULE_ID.exec(m[1]!)?.[1]??`line-${i+1}`;
    out.push({id,text:m[1]!.replace(RULE_ID,'').replace(ADDED,'').trim(),line:i});
  }
  return out;
}

export function addLearned(md:string,r:{id:string;text:string;said?:string},day=new Date().toISOString().slice(0,10)):string {
  const line=`- ${r.text.replace(/\s+/g,' ').trim()} _(added ${day}${r.said?`, from "${r.said.replace(/\s+/g,' ').replace(/[()"]/g,'').slice(0,80)}"`:''})_ <!-- rule:${r.id} -->`;
  const lines=md.replace(/\s+$/,'').split('\n');
  let start=lines.findIndex(l=>l.trim()===LEARNED);
  if(start<0){lines.push('',LEARNED);start=lines.length-1;}
  let end=start+1;
  while(end<lines.length&&!/^#{1,2} /.test(lines[end]!))end++;
  let at=end;
  while(at>start+1&&!lines[at-1]!.trim())at--;
  lines.splice(at,0,line);
  return lines.join('\n')+'\n';
}

export function dropLearned(md:string,id:string):string {
  const r=learnedRules(md).find(x=>x.id===id);
  if(!r)throw new Error(`no learned rule ${id} in rules.md`);
  const lines=md.split('\n');
  lines.splice(r.line,1);
  return lines.join('\n');
}

/** rules.md without its learned rules: those reach the brief as standing rules, once. */
export function rulesBody(md:string):string {
  const lines=md.split('\n'),start=lines.findIndex(l=>l.trim()===LEARNED);
  if(start<0)return md.trim();
  let end=start+1;
  while(end<lines.length&&!/^#{1,2} /.test(lines[end]!))end++;
  return [...lines.slice(0,start),...lines.slice(end)].join('\n').replace(/\n{3,}/g,'\n\n').trim();
}

/** Write (or replace) the "## Measured from references — <usage>" section, just before the learned rules. */
export function withMeasuredSection(md:string,usage:string,lines:string[]):string {
  const head=`## Measured from references — ${usage}`;
  const all=md.replace(/\s+$/,'').split('\n');
  const at=all.findIndex(l=>l.trim()===head);
  if(at>=0){let end=at+1;while(end<all.length&&!/^#{1,2} /.test(all[end]!))end++;all.splice(at,end-at);}
  const section=[head,'',...lines,''];
  let put=all.findIndex(l=>l.trim()===LEARNED);
  if(put<0){all.push('');put=all.length;}
  all.splice(put,0,...section);
  return all.join('\n').replace(/\n{3,}/g,'\n\n')+'\n';
}
