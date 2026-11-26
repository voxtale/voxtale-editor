// Standing rules kept in one JSON file per creator (the local editor's store).
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {parseRules,type EditRule} from './rules';

export interface RuleStore {load():Promise<EditRule[]>;save(rules:EditRule[]):Promise<void>}

export function fileRules(path:string):RuleStore {
  return {
    load:async()=>parseRules(await readFile(path,'utf8').then(JSON.parse).catch(()=>[])),
    save:async rules=>{
      await mkdir(dirname(path),{recursive:true});
      // Whole file or nothing: a crash mid-write must not lose the creator's rules.
      await writeFile(`${path}.tmp`,JSON.stringify(rules,null,1));
      await rename(`${path}.tmp`,path);
    },
  };
}
