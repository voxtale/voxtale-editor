import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, rename, writeFile, unlink, open} from 'node:fs/promises';
import {dirname} from 'node:path';
export {digest} from './hash';
export async function fileHash(path:string) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}
export async function readJson(path:string):Promise<unknown> {return JSON.parse(await readFile(path,'utf8'));}
export async function maybeJson(path:string):Promise<any|undefined> {
  try {return await readJson(path);} catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
}
export async function writeJson(path:string,value:unknown) {
  await mkdir(dirname(path),{recursive:true});
  const temp=`${path}.${randomUUID()}.tmp`;
  try {await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(temp,path);}
  finally {await unlink(temp).catch(()=>{});}
}
export async function locked<T>(path:string,fn:()=>Promise<T>):Promise<T> {
  await mkdir(dirname(path),{recursive:true});
  const handle=await open(path,'wx').catch(()=>{throw new Error(`Stage is locked: ${path}. If its process has stopped, remove the stale lock before retrying.`);});
  await handle.writeFile(String(process.pid));
  try {return await fn();}finally {await handle.close();await unlink(path);}
}
