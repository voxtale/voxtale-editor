import {expect,test} from 'bun:test';
import {editSchema,normalizeTranscript,repetitionCandidates,planTakes,planGraphics,runVideoPipeline,type Planner,type TakePlan,confirmConnectorRestarts,preserveRestartLeadIns,protectDistantRecaps} from '../src/video';
import {promptText} from '../src/services/prompts';
import {AUDIT_PROMPT_ID} from '../src/video/prompts';
function fixture(text:string) {
 const words=text.split(' ').map((text,id)=>({text,start:id*300+100,end:id*300+300}));
 const t=normalizeTranscript({id:'fixture',words},'fixture.mp4','hash',words.length*.3+1);
 const edit=editSchema.parse({version:1,name:'fixture',source:t.source,scenes:[{id:'one',in:0,out:t.duration}]});
 return {t,edit};
}
const cut=(startWord:number,endWord:number,keptStartWord:number,keptEndWord:number):TakePlan['removals'][number]=>({startWord,endWord,keptStartWord,keptEndWord,kind:'false-start',confidence:.98,reason:'Immediate completed restart'});
test('finds short repeats, phrase restarts and sentence repeats without making cuts',()=>{
 const {t}=fixture('Update for for MyApp my personal app my personal podcast app. We save time. We save time.');
 const c=repetitionCandidates(t.words);
 expect(c.some(r=>r.first[0]===1&&r.second[0]===2)).toBe(true);
 expect(c.some(r=>r.first[0]===4&&r.second[0]===7)).toBe(true);
 expect(c.some(r=>r.text==='We save time.')).toBe(true);
 const deliberate=fixture('Very very good. They had had enough.');
 expect(repetitionCandidates(deliberate.t.words)).toHaveLength(2);
});
test('second pass finds missed short stumbles and preserves introduction and name',async()=>{
 const {t,edit}=fixture('Update for for MyApp my personal app my personal podcast app.');
 const outputs=new Map<string,unknown>();let calls=0;
 const planner:Planner=async(system,input)=>{
  calls++;
  if(calls===2) {
   expect(system).toBe(promptText(AUDIT_PROMPT_ID));
   expect((input as any).words.map((w:any)=>w.id)).not.toContain(4);
  }
  return {model:'fake',usage:null,plan:{summary:'Keep full introduction',removals:calls===1?[cut(4,6,7,10)]:[cut(1,1,2,2)]}};
 };
 const result=await planTakes(edit,t,planner,{write:async(n,v)=>{outputs.set(n,v);}});
 expect(result.plan.removals).toHaveLength(2);
 expect((outputs.get('retained-transcript') as any[]).map(w=>w.text).join(' ')).toBe('Update for MyApp my personal podcast app.');
 expect(result.prompts['video.takes']?.version).toBeGreaterThan(0);
});
test('audit cannot cut speech already removed by selection',async()=>{
 const {t,edit}=fixture('We save We save time.');
 const planner:Planner=async()=>({model:'fake',usage:null,plan:{summary:'repeat',removals:[cut(0,1,2,4)]}});
 await expect(planTakes(edit,t,planner,{write:async()=>{}})).rejects.toThrow('removed or unknown');
});
test('whole workflow accepts injected providers and an in-memory output sink',async()=>{
 const {t,edit}=fixture('Very very good. They had had enough.');
 const artifacts=new Map<string,unknown>();let calls=0;
 const result=await runVideoPipeline(edit,{
  transcribe:async()=>t,
  planner:async()=>({model:'fake',usage:null,plan:++calls<=2?{summary:'Intentional wording',removals:[]}:{graphics:[]}}),
  output:{write:async(n,v)=>{artifacts.set(n,v);}},
  render:async(e)=>({frames:e.scenes.length}),
 });
 expect(result.edit.captions.map(c=>c.text).join(' ')).toBe('Very very good. They had had enough.');
 expect(artifacts.has('graphics-plan')).toBe(true);
 expect(result.rendered).toEqual({frames:1});
});
test('invalid proposals get one repair attempt before cuts',async()=>{
 const {t,edit}=fixture('Update for for MyApp.');let calls=0;
 const planner:Planner=async()=>({model:'fake',usage:null,plan:{summary:'Fixed',removals:++calls===1?[cut(1,1,2,99)]:calls===2?[cut(1,1,2,2)]:[]}});
 const result=await planTakes(edit,t,planner,{write:async()=>{}});
 expect(calls).toBe(3);expect(result.plan.removals).toHaveLength(1);
});
test('overlapping proposals resolve in code without a repair round',async()=>{
 const {t,edit}=fixture('Update for for MyApp.');let calls=0;
 const planner:Planner=async()=>({model:'fake',usage:null,plan:{summary:'Dupes',removals:++calls===1?[cut(1,1,2,2),cut(1,1,2,2)]:[]}});
 const result=await planTakes(edit,t,planner,{write:async()=>{}});
 expect(calls).toBe(2);expect(result.plan.removals).toHaveLength(1);
});
test('a cut ending on its own kept take keeps the stumble check (super-tale-e4qh)',async()=>{
 // Real plan shape (cut 145-147 keeping 147-148); before, the repair round repeated it and the clip lost its check.
 const {t,edit}=fixture('Defining defining constraints, constraints, is the job.');let calls=0;
 const planner:Planner=async()=>({model:'fake',usage:null,plan:{summary:'Stutter',removals:++calls===1?[{...cut(1,3,3,4),kind:'retake'}]:[]}});
 const result=await planTakes(edit,t,planner,{write:async()=>{}});
 expect(calls).toBe(2);
 expect(result.plan.removals[0]).toMatchObject({startWord:1,endWord:2,keptStartWord:3});
});

test('connector rule confirms a paused So restart but leaves emphasis and grammar alone',()=>{
 const {t}=fixture('So, so I did it.');t.words[1]!.start=4.5;t.words[1]!.end=4.7;
 const proposal={summary:'repeat',removals:[{...cut(0,0,1,1),confidence:.75}]};
 expect(confirmConnectorRestarts(proposal,t).removals[0]!.confidence).toBe(1);
 const emphasis=fixture('So so good.');
 expect(confirmConnectorRestarts(proposal,emphasis.t).removals[0]!.confidence).toBe(.75);
 const grammar=fixture('They had had enough.');
 expect(confirmConnectorRestarts({removals:[{...cut(1,1,2,2),confidence:.7}]},grammar.t).removals[0]!.confidence).toBe(.7);
});

test('minimal cut alignment preserves unique lead-in before a sentence restart',()=>{
 const {t}=fixture("But then I realized I don't really pay API. I don't pay API cost.");
 const plan={removals:[cut(0,8,9,13)]};
 expect(preserveRestartLeadIns(plan,t).removals[0]!.startWord).toBe(4);
});

test('distant recap cannot erase a setup sentence despite high model confidence',()=>{
 const {t}=fixture('I set up OpenCode on my server. It supports a regular subscription and handles authentication for each request. I set it up and halved costs.');
 const plan={removals:[cut(0,6,19,26)]};
 expect(protectDistantRecaps(plan,t).removals[0]!.confidence).toBe(0);
});

test('graphics repair receives scene word IDs and cannot place a graphic over a cut',async()=>{
 const {t,edit}=fixture('We save time with clear cuts.');let calls=0;
 const response=await planGraphics(edit,t,async(_system,input)=>{
   expect((input as any).scenes[0].wordIds).toEqual([0,1,2,3,4,5]);
   return {model:'fake',usage:null,plan:{graphics:[{sceneId:'one',startWord:0,endWord:++calls===1?99:5,style:'callout',text:'Save time',reason:'Stated benefit'}]}};
 },{write:async()=>{}});
 expect(calls).toBe(2);expect((response.plan as any).graphics[0].endWord).toBe(5);
});
