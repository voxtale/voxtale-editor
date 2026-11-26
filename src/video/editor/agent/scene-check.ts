// Gate for agent-written Remotion scenes, run before any render: the static
// gate (allow-listed imports, no network, clock, DOM or eval), then a strict
// TypeScript check against the scene kit and the SceneModule shape, as
// REDACTED checks its agent-written animations before use.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';
import {gate} from '../../graphics/gate';

export const SCENES_DIR=join(import.meta.dir,'sandbox','remotion','scenes');
/** What a scene file may import. */
export const SCENE_IMPORTS:ReadonlySet<string>=new Set(['react','remotion','zod/v4','./kit','./pixel','./paper','./types']);
const MAX_ERRORS=12;

export interface SceneCheck {ok:boolean;errors:string[];/** Set when the type check could not run (no react/remotion types here). */note?:string}

const OPTIONS:ts.CompilerOptions={strict:true,noEmit:true,skipLibCheck:true,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,
  module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,lib:['lib.es2023.d.ts','lib.dom.d.ts'],types:[],
  noUncheckedIndexedAccess:false,allowImportingTsExtensions:false};

/** Type-check `source` as scenes/custom.tsx, plus a probe that it is a SceneModule. */
export function typecheckScene(source:string,dir=SCENES_DIR):SceneCheck {
  const resolved=(m:string)=>ts.resolveModuleName(m,join(dir,'kit.tsx'),OPTIONS,ts.sys).resolvedModule;
  if(!resolved('react')||!resolved('remotion'))return {ok:true,errors:[],note:'type check skipped: react/remotion types not installed here'};
  const custom=join(dir,'custom.tsx'),probe=join(dir,'__probe.ts');
  const files:Record<string,string>={[custom]:source,
    [probe]:`import * as m from './custom';\nimport type {SceneModule} from './types';\nexport const probe: SceneModule<typeof m.schema> = m;\n`};
  const host=ts.createCompilerHost(OPTIONS,true);
  const read=host.readFile.bind(host),exists=host.fileExists.bind(host),get=host.getSourceFile.bind(host);
  host.readFile=f=>files[f]??read(f);
  host.fileExists=f=>f in files||exists(f);
  host.getSourceFile=(f,lang,...rest)=>f in files?ts.createSourceFile(f,files[f]!,lang,true):get(f,lang,...rest);
  const program=ts.createProgram([custom,probe],OPTIONS,host);
  const diags=[...program.getSyntacticDiagnostics(),...program.getSemanticDiagnostics()].filter(d=>d.file&&(d.file.fileName===custom||d.file.fileName===probe));
  const errors=diags.slice(0,MAX_ERRORS).map(d=>{
    const msg=ts.flattenDiagnosticMessageText(d.messageText,' ').slice(0,300);
    if(d.file!.fileName===probe)return `scene shape: ${msg} (export schema, defaultProps: z.infer<typeof schema>, default component taking its props & {durationFrames})`;
    return `line ${d.file!.getLineAndCharacterOfPosition(d.start??0).line+1}: ${msg}`;
  });
  if(diags.length>MAX_ERRORS)errors.push(`…${diags.length-MAX_ERRORS} more`);
  return {ok:errors.length===0,errors};
}

/** Static gate, then type check (only once the gate passes). */
export function checkScene(source:string,dir=SCENES_DIR):SceneCheck {
  const g=gate(source,{imports:SCENE_IMPORTS});
  if(!g.ok)return {ok:false,errors:g.errors};
  if(!existsSync(join(dir,'types.ts')))return {ok:true,errors:[],note:'type check skipped: scene kit missing'};
  return typecheckScene(source,dir);
}
