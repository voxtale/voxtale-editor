// Edit versions in <folder>/.edit/versions/: the files that make an edit
// (project.json, state.json, session.json, edit.json, agent-edit.json) frozen
// as vN/, never overwritten. The files in .edit/ are the working version.
// `newVersion` freezes the working one and goes on from an exact copy;
// `restoreVersion` freezes it too, then copies an old one back as the next
// version, so restoring loses nothing. `trashVersions` sends frozen versions
// the agent tried and dropped to the system Trash (recoverable), never the
// working one; `trashScratch` does the same for its preview stills.
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {copyFile,mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,extname,join,relative,resolve,sep} from 'node:path';
import {promisify} from 'node:util';

/** The files that are the edit; caches (transcripts, proxies, looks, renders) are shared by every version. */
export const VERSION_FILES=['project.json','state.json','session.json','edit.json','agent-edit.json'] as const;
/** Folders of the agent's scratch stills: watch_cut, sheet, previews. Nothing reads them back. */
export const SCRATCH_DIRS=['preview','views'] as const;

export interface VersionMeta {n:number;at:string;note?:string;
  /** Restored from this version. */
  from?:number}
export interface VersionIndex {
  /** The working version's number (the files in .edit/). */
  current:number;
  /** Frozen versions, oldest first. */
  frozen:VersionMeta[];
  /** The working version's note and origin. */
  working?:Omit<VersionMeta,'n'|'at'>;
  /** Frozen versions sent to the Trash. */
  trashed?:number[]}

const dirOf=(edit:string)=>join(edit,'versions');
const indexFile=(edit:string)=>join(dirOf(edit),'index.json');
const vDir=(edit:string,n:number)=>join(dirOf(edit),`v${n}`);

export async function readVersions(edit:string):Promise<VersionIndex> {
  return existsSync(indexFile(edit))?JSON.parse(await readFile(indexFile(edit),'utf8')):{current:1,frozen:[]};
}
const writeIndex=async(edit:string,i:VersionIndex)=>{await mkdir(dirOf(edit),{recursive:true});await writeFile(indexFile(edit),JSON.stringify(i,null,1));};

/** Copy the edit files from one folder to another; a file missing in `from` is missing in `to`. */
async function copyEdit(from:string,to:string,o:{exclusive?:boolean}={}):Promise<void> {
  await mkdir(to,{recursive:true});
  for(const f of VERSION_FILES) {
    const src=join(from,f),dst=join(to,f);
    if(existsSync(src))await copyFile(src,dst,o.exclusive?1:0);  // 1 = COPYFILE_EXCL: never overwrite a frozen version
    else await rm(dst,{force:true});
  }
}

/** Freeze the working files as v<current> and number the working copy current+1. */
async function freeze(edit:string,i:VersionIndex,now:Date):Promise<VersionIndex> {
  if(existsSync(vDir(edit,i.current)))throw new Error(`version ${i.current} is already frozen in ${vDir(edit,i.current)}; versions/index.json is out of step`);
  await copyEdit(edit,vDir(edit,i.current),{exclusive:true});
  return {...i,current:i.current+1,frozen:[...i.frozen,{n:i.current,at:now.toISOString(),...i.working}],working:undefined};
}

/**
 * Start the next version: the working edit is kept as it is (frozen), and
 * the working files go on unchanged as the new number, for this request's
 * changes. `note` says what the new version is for.
 */
export async function newVersion(edit:string,note?:string,now=new Date()):Promise<VersionIndex> {
  if(!existsSync(join(edit,'project.json')))throw new Error('no project here: open one first');
  const i=await freeze(edit,await readVersions(edit),now);
  const next={...i,...(note?{working:{note}}:{})};
  await writeIndex(edit,next);
  return next;
}

/** Make an old version the working one again, as the next number; the working edit is frozen first. */
export async function restoreVersion(edit:string,n:number,note?:string,now=new Date()):Promise<VersionIndex> {
  const before=await readVersions(edit);
  if(n===before.current)throw new Error(`v${n} is the working version already`);
  if(!before.frozen.some(v=>v.n===n))throw new Error(`no version ${n}${before.trashed?.includes(n)?' (it is in the Trash: put it back from there)':''}; versions: ${before.frozen.map(v=>`v${v.n}`).join(', ')||'none frozen yet'}`);
  if(!existsSync(vDir(edit,n)))throw new Error(`version ${n} is missing on disk (${vDir(edit,n)})`);
  const i=await freeze(edit,before,now);
  await copyEdit(vDir(edit,n),edit);
  const next={...i,working:{from:n,...(note?{note}:{})}};
  await writeIndex(edit,next);
  return next;
}

/** Move a file or folder to the system Trash: the Finder's (Put Back works), else ~/.Trash; on Windows the Recycle Bin. */
export async function moveToTrash(file:string):Promise<void> {
  const run=promisify(execFile);
  if(process.platform==='win32') {
    const dirs=(await readdir(file).then(()=>true,()=>false))?'DeleteDirectory':'DeleteFile';
    const q=`'${file.replace(/'/g,"''")}'`;
    await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      `try { Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${dirs}(${q}, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException') } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`])
      .catch((e:{stderr?:string})=>{throw new Error(`Windows could not move ${basename(file)} to the Recycle Bin: ${e.stderr?.trim()||'unknown reason'}`);});
    return;
  }
  try {await run('osascript',['-e',`tell application "Finder" to delete (POSIX file ${JSON.stringify(file)})`]);}
  catch {
    const ext=extname(file);
    await mkdir(join(homedir(),'.Trash'),{recursive:true});
    await rename(file,join(homedir(),'.Trash',`${basename(file,ext)} ${Date.now()}${ext}`));
  }
}
export type Trash=(file:string)=>Promise<void>;

/** Send frozen versions to the Trash. The working version always stays, so an edit never loses its last version. */
export async function trashVersions(edit:string,ns:number[],trash:Trash=moveToTrash):Promise<{trashed:number[];index:VersionIndex}> {
  const i=await readVersions(edit);
  for(const n of ns) {
    if(n===i.current)throw new Error(`v${n} is the working version: restore another one first`);
    if(!i.frozen.some(v=>v.n===n))throw new Error(`no frozen version ${n}`);
  }
  const want=[...new Set(ns)];
  for(const n of want)await trash(vDir(edit,n));
  const next={...i,frozen:i.frozen.filter(v=>!want.includes(v.n)),trashed:[...(i.trashed??[]),...want]};
  await writeIndex(edit,next);
  return {trashed:want,index:next};
}

/** Send the agent's scratch stills to the Trash: whole scratch folders, or files inside them; anything else is refused. */
export async function trashScratch(edit:string,paths:string[]|'all',trash:Trash=moveToTrash):Promise<string[]> {
  const root=resolve(edit);
  const list=paths==='all'?SCRATCH_DIRS.map(d=>join(root,d)).filter(existsSync):paths.map(p=>resolve(root,p));
  for(const p of list) {
    const rel=relative(root,p).split(sep);
    if(rel[0]==='..'||!(SCRATCH_DIRS as readonly string[]).includes(rel[0]!))throw new Error(`refused: only scratch stills in .edit/${SCRATCH_DIRS.join('/ or .edit/')}/: ${p}`);
    if(!existsSync(p))throw new Error(`not found: ${p}`);
  }
  for(const p of list)await trash(p);
  return list.map(p=>relative(root,p));
}

/** The versions, one per line, newest last. */
export function versionsText(i:VersionIndex):string {
  const line=(v:VersionMeta)=>`v${v.n}  ${v.at.slice(0,16).replace('T',' ')}${v.from?`  restored from v${v.from}`:''}${v.note?`  ${v.note}`:''}`;
  return [...i.frozen.map(line),`v${i.current}  working${i.working?.from?`  restored from v${i.working.from}`:''}${i.working?.note?`  ${i.working.note}`:''}`,
    ...(i.trashed?.length?[`in the Trash: ${i.trashed.map(n=>`v${n}`).join(', ')}`]:[])].join('\n');
}
