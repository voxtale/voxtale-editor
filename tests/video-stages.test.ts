import {askPlanner} from '../src/video/openrouter';
import {expect,test} from 'bun:test';
import {editSchema} from '../src/video/model';
import {normalizeTranscript,transcriptSchema} from '../src/video/transcript';
import {buildTakeEdit,buildGraphicsEdit} from '../src/video/stages';
import {reconcileTakes} from '../src/video/editing';
import {takePlanSchema,graphicsPlanSchema,TAKE_JSON} from '../src/video/planner';
const transcript=()=>normalizeTranscript({id:'test',words:[
 {text:'Save',start:1000,end:1400},{text:'time.',start:1500,end:1900},
 {text:'Sorry.',start:2300,end:2700},{text:'Save',start:4000,end:4400},{text:'time',start:4500,end:4900},
 {text:'with',start:5000,end:5400},{text:'clear',start:5500,end:5900},{text:'cuts.',start:6000,end:6400},
 {text:'Keep',start:7000,end:7400},{text:'your',start:7500,end:7900},{text:'voice.',start:8000,end:8400},
]},'/test.mp4','hash',10);
const edit=()=>editSchema.parse({version:1,name:'test',source:'/test.mp4',scenes:[{id:'scene',in:0,out:10}]});
const plan=()=>takePlanSchema.parse({summary:'Keep the complete take',removals:[{startWord:0,endWord:2,kind:'retake',keptStartWord:3,keptEndWord:7,confidence:0.96,reason:'The later take completes the point; the first is abandoned.'}]});
test('a file cut mid-word: the last word ends at the file end, words past it are dropped',()=>{
  const t=normalizeTranscript({id:'cut',words:[{text:'kind',start:9000,end:9500},{text:'of',start:9600,end:11800},{text:'ghost',start:10100,end:10400}]},'/cut.mp4','hash',10);
  expect(t.words.map(w=>[w.text,w.end])).toEqual([['kind',9.5],['of',10]]);
});
test('retake selection keeps complete passage, removes setup and maps captions',()=>{
 const result=buildTakeEdit(edit(),transcript(),plan());
 expect(result.decisions[0]!.keptText).toBe('Save time with clear cuts.');
 expect(result.decisions[0]!.applied).toBe(true);
 expect(result.edit.scenes.some(s=>s.in<=4&&s.out>=6.4)).toBe(true);
 expect(result.edit.scenes.every(s=>s.in>=2.7)).toBe(true);
 expect(result.edit.captions.map(c=>c.text).join(' ')).not.toContain('Sorry');
});
test('low-confidence suggestions remain untouched when pause trim is disabled',()=>{
 const p=plan();p.removals[0]!.confidence=0.6;
 const result=buildTakeEdit(edit(),transcript(),p,0.85,false);
 expect(result.edit.scenes.map(s=>[s.in,s.out])).toEqual([[0,10]]);
 expect(result.decisions[0]!.applied).toBe(false);
});
test('rejects invented ranges, overlapping decisions and removal of the selected take',()=>{
 const p=plan();p.removals[0]!.endWord=99;
 expect(()=>buildTakeEdit(edit(),transcript(),p)).toThrow('Invalid word range');
 const p2=plan();p2.removals.push({...p2.removals[0]!});expect(()=>buildTakeEdit(edit(),transcript(),p2)).toThrow('overlap');
 const p3=plan();p3.removals.push({...p3.removals[0]!,startWord:3,endWord:7,keptStartWord:0,keptEndWord:1});
 expect(()=>buildTakeEdit(edit(),transcript(),p3)).toThrow('replacement');
});
test('cannot cut speech outside the selected source scene',()=>{
 const e=edit();e.scenes[0]!.in=4;
 expect(()=>buildTakeEdit(e,transcript(),plan())).toThrow('outside the edit');
});
test('graphics reference only kept words and end within the scene',()=>{
 const t=transcript(),e=buildTakeEdit(edit(),t,plan()).edit;
 const s=e.scenes.find(s=>s.in<=4&&s.out>=6.4)!;
 const p=graphicsPlanSchema.parse({graphics:[{sceneId:s.id,startWord:3,endWord:7,text:'Save time with clear cuts',style:'callout',reason:'States the benefit'}]});
 const result=buildGraphicsEdit(e,t,p),g=result.scenes.find(x=>x.id===s.id)!.graphics![0]!;
 expect(g.in).toBe(4);expect(g.out).toBeLessThanOrEqual(s.out);
 p.graphics[0]!.startWord=0;
 expect(()=>buildGraphicsEdit(e,t,p)).toThrow('outside the edit');
});
test('provider milliseconds normalize to seconds; malformed word timing is rejected',()=>{
 expect(transcript().words[0]!.start).toBe(1);
 const t=transcript();t.words[0]!.end=0;
 expect(()=>transcriptSchema.parse(t)).toThrow();
});
test('planner rejects truncation rather than accepting partial edits',async()=>{
 const saved=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test';
 try {
  const request=(async()=>Response.json({choices:[{finish_reason:'length',message:{content:'{}'}}]}));
  await expect(askPlanner('test',{},TAKE_JSON,'test',request)).rejects.toThrow('truncated');
 }finally {if(saved)process.env.OPENROUTER_API_KEY=saved;else delete process.env.OPENROUTER_API_KEY;}
});

test('saved stages resume without another request and reject changed inputs or outputs',async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {fileHash}=await import('../src/video/artifacts');const {stage}=await import('../src/video/stages');
 const dir=await mkdtemp(join(tmpdir(),'video-stage-cache-'));
 try {
  const source=join(dir,'source.mp4');await writeFile(source,'stable source fixture');
  const e=edit();e.source=source;
  const t=transcript();t.source=source;t.sourceHash=await fileHash(source);
  const tp=join(dir,'transcript.json'),pp=join(dir,'plan.json'),out=join(dir,'takes');
  await writeFile(tp,JSON.stringify(t));await writeFile(pp,JSON.stringify(plan()));
  const first=await stage('takes',e,tp,out,{plan:pp});
  const {stageDoc}=await import('../src/video/stages');const {editFromEditDoc}=await import('../src/video/editdoc');
  const doc=(await stageDoc(out))!;
  expect(doc.provenance.map(p=>p.stage)).toEqual(['assembly','text']);
  expect(doc.tracks.captions[0]!.words[0]).toMatch(/^source:\d+$/);
  expect(editFromEditDoc(doc,{clipPath:()=>source}).scenes.map(s=>[s.in,s.out])).toEqual(first.scenes.map(s=>[Math.round(s.in*30)/30,Math.round(s.out*30)/30]));
  expect(await stage('takes',e,tp,out,{plan:pp})).toEqual(first);
  await expect(stage('takes',e,tp,out,{plan:pp,confidence:0.99})).rejects.toThrow('inputs changed');
  const altered=JSON.parse(await readFile(join(out,'edit.json'),'utf8'));altered.name='Manual change';
  await writeFile(join(out,'edit.json'),JSON.stringify(altered));
  await expect(stage('takes',e,tp,out,{plan:pp})).rejects.toThrow('stage edit changed');
  await writeFile(source,'different source fixture');
  await expect(stage('takes',e,tp,join(dir,'other'),{plan:pp})).rejects.toThrow('different source');
 }finally {await rm(dir,{recursive:true,force:true});}
});

test('generated captions exclude words outside an existing cut and do not duplicate repeated scenes',()=>{
 const e=edit();e.scenes=[{...e.scenes[0]!,id:'one',in:4.5,out:6.4},{...e.scenes[0]!,id:'two',in:4.5,out:6.4}];
 const built=buildTakeEdit(e,transcript(),{summary:'Keep both',removals:[]},0.85,false).edit;
 expect(built.captions).toHaveLength(2);
 expect(built.captions[0]!.text).toBe('time with clear cuts.');
 expect(built.captions[0]!.sceneId).not.toBe(built.captions[1]!.sceneId);
});

test('reconcile sends a cut to review when another cut removes its replacement',()=>{
 const p=plan();p.removals.push({...p.removals[0]!,startWord:3,endWord:7,keptStartWord:8,keptEndWord:10});
 const r=reconcileTakes(p,0.85);
 expect(r.removals[0]!.confidence).toBeLessThan(0.85);
 expect(r.removals[0]!.reason).toContain('another cut removes its replacement');
 expect(r.removals[1]!.confidence).toBe(0.96);
 expect(()=>buildTakeEdit(edit(),transcript(),r)).not.toThrow();
});
test('reconcile drops a cut that lies wholly inside its kept take',()=>{
 const p=plan();p.removals[0]={...p.removals[0]!,startWord:4,endWord:5,keptStartWord:3,keptEndWord:7};
 expect(reconcileTakes(p,0.85).removals).toHaveLength(0);
});
