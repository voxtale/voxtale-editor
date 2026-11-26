// Multi-clip story edit (P3): passages, structure checks, assembly by code,
// and the whole agent run with a fake planner, including replans that must
// keep the creator's work.
import {describe,expect,test} from 'bun:test';
import {
  STYLE_PRESETS,acceptSuggestion,applyCreatorPatch,applyCreatorRevision,parseEditDoc,rejectSuggestion,
  type ClipRef,type EditDoc,
} from '@voxtale/editdoc';
import {
  assembleStory,brollItems,brollLibrary,buildPassages,capCoverage,checkStructure,planStoryEdit,planZoom,speakingClips,PUNCH,HOOK_PUSH,
  type Passage,type SpeechWord,type StoryClip,type StructurePlan,type Transcript,
} from '../src/video';

const fps={num:30,den:1};
/** Sentences → words 0.4 s long, 0.1 s apart; `pauses` adds silence before a sentence index. */
function transcript(hash:string,sentences:string[],pauses:Record<number,number>={}):Transcript {
  const words:Transcript['words']=[];
  let t=0.5;
  sentences.forEach((s,i)=>{
    t+=pauses[i]??0;
    for(const text of s.split(' ')){words.push({id:words.length,text,start:+t.toFixed(3),end:+(t+0.4).toFixed(3),confidence:0.99});t+=0.5;}
    t+=0.3;
  });
  return {version:1,provider:'assemblyai',providerId:'x',source:`${hash}.mov`,sourceHash:hash.repeat(64).slice(0,64),duration:Math.ceil(t+1),model:'u',words};
}
const ref=(id:string,t:Transcript,over:Partial<ClipRef>={}):ClipRef=>({id,hash:t.sourceHash,name:`${id}.mov`,kind:'video',role:'a-roll',roleSource:'creator',
  duration:t.duration,fps,width:1920,height:1080,hasAudio:true,timecodeStart:0,...over});
const words=(clipId:string,t:Transcript):SpeechWord[]=>t.words.map(w=>({clipId,id:w.id,text:w.text,start:w.start,end:w.end}));

// Take 1 flubs the intro; take 2 has the clean intro and the rest.
const T1=transcript('a',['Hi everyone today I test the new camera rig and it is heavy.','Wait let me start again.']);
const T2=transcript('b',['Hi everyone today I test the new camera rig for travel.','It costs three hundred dollars and weighs two kilos.','The battery lasts four hours on one charge.','So is it worth it for you?'],{2:3});

describe('passages',()=>{
  test('split at sentence ends and long pauses, numbered across clips',()=>{
    const p=buildPassages([{clipId:'c1',words:words('c1',T1)},{clipId:'c2',words:words('c2',T2)}]);
    expect(p.map(x=>x.id)).toEqual(['P001','P002','P003','P004','P005','P006']);
    expect(p[0]!.words.at(-1)!.text).toBe('heavy.');
    expect(p.slice(2).every(x=>x.clipId==='c2')).toBe(true);
  });
});

const passages=()=>buildPassages([{clipId:'c1',words:words('c1',T1)},{clipId:'c2',words:words('c2',T2)}]);
const plan=(over:Partial<StructurePlan>={}):StructurePlan=>({
  beats:[
    {id:'hook',role:'hook',title:'The new rig',content:'What is being tested',passages:['P003']},
    {id:'cost',role:'proof',title:'Cost and weight',content:'Price and weight',passages:['P004','P005']},
    {id:'end',role:'ending',title:'Verdict',content:'Is it worth it',passages:['P006']},
  ],
  dropped:[{passage:'P001',kind:'retake',replacedBy:'P003',confidence:0.95,reason:'Take 2 is complete'},
    {passage:'P002',kind:'setup',replacedBy:null,confidence:0.97,reason:'Talk to self'}],
  summary:'s',...over,
});

describe('structure checks',()=>{
  test('accepts a complete plan and names the first problem otherwise',()=>{
    expect(checkStructure(plan(),passages()).beats).toHaveLength(3);
    expect(()=>checkStructure(plan({beats:[...plan().beats,{id:'x',role:'setup',title:'x',content:'x',passages:['P003']}]}),passages())).toThrow(/used twice/);
    expect(()=>checkStructure(plan({dropped:[{passage:'P009',kind:'setup',replacedBy:null,confidence:1,reason:'r'}]}),passages())).toThrow(/unknown/);
    expect(()=>checkStructure(plan({dropped:[{passage:'P003',kind:'setup',replacedBy:null,confidence:1,reason:'r'}]}),passages())).toThrow(/both kept and dropped/);
  });

  test('a replacement that points at a dropped take follows the chain, else becomes a plain drop',()=>{
    const d=(passage:string,replacedBy:string|null)=>({passage,kind:'retake' as const,replacedBy,confidence:1,reason:'r'});
    const chained=checkStructure(plan({dropped:[d('P001','P002'),d('P002','P003')]}),passages());
    expect(chained.dropped.map(x=>x.replacedBy)).toEqual(['P003','P003']);
    const dangling=checkStructure(plan({dropped:[d('P001','P002'),d('P002','P001')]}),passages());
    expect(dangling.dropped.map(x=>x.replacedBy)).toEqual([null,null]);
    expect(checkStructure(plan({dropped:[d('P001','P002')]}),passages()).dropped[0]!.replacedBy).toBeNull();
  });
});

const speech=()=>new Map([['c1',{duration:T1.duration,words:T1.words}],['c2',{duration:T2.duration,words:T2.words}]]);
const assemble=(p:StructurePlan,ps:Passage[]=passages())=>assembleStory(checkStructure(p,ps),ps,{fps,clips:speech(),maxPause:0.8,threshold:0.85});

describe('assembly',()=>{
  test('lays beats end to end, cuts sure retakes and shortens long pauses',()=>{
    const a=assemble(plan());
    expect(a.items.every(i=>i.clipId==='c2'&&i.status==='applied')).toBe(true);
    // One item per beat, and the 3 s pause before the battery line splits the cost beat with most of the silence gone.
    expect(a.items).toHaveLength(4);
    const [,first,second]=a.items;
    expect(first!.end).toBe(second!.start);
    expect(second!.in-first!.out).toBeGreaterThan(2.5);
    expect(a.brief.dropped!.map(d=>[d.kind,d.clipId,d.replacedBy])).toEqual([['retake','c1','hook'],['setup','c1',undefined]]);
    expect(a.brief.beats.map(b=>b.id)).toEqual(['hook','cost','end']);
    expect(a.brief.beats[1]!.footage!.length).toBeGreaterThan(0);
  });

  test('unsure drops stay in as flagged items before the take that replaces them',()=>{
    const a=assemble(plan({dropped:[{passage:'P001',kind:'retake',replacedBy:'P003',confidence:0.5,reason:'Maybe weaker'},
      {passage:'P002',kind:'setup',replacedBy:null,confidence:0.4,reason:'Aside'}]}));
    const [flag,...rest]=a.items;
    expect(flag).toMatchObject({clipId:'c1',status:'remove-suggested',confidence:0.5});
    expect(flag!.reason).toContain('retake');
    // P002 has no replacement: it goes after the previous kept passage of its clip (P001).
    expect(rest[0]).toMatchObject({clipId:'c1',status:'remove-suggested'});
    expect(a.brief.dropped).toEqual([]);
  });

  test('passages the plan forgot go back in recording order',()=>{
    const p=plan();
    p.beats[1]!.passages=['P004'];
    const a=assemble(p);
    expect(a.restored).toEqual(['P005']);
    const src=a.items.map(i=>[i.clipId,i.in]);
    expect(src).toEqual([...src].sort((x,y)=>(x[1] as number)-(y[1] as number)));
  });

  test('chapters need three beats at least 10 s apart; outline beats with no speech become coverage notes',()=>{
    const long=transcript('c',Array.from({length:12},(_,i)=>`Sentence number ${i} has exactly seven words here.`));
    const ps=buildPassages([{clipId:'c3',words:words('c3',long)}]);
    const ids=ps.map(p=>p.id);
    const beats=[ids.slice(0,4),ids.slice(4,8),ids.slice(8)].map((passages,i)=>({id:`b${i}`,role:'progress' as const,title:`Part ${i}`,content:'c',passages}));
    const a=assembleStory(checkStructure({beats,dropped:[],summary:''},ps),ps,{fps,clips:new Map([['c3',{duration:long.duration,words:long.words}]]),maxPause:0.8,threshold:0.85,
      outline:{beats:[{id:'b0',title:'Part 0',visual:'screen recording'},{id:'missing',title:'Demo'}]}});
    expect(a.markers.map(m=>m.time)).toEqual([0,a.items.find(i=>i.evidence![0]!.ref==='b1')!.start,a.items.find(i=>i.evidence![0]!.ref==='b2')!.start]);
    expect(a.brief.source).toBe('outline+inferred');
    expect(a.brief.beats[0]!.visual).toBe('screen recording');
    expect(a.brief.coverage).toEqual([{beatId:'missing',kind:'no-footage',note:'Nothing recorded for "Demo".'}]);
  });
});

/** Planner that answers each stage by its schema; records what it was asked. */
function fakePlanner(structure:StructurePlan|((input:any)=>unknown),seen:string[]=[]) {
  return async(_system:string,input:any,schema:any)=>{
    const p=schema.properties;
    if(p.removals){seen.push('takes');return {plan:{removals:[],summary:''},model:'m',usage:null};}
    if(p.beats){seen.push('structure');return {plan:typeof structure==='function'?structure(input):structure,model:'m-structure',usage:null};}
    if(p.items?.items.properties.segment){
      seen.push('broll');
      const shot=input.shots[1]??input.shots[0];
      const ids=shot.words.split(' ').map((w:string)=>Number(w.split(':')[0]));
      return {plan:{items:[{shot:shot.shot,startWord:ids[0],endWord:ids[4],segment:input.library[0].id,alternates:input.library.slice(1).map((l:any)=>l.id),
        confidence:0.9,reason:'shows the rig'}]},model:'m-broll',usage:null};
    }
    if(p.items?.items.properties.facts){
      seen.push('graphics');
      if(input.fail)throw new Error('down');
      const shot=input.shots[1]??input.shots[0];
      const ids=shot.words.split(' ').map((w:string)=>Number(w.split(':')[0]));
      return {plan:{items:[{shot:shot.shot,startWord:ids[0],endWord:ids[3],kind:'stat',title:'Cost',facts:[{label:'price',value:'$300'}],placement:'right',
        confidence:0.9,reason:'numbers read better on screen'}]},model:'m-graphics',usage:null};
    }
    if(p.items){
      seen.push('text');
      const shot=input.shots[0];
      const [a,b]=shot.words.split(' ').slice(0,3).filter((_:string,i:number)=>i!==1).map((w:string)=>Number(w.split(':')[0]));
      return {plan:{items:[{shot:shot.shot,startWord:a,endWord:b,template:'callout',text:'New travel rig',confidence:0.9,reason:'topic'}]},model:'m-text',usage:null};
    }
    throw new Error('unexpected schema');
  };
}
const clips=():StoryClip[]=>[{ref:ref('c1',T1),transcript:T1},{ref:ref('c2',T2),transcript:T2},
  {ref:ref('c3',transcript('d',['b roll'])!,{role:'b-roll',hasAudio:false,name:'broll.mov'})}];
const output={write:async()=>{},progress:()=>{}};

describe('planStoryEdit',()=>{
  test('cuts speech from several clips into one valid doc with brief, captions and text',async()=>{
    const seen:string[]=[];
    const {doc,notes}=await planStoryEdit({id:'e1',name:'Rig review',clips:clips(),instruction:'tight',revision:1,
      planner:fakePlanner(plan(),seen),output,now:()=>new Date('2026-09-30T00:00:00Z')});
    expect(seen.sort()).toEqual(['structure','takes','takes','takes','takes','text']); // selection + audit per spoken clip
    expect(notes).toEqual([]);
    expect(doc.revision).toBe(1);
    expect(doc.provenance.map(p=>[p.stage,p.revision])).toEqual([['structure',1],['assembly',1],['zoom',1],['text',1]]);
    expect(doc.provenance[0]!.model).toBe('m-structure');
    expect(Object.keys(doc.provenance[0]!.prompts)).toContain('video.structure');
    expect(doc.clips.map(c=>c.id)).toEqual(['c1','c2','c3']);
    expect(doc.brief).toMatchObject({source:'inferred',instruction:'tight'});
    expect(doc.tracks['a-roll'].length).toBeGreaterThan(0);
    expect(doc.tracks.captions.length).toBeGreaterThan(3);
    expect(doc.tracks.captions.every(c=>c.words.every(w=>w.startsWith('c2:')))).toBe(true);
    expect(doc.tracks.text).toHaveLength(1);
    expect(doc.tracks.text[0]).toMatchObject({template:'callout',status:'applied',owner:'agent'});
    expect(()=>parseEditDoc(doc)).not.toThrow();
  });

  test('repairs an invalid story plan once',async()=>{
    let calls=0;
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:clips(),planner:fakePlanner(input=>{calls++;return input.invalidPlan?plan():{...plan(),beats:[]};}),output});
    expect(calls).toBe(2);
    expect(doc.tracks['a-roll'].length).toBeGreaterThan(0);
  });

  test('without an a-roll pick the longest spoken video is cut, with a note',async()=>{
    const cs=clips().map(c=>({...c,ref:{...c.ref,role:'other' as const}}));
    expect(speakingClips(cs).map(c=>c.ref.id)).toEqual(['c2']);
    const one=buildPassages([{clipId:'c2',words:words('c2',T2)}]).map(p=>p.id);
    const {doc,notes}=await planStoryEdit({id:'e1',name:'x',clips:cs,output,
      planner:fakePlanner({beats:[{id:'all',role:'progress',title:'All',content:'All of it',passages:one}],dropped:[],summary:''})});
    expect(notes[0]).toContain('c2.mov');
    expect(new Set(doc.tracks['a-roll'].map(i=>i.clipId))).toEqual(new Set(['c2']));
  });
});

describe('target length',()=>{
  // P003-P006 assemble to about 16 s; hook + verdict alone to about 9 s.
  const short=(confidence:number)=>plan({beats:[plan().beats[0]!,plan().beats[2]!],
    dropped:[...plan().dropped,...['P004','P005'].map(passage=>({passage,kind:'length' as const,replacedBy:null,confidence,reason:'Least needed'}))]});
  const seconds=(doc:EditDoc)=>doc.tracks['a-roll'].at(-1)!.end;

  test('the planner sees passage lengths; a long cut is measured and planned again',async()=>{
    const asked:any[]=[];
    const {doc,notes}=await planStoryEdit({id:'e1',name:'x',clips:clips(),targetDuration:10,output,
      planner:fakePlanner(input=>{asked.push(input);return input.lengthCheck?short(0.6):plan();})});
    expect(asked[0].passages[2].seconds).toBeGreaterThan(4);
    expect(asked[0].totalSeconds).toBeGreaterThan(20);
    expect(asked).toHaveLength(2);
    expect(asked[1].lengthCheck).toMatchObject({targetSeconds:10});
    expect(asked[1].lengthCheck.keptSeconds).toBeGreaterThan(14);
    expect(asked[1].previousPlan.beats).toHaveLength(3);
    // Length drops are cut even when unsure: the creator asked for the length.
    expect(seconds(doc)).toBeLessThan(11.5);
    expect(doc.tracks['a-roll'].every(i=>i.status==='applied')).toBe(true);
    expect(doc.brief!.dropped!.filter(d=>d.kind==='length')).toHaveLength(2);
    expect(Object.keys(doc.provenance[0]!.prompts)).toContain('video.structure-length');
    expect(notes).toEqual([]);
  });

  test('asks at most twice more, keeps the closest plan and says how long the cut runs',async()=>{
    let calls=0;
    const {doc,notes}=await planStoryEdit({id:'e1',name:'x',clips:clips(),targetDuration:5,output,
      planner:fakePlanner(input=>{calls++;return input.lengthCheck?short(0.9):plan();})});
    expect(calls).toBe(3); // the plan, then two retries; the second gets no closer, so the first retry stands
    expect(seconds(doc)).toBeLessThan(11.5);
    expect(notes.at(-1)).toMatch(/runs \d+ s against your 5 s target/);
  });

  test('without a target, unsure length drops stay in for the creator',()=>{
    const a=assemble(short(0.6));
    expect(a.items.some(i=>i.status==='remove-suggested')).toBe(true);
  });
});

describe('replan keeps the creator’s work',()=>{
  const first=()=>planStoryEdit({id:'e1',name:'x',clips:clips(),revision:1,planner:fakePlanner(plan()),output}).then(r=>r.doc);

  test('a creator change on the cut locks it; captions and text are redone around it',async()=>{
    const before=await first();
    const item=before.tracks['a-roll'][0]!;
    const edited=applyCreatorPatch(before,{tracks:{'a-roll':{upsert:[{...item,out:item.out-0.5,end:item.end-0.5}]},
      text:{upsert:[{id:'mine',start:0,end:3,owner:'creator',status:'applied',template:'title',text:'My title',position:'auto'}]}}} as never);
    const {doc,notes}=await planStoryEdit({id:'e1',name:'x',clips:clips(),previous:edited,revision:3,planner:fakePlanner(plan()),output});
    expect(notes[0]).toContain('stays as you left it');
    expect(doc.tracks['a-roll']).toEqual(edited.tracks['a-roll']);
    expect(doc.policy['a-roll']).toBe('locked');
    expect(doc.tracks.text.find(t=>t.id==='mine')).toMatchObject({owner:'creator',text:'My title'});
    // The agent callout at the start overlapped the creator's title, so it was left out.
    expect(doc.tracks.text.filter(t=>t.owner==='agent')).toEqual([]);
    expect(doc.revision).toBe(3);
  });

  test('without creator cut changes a replan rebuilds the cut but keeps creator markers',async()=>{
    const before=await first();
    const edited=applyCreatorPatch(before,{markers:{upsert:[{id:'note1',time:1,kind:'note',title:'Check audio',owner:'creator',status:'applied'}]}});
    const p=plan();p.beats[1]!.passages=['P005','P004'];
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:clips(),previous:edited,revision:2,planner:fakePlanner(p),output});
    expect(doc.markers.find(m=>m.id==='note1')).toMatchObject({owner:'creator'});
    expect(doc.tracks['a-roll'].map(i=>i.in)).not.toEqual(before.tracks['a-roll'].map(i=>i.in));
  });

  test('what the creator deleted does not come back on a replan',async()=>{
    const before=await first();
    const gone=before.tracks['a-roll'][1]!,cap=before.tracks.captions[0]!;
    const {doc:edited,decisions}=applyCreatorRevision(before,{patch:{tracks:{'a-roll':{remove:[gone.id]},captions:{remove:[cap.id]}}}});
    expect(edited.declined).toEqual(expect.arrayContaining([gone.id,cap.id]));
    expect(decisions.map(d=>d.action)).toEqual(['deleted','deleted']);
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:clips(),previous:edited,revision:3,planner:fakePlanner(plan()),output});
    expect(doc.tracks['a-roll'].some(i=>i.id===gone.id)).toBe(false);
    expect(doc.tracks.captions.some(c=>c.id===cap.id)).toBe(false);
    expect(doc.tracks['a-roll'][0]!.start).toBe(0);
    for(const [a,b] of doc.tracks['a-roll'].slice(1).map((x,i)=>[doc.tracks['a-roll'][i]!,x] as const))expect(b.start).toBeCloseTo(a.end,6); // closed up
  });

  test('deleted on-screen text stays out even when the new cut gives it a new id',async()=>{
    const before=await first();
    const t=before.tracks.text[0]!;
    // Reworded first, so it is the creator's; then deleted.
    const mine=applyCreatorRevision(before,{patch:{tracks:{text:{upsert:[{...t,text:'The new travel rig'}]}}}}).doc;
    const edited=applyCreatorRevision(mine,{patch:{tracks:{text:{remove:[t.id]}}}}).doc;
    expect(edited.declinedText).toEqual(['The new travel rig']);
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:clips(),previous:{...edited,declined:[]},revision:4,planner:fakePlanner(plan()),output});
    expect(doc.tracks.text).toEqual([]);
  });
});

describe('review actions on flagged cuts',()=>{
  test('accepting a flagged a-roll cut closes the gap; rejecting keeps it',async()=>{
    const unsure=plan({dropped:[{passage:'P001',kind:'retake',replacedBy:'P003',confidence:0.5,reason:'Maybe weaker'},
      {passage:'P002',kind:'setup',replacedBy:null,confidence:0.97,reason:'Aside'}]});
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:clips(),planner:fakePlanner(unsure),output});
    const flagged=doc.tracks['a-roll'].find(i=>i.status==='remove-suggested')!;
    expect(flagged.start).toBe(0);
    const len=flagged.end-flagged.start;
    const total=(d:EditDoc)=>d.tracks['a-roll'].at(-1)!.end;
    const accepted=acceptSuggestion(doc,flagged.id);
    expect(accepted.tracks['a-roll'].some(i=>i.id===flagged.id)).toBe(false);
    expect(accepted.tracks['a-roll'][0]!.start).toBe(0);
    expect(total(accepted)).toBeCloseTo(total(doc)-len,5);
    // Captions that belonged to the cut went with it; the rest moved left.
    expect(accepted.tracks.captions.every(c=>c.words.every(w=>w.startsWith('c2:')))).toBe(true);
    expect(accepted.tracks.captions[0]!.start).toBeLessThan(doc.tracks.captions.find(c=>c.words[0]!.startsWith('c2:'))!.start);
    const rejected=rejectSuggestion(doc,flagged.id);
    expect(rejected.tracks['a-roll'].find(i=>i.id===flagged.id)!.status).toBe('applied');
  });
});

test('calm explainer is the default style',async()=>{
  const {doc}=await planStoryEdit({id:'e1',name:'x',clips:clips(),planner:fakePlanner(plan()),output});
  expect(doc.styleRef.id).toBe(STYLE_PRESETS['calm-explainer'].id);
});

/** A b-roll clip whose index shows the rig, the battery, a too-short insert and a blurred shot. */
function brollClip():StoryClip {
  const seg=(id:string,start:number,end:number,description:string,over:object={})=>({id,start,end,description,subjects:[],action:'',setting:'',shotType:'insert' as const,
    onScreenText:[],quality:{blur:false,exposure:'ok' as const,shaky:false},usable:true,...over});
  return {ref:ref('c3',T2,{hash:'e'.repeat(64),role:'b-roll',hasAudio:false,name:'broll.mov',duration:30}),index:{clipHash:'e'.repeat(64),promptVersion:'v',model:'m',summary:'rig shots',roleGuess:'b-roll',missing:[],
    segments:[seg('S001',0,1,'rig close-up'),seg('S002',1,9,'battery charging on a desk'),seg('S003',9,17,'camera rig on a travel backpack'),
      seg('S004',17,25,'camera rig blurred',{quality:{blur:true,exposure:'ok',shaky:false}})]}};
}
const withBroll=():StoryClip[]=>[...clips().slice(0,2),brollClip()];

describe('b-roll stage',()=>{
  test('library keeps usable segments long enough, best match to the speech first',()=>{
    const lib=brollLibrary(withBroll(),new Set(['c1','c2']),words('c2',T2));
    expect(lib.map(s=>s.ref)).toEqual(['c3/S003','c3/S002']); // "camera", "travel" beat "battery"
    expect(brollLibrary(withBroll(),new Set(['c3']),[])).toEqual([]);
  });

  test('places matched footage with alternates as its own stage',async()=>{
    const seen:string[]=[];
    const {doc,notes}=await planStoryEdit({id:'e1',name:'x',clips:withBroll(),revision:1,planner:fakePlanner(plan(),seen),output});
    expect(notes).toEqual([]);
    expect(seen).toContain('broll');
    expect(doc.provenance.map(p=>p.stage)).toEqual(['structure','assembly','zoom','b-roll','text']);
    const [b]=doc.tracks['b-roll'];
    expect(b).toMatchObject({clipId:'c3',owner:'agent',status:'applied',muted:true,fit:'cover',stage:'b-roll'});
    expect(b!.start).toBeGreaterThanOrEqual(2);
    expect(b!.in).toBeGreaterThanOrEqual(9);
    expect(b!.out).toBeLessThanOrEqual(17);
    expect(b!.alternatives).toEqual([expect.objectContaining({clipId:'c3'})]);
    expect(b!.alternatives![0]!.out-b!.alternatives![0]!.in).toBeCloseTo(b!.end-b!.start,5);
    expect(b!.evidence).toContainEqual({kind:'segment',ref:'c3/S003'});
    expect(()=>parseEditDoc(doc)).not.toThrow();
  });

  test('placements are checked: hook, must-stay, reuse, overlap',async()=>{
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:clips(),planner:fakePlanner(plan()),output});
    const all=[...words('c1',T1),...words('c2',T2)];
    const lib=brollLibrary(withBroll(),new Set(['c1','c2']),all);
    const [hook,cost]=doc.tracks['a-roll'];
    const inShot=(s:typeof hook)=>all.filter(w=>w.clipId===s!.clipId&&w.start>=s!.in&&w.end<=s!.out).map(w=>w.id);
    const item=(shot:typeof hook,segment='c3/S003',at=0)=>({shot:shot!.id,startWord:inShot(shot)[at]!,endWord:inShot(shot).slice(0,at+5).at(-1)!,segment,alternates:[],confidence:0.9,reason:'r'});
    const run=(items:ReturnType<typeof item>[],stay:{start:number;end:number}[]=[])=>brollItems(doc,{items},all,lib,stay,true);
    expect(()=>run([item(hook)])).toThrow(/first 2 seconds/);
    expect(()=>run([item(cost)],[{start:cost!.start,end:cost!.start+1}])).toThrow(/must show the speaker/);
    expect(()=>run([item(cost),item(cost,'c3/S003',5)])).toThrow(/already used|overlaps/);
    expect(()=>run([item(cost,'c3/S001')])).toThrow(/not in the library/);
    expect(run([item(cost),item(cost,'c3/S002',6)])).toHaveLength(2);
    expect(brollItems(doc,{items:[item(hook),item(cost)]},all,lib,[],false)).toHaveLength(1);
  });

  test('coverage keeps the surest shots',()=>{
    const b=(id:string,start:number,confidence:number)=>({id,start,end:start+4,confidence} as never);
    expect(capCoverage([b('a',0,0.5),b('b',10,0.9),b('c',20,0.8)],0.1,40).map((x:any)=>x.id)).toEqual(['b']);
  });

  test('a replan keeps creator b-roll, leaves deleted shots out and places around the creator',async()=>{
    const first=(await planStoryEdit({id:'e1',name:'x',clips:withBroll(),revision:1,planner:fakePlanner(plan()),output})).doc;
    const agent=first.tracks['b-roll'][0]!;
    const deleted=applyCreatorRevision(first,{patch:{tracks:{'b-roll':{remove:[agent.id]}}}}).doc;
    expect(deleted.declined).toContain(agent.id);
    const again=(await planStoryEdit({id:'e1',name:'x',clips:withBroll(),previous:deleted,revision:3,planner:fakePlanner(plan()),output})).doc;
    expect(again.tracks['b-roll']).toEqual([]);
    const mine={...agent,id:'mine',owner:'creator' as const,alternatives:undefined};
    const covered=applyCreatorRevision(first,{patch:{tracks:{'b-roll':{remove:[agent.id],upsert:[mine]}}}}).doc;
    const third=(await planStoryEdit({id:'e1',name:'x',clips:withBroll(),previous:{...covered,declined:[]},revision:3,planner:fakePlanner(plan()),output})).doc;
    expect(third.tracks['b-roll'].map(b=>b.id)).toEqual(['mine']); // the agent shot would overlap it, so it was dropped
  });
});

describe('b-roll review',()=>{
  const jpeg=new Uint8Array([0xff,0xd8]);
  const look=(verdict:(n:number)=>boolean,calls:any[]=[])=>({
    still:async(clipId:string,segment:string,i:number)=>{calls.push([clipId,segment,i]);return jpeg;},
    vision:async(system:string,parts:any[])=>{
      const n=parts.filter(p=>p.type==='image').length;
      calls.push(['vision',system.length>0,n]);
      return {json:{items:Array.from({length:n},(_,k)=>({n:k,defect:verdict(k),kind:verdict(k)?'unrelated':'none',note:verdict(k)?'shows a desk':''}))},model:'v'};
    },
  });

  test('a shot with a defect swaps to a clean alternative',async()=>{
    const calls:any[]=[];
    const {doc,notes}=await planStoryEdit({id:'e1',name:'x',clips:withBroll(),revision:1,planner:fakePlanner(plan()),look:look(n=>n===0,calls),output});
    expect(calls).toContainEqual(['c3','S003',0]);
    expect(calls).toContainEqual(['c3','S002',0]);
    expect(calls).toContainEqual(['vision',true,2]);
    const [b]=doc.tracks['b-roll'];
    expect(b).toMatchObject({clipId:'c3',status:'applied'});
    expect(b!.in).toBeGreaterThanOrEqual(1);
    expect(b!.out).toBeLessThanOrEqual(9);
    expect(b!.evidence).toContainEqual({kind:'segment',ref:'c3/S002'});
    expect(b!.alternatives).toBeUndefined();
    expect(b!.reason).toContain('shows a desk');
    expect(b!.reason!.length).toBeLessThanOrEqual(300);
    expect(notes.join(' ')).toMatch(/Swapped 1 b-roll shot/);
    expect(()=>parseEditDoc(doc)).not.toThrow();
  });

  test('with no clean alternative the shot becomes a suggestion',async()=>{
    const {doc,notes}=await planStoryEdit({id:'e1',name:'x',clips:withBroll(),revision:1,planner:fakePlanner(plan()),look:look(()=>true),output});
    const [b]=doc.tracks['b-roll'];
    expect(b).toMatchObject({status:'suggested'});
    expect(b!.evidence).toContainEqual({kind:'segment',ref:'c3/S003'});
    expect(notes.join(' ')).toMatch(/left as a suggestion/);
  });

  test('a failed check keeps the shots and says so; a replan does not look again',async()=>{
    const broken={still:async()=>jpeg,vision:async()=>{throw new Error('down');}};
    const {doc,notes}=await planStoryEdit({id:'e1',name:'x',clips:withBroll(),revision:1,planner:fakePlanner(plan()),look:broken,output});
    expect(doc.tracks['b-roll'][0]).toMatchObject({status:'applied'});
    expect(notes.join(' ')).toMatch(/not checked/);
    const calls:any[]=[];
    await planStoryEdit({id:'e1',name:'x',clips:withBroll(),previous:doc,revision:2,planner:fakePlanner(plan()),look:look(()=>false,calls),output});
    expect(calls).toEqual([]);
  });
});

describe('zoom stage',()=>{
  const faced=():StoryClip[]=>clips().map(c=>c.ref.id!=='c2'?c:{...c,index:{clipHash:c.ref.hash,promptVersion:'v',model:'m',summary:'',roleGuess:'a-roll',missing:[],
    segments:[{id:'S001',start:0,end:60,description:'',subjects:[],action:'',setting:'',shotType:'talking-head',onScreenText:[],quality:{blur:false,exposure:'ok',shaky:false},usable:true,face:{x:0.3,y:0.35,w:0.2,h:0.3}}]}});
  const zoomOf=(doc:EditDoc,item:{start:number})=>doc.tracks.zoom.find(z=>z.start===item.start);

  test('fast styles push in on the hook and punch in across a jump cut, about the face',async()=>{
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:faced(),style:STYLE_PRESETS['fast-paced'],planner:fakePlanner(plan()),output});
    const [hook,cost1,cost2]=doc.tracks['a-roll'];
    expect(cost2!.in-cost1!.out).toBeGreaterThan(1); // the long pause became a jump cut
    // The hook pushes in over its whole length.
    expect(zoomOf(doc,hook!)).toMatchObject({scale:HOOK_PUSH,x:0.3,y:0.35,end:hook!.end,easeOut:0,stage:'zoom',owner:'agent'});
    expect(zoomOf(doc,hook!)!.easeIn).toBeCloseTo(hook!.end-hook!.start,3);
    expect(zoomOf(doc,cost1!)).toBeUndefined(); // a trimmed pause is a jump cut too: back out to the wide frame
    // The punch cuts in: the cut hides the jump.
    expect(zoomOf(doc,cost2!)).toMatchObject({scale:PUNCH,x:0.3,y:0.35,easeIn:0,easeOut:0,end:cost2!.end});
    expect(doc.tracks['a-roll'].some(i=>'zoom' in i)).toBe(false);
    expect(doc.provenance.map(p=>p.stage)).toContain('zoom');
    expect(()=>parseEditDoc(doc)).not.toThrow();
  });

  test('a punch-in aims so the eyes land where they were before the cut',async()=>{
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:faced(),planner:fakePlanner(plan()),output});
    const live=doc.tracks['a-roll'];
    const k=live.findIndex(i=>zoomOf(doc,i)?.easeIn===0);
    const [prev,item]=[live[k-1]!,live[k]!];
    // The speaker leaned right and down between takes.
    const eyesAt=(clipId:string,t:number)=>clipId!=='c2'?undefined:t>=item.in-1e-6?{x:0.36,y:0.33}:{x:0.33,y:0.31};
    const z=planZoom(doc,faced(),eyesAt).find(z=>z.start===item.start)!;
    const screen=(e:number,f:number)=>f+z.scale*(e-f);
    expect(zoomOf(doc,prev)).toBeUndefined();
    expect(screen(0.36,z.x)).toBeCloseTo(0.33,3);
    expect(screen(0.33,z.y)).toBeCloseTo(0.31,3);
    // The next piece is wide with the eyes at (0.36, 0.33): the punch drifts there by its last frame.
    expect(zoomOf(doc,live[k+1]!)).toBeUndefined();
    expect(z.end).toBe(item.end);
    expect(screen(0.36,z.panTo!.x)).toBeCloseTo(0.36,3);
    expect(screen(0.33,z.panTo!.y)).toBeCloseTo(0.33,3);
    // Too far to match inside the frame: the focus clamps rather than show an edge.
    const far=planZoom(doc,faced(),(c,t)=>c!=='c2'?undefined:t>=item.in-1e-6?{x:0.9,y:0.5}:{x:0.1,y:0.5}).find(z=>z.start===item.start)!;
    expect(far.x).toBe(1);
  });

  test('calm style only punches jump cuts; none clears agent zooms; creator zooms stay',async()=>{
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:faced(),planner:fakePlanner(plan()),output});
    expect(zoomOf(doc,doc.tracks['a-roll'][0]!)).toBeUndefined();
    expect(doc.tracks.zoom.map(z=>z.scale)).toEqual([PUNCH]);
    const none={...doc,styleRef:{...doc.styleRef,snapshot:{...doc.styleRef.snapshot,pace:{...doc.styleRef.snapshot.pace,zoomFrequency:'none' as const}}}};
    expect(planZoom(none,faced())).toEqual([]);
    const a0=doc.tracks['a-roll'][0]!;
    const mine={...doc.tracks.zoom[0]!,id:'mine',start:a0.start,end:a0.end,owner:'creator' as const,scale:2};
    expect(planZoom({...none,tracks:{...none.tracks,zoom:[mine]}},faced())).toEqual([mine]);
  });
});

describe('graphics stage',()=>{
  // Graphics need an edit of 20 s or more; same four sentences, said at length.
  const T2L=transcript('b',['Hi everyone today I test the new camera rig for travel and for long hikes in the hills.',
    'It costs three hundred dollars and weighs two kilos which is a lot for a rig this size.','The battery lasts four hours on one charge even in the cold.','So is it worth it for you and for the way you shoot?'],{2:3});
  const clips=():StoryClip[]=>[{ref:ref('c1',T1),transcript:T1},{ref:ref('c2',T2L),transcript:T2L}];
  test('off unless asked; when asked, one checked graphic with its render request',async()=>{
    const off=await planStoryEdit({id:'e1',name:'x',clips:clips(),planner:fakePlanner(plan()),output});
    expect(off.doc.tracks.graphics).toEqual([]);
    expect(off.graphics.size).toBe(0);
    const seen:string[]=[];
    const {doc,graphics,notes}=await planStoryEdit({id:'e1',name:'x',clips:clips(),graphics:true,planner:fakePlanner(plan(),seen),output});
    expect(notes).toEqual([]);
    expect(seen).toContain('graphics');
    expect(doc.provenance.map(p=>p.stage).at(-1)).toBe('graphics');
    const [g]=doc.tracks.graphics;
    expect(g).toMatchObject({owner:'agent',stage:'graphics',status:'applied',placement:'right',assetRevision:0});
    expect(g!.end-g!.start).toBeGreaterThanOrEqual(3);
    expect(g!.end-g!.start).toBeLessThanOrEqual(8);
    expect([...graphics.keys()]).toEqual([g!.assetId]);
    expect(graphics.get(g!.assetId)).toMatchObject({kind:'stat',title:'Cost',width:1920,height:1080,fps:30});
    expect(graphics.get(g!.assetId)!.durationInFrames).toBe(Math.round((g!.end-g!.start)*30));
    expect(()=>parseEditDoc(doc)).not.toThrow();
    // Same moment on a replan → same asset, so the render is reused.
    const again=await planStoryEdit({id:'e1',name:'x',clips:clips(),previous:doc,graphics:true,planner:fakePlanner(plan()),output});
    expect(again.doc.tracks.graphics.map(x=>x.assetId)).toEqual([g!.assetId]);
  });

  // Graphics planner that lands on the first shot, where the text stage put its callout.
  const onCallout=(seen:any[]=[])=>{const planner=fakePlanner(plan());
    return (async(system:string,input:any,schema:any)=>{if(schema.properties.items?.items.properties.facts){seen.push(input);input={...input,shots:[input.shots[0]]};}return planner(system,input,schema);}) as never;};

  test('a graphic replaces the agent callout it covers',async()=>{
    const inputs:any[]=[];
    const {doc,notes}=await planStoryEdit({id:'e1',name:'x',clips:clips(),graphics:true,planner:onCallout(inputs),output});
    expect(inputs[0].callouts).toEqual([expect.objectContaining({text:'New travel rig'})]);
    expect(inputs[0].textTaken).toEqual([]);
    expect(doc.tracks.graphics).toHaveLength(1);
    expect(doc.tracks.text).toEqual([]);
    expect(notes).toEqual(['1 text callout was replaced by a graphic.']);
    expect(()=>parseEditDoc(doc)).not.toThrow();
  });

  test('locked text keeps its callouts and the graphic gives way',async()=>{
    const first=await planStoryEdit({id:'e1',name:'x',clips:clips(),planner:fakePlanner(plan()),output});
    const locked={...first.doc,policy:{...first.doc.policy,text:'locked' as const}};
    const inputs:any[]=[];
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:clips(),previous:locked,graphics:true,planner:onCallout(inputs),output});
    expect(inputs[0].callouts).toEqual([]);
    expect(inputs[0].textTaken).toHaveLength(1);
    expect(doc.tracks.text.map(t=>t.text)).toEqual(['New travel rig']);
    expect(doc.tracks.graphics).toEqual([]);
  });

  test('a failed graphics plan leaves the rest of the edit and says so',async()=>{
    const planner=fakePlanner(plan());
    const failing=async(system:string,input:any,schema:any)=>planner(system,schema.properties.items?.items.properties.facts?{...input,fail:true}:input,schema);
    const {doc,notes,graphics}=await planStoryEdit({id:'e1',name:'x',clips:clips(),graphics:true,planner:failing as never,output});
    expect(notes).toEqual(['Graphics were skipped this time; the rest of the edit is done.']);
    expect(doc.tracks.graphics).toEqual([]);
    expect(graphics.size).toBe(0);
    expect(doc.tracks.text).toHaveLength(1);
  });

  test('a creator-deleted graphic does not come back',async()=>{
    const {doc}=await planStoryEdit({id:'e1',name:'x',clips:clips(),graphics:true,revision:1,planner:fakePlanner(plan()),output});
    const g=doc.tracks.graphics[0]!;
    const edited=applyCreatorRevision(doc,{patch:{tracks:{graphics:{remove:[g.id]}}} as never}).doc;
    const again=await planStoryEdit({id:'e1',name:'x',clips:clips(),previous:edited,graphics:true,revision:3,planner:fakePlanner(plan()),output});
    expect(again.doc.tracks.graphics).toEqual([]);
    expect(again.graphics.size).toBe(0);
  });
});
