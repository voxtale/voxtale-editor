// Style folders, measured targets, brand kit and the style-scoped rule loop. No network, no Python.
import {afterAll,describe,expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderGraphic} from '@voxtale/frames';
import {styleOf,type Job} from '../src/video/editor/agent/cut';
import {mcpHandler} from '../src/video/editor/agent/mcp-protocol';
import {taskPrompt} from '../src/video/editor/agent/plan';
import {localEditorServer} from '../src/video/editor/local-mcp/server';
import {STYLE_SKILL_TEXT} from '../src/video/editor/styles/agent-text';
import {brandCss,brandKit,graphicsBrand} from '../src/video/editor/styles/brand';
import {addFile,addLearned,createStyle,dropLearned,learnedRules,listStyles,readStyle,rulesBody,slugOf,withMeasuredSection} from '../src/video/editor/styles/folder';
import {learnStyle,sidecarWords} from '../src/video/editor/styles/learn';
import {decideStyleRule,loadProposals,migrateGlobalRules,proposeStyleRule} from '../src/video/editor/styles/style-rules';
import {cutsOnBeat,reportMarkdown,summaryOf,targetsOf,withTargets,type Report} from '../src/video/editor/styles/targets';
import {useStyle} from '../src/video/editor/styles/use';

const dirs:string[]=[];
const tmp=async(p='style-')=>{const d=await mkdtemp(join(tmpdir(),p));dirs.push(d);return d;};
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});

const report=(over:Partial<Report>={}):Report=>({video:'a.mp4',duration_s:600,minutes_analysed:10,
  speech:{words:1500,words_per_min:150,pause_after_sentence_s:{median:0.4},hesitations_per_min:0.5},
  shots:{cuts_per_min:12,shot_s:{median:3,max:14},first_cut_s:1.2,zoom_in_per_min:2,zoom_out_per_min:1,zoom_scale_median:1.3,flashes_per_min:0.2,same_framing_per_min:4,still_shots_per_min:1},
  captions_on_image:{lead_s:-0.05,words_per_change:3},look:{brightness:0.45,contrast:0.7,saturation:0.3,warmth:0.04},
  sound:{lufs:-14,bed_under_voice_db:-22,sound_events_per_min:3},...over});

const job=(o:Partial<Job>={}):Job=>({id:'edit',name:'t',style:styleOf(undefined),
  clips:[{ref:{id:'c1',name:'talk.mp4',duration:60,width:1920,height:1080,role:'a-roll',kind:'video',hash:'h1'} as Job['clips'][number]['ref'],words:[]}],...o});

describe('style folder',()=>{
  test('create, read, list; slugs are plain',async()=>{
    const root=await tmp();
    const s=await createStyle(root,{name:'Fast Shorts!',description:'Punchy vertical',base:'fast-paced'});
    expect(s.slug).toBe('fast-shorts');
    expect(slugOf('Été  calme')).toBe('ete-calme');
    for(const f of ['style.json','rules.md','animations.json','brand','references','animations'])expect(existsSync(join(s.dir,f))).toBe(true);
    expect((await readStyle(root,'Fast Shorts!'))?.info.base).toBe('fast-paced');
    expect((await listStyles(root)).map(x=>x.slug)).toEqual(['fast-shorts']);
    await expect(createStyle(root,{name:'fast shorts'})).rejects.toThrow('already exists');
  });
  test('learned rules: add, read, retire; hand-written bullets count; body leaves them out',()=>{
    let md='# S\n\nCut tight.\n\n## Learned rules\n- Logo top right\n';
    md=addLearned(md,{id:'r1',text:'No music in the intro',said:'from now on (no) music'},'2026-11-26');
    const rs=learnedRules(md);
    expect(rs.map(r=>r.text)).toEqual(['Logo top right','No music in the intro']);
    expect(rs[0]!.id).toMatch(/^line-/);
    expect(rs[1]!.id).toBe('r1');
    expect(md).toContain('_(added 2026-11-26, from "from now on no music")_ <!-- rule:r1 -->');
    expect(rulesBody(md)).toBe('# S\n\nCut tight.');
    expect(learnedRules(dropLearned(md,'r1')).map(r=>r.id)).toEqual([rs[0]!.id]);
    expect(()=>dropLearned(md,'nope')).toThrow();
  });
  test('the measured section sits before the learned rules and is replaced, not repeated',()=>{
    const md='# S\n\nMine.\n\n## Learned rules\n- Keep it\n';
    const once=withMeasuredSection(md,'long',['- cuts_per_min: 10–12']);
    const twice=withMeasuredSection(once,'long',['- cuts_per_min: 20']);
    expect(twice.match(/## Measured from references — long/g)).toHaveLength(1);
    expect(twice).toContain('- cuts_per_min: 20');
    expect(twice).not.toContain('10–12');
    expect(twice.indexOf('## Measured')).toBeLessThan(twice.indexOf('## Learned rules'));
    expect(learnedRules(twice).map(r=>r.text)).toEqual(['Keep it']);
  });
  test('brand files land in brand/ and style.json; wrong kinds are refused',async()=>{
    const root=await tmp(),src=await tmp('src-');
    await writeFile(join(src,'logo.png'),'png');await writeFile(join(src,'Head.otf'),'otf');
    let s=await createStyle(root,{name:'b'});
    s=(await addFile(s,join(src,'logo.png'),'logo')).style;
    s=(await addFile(s,join(src,'Head.otf'),'heading_font')).style;
    expect(s.info.brand).toEqual({logo:'logo.png',fonts:{heading:'Head.otf'}});
    expect(existsSync(join(s.dir,'brand','Head.otf'))).toBe(true);
    await expect(addFile(s,join(src,'Head.otf'),'logo')).rejects.toThrow();
  });
});

describe('measured targets',()=>{
  test('one video: ±15%, said so; two: their range',()=>{
    const one=targetsOf([report()]);
    expect(one.cuts_per_min).toEqual([10,14]);
    expect(one.zooms_per_min).toEqual([2.55,3.45]);
    expect(summaryOf(one,1)[0]).toContain('seen in one video');
    const two=targetsOf([report(),report({video:'b.mp4',shots:{cuts_per_min:20,shot_s:{median:2}},speech:{words:0}})]);
    expect(two.cuts_per_min).toEqual([12,20]);
    expect(two.words_per_min).toEqual([128,173]);  // the second has no transcript: one value, rounded
  });
  test('targets set pace, zooms and loudness, inside the schema',()=>{
    const s=withTargets(styleOf(undefined),targetsOf([report(),report({video:'b',shots:{cuts_per_min:200},sound:{lufs:-40}})]));
    expect(s.pace.targetCutsPerMinute).toBe(106);
    expect(s.pace.zoomFrequency).toBe('high');  // 3 zooms/min
    expect(s.audio.loudnessLufs).toBeGreaterThanOrEqual(-30);
    expect(s.pace.minShotSeconds).toBe(1.3);
    expect(s.audio.sfx).toBe('punchy');
  });
  test('cuts on beat needs a firm beat',()=>{
    expect(cutsOnBeat([1,1.5,2.05,2.7],{bpm:120,first:0,confidence:0.9})).toBe(0.75);
    expect(cutsOnBeat([1,2],{bpm:120,first:0,confidence:0.2})).toBeUndefined();
    expect(cutsOnBeat([],{bpm:120,first:0})).toBeUndefined();
  });
  test('report table: one column per video',()=>{
    const md=reportMarkdown('long',[report(),report({video:'b|c.mp4'})],targetsOf([report()]));
    expect(md).toContain('| Measure | a.mp4 | b/c.mp4 |');
    expect(md).toContain('| Cuts / min | 12 | 12 |');
  });
});

describe('brand kit',()=>{
  test('CSS puts fonts, accent and a logo class on the kit; bad colours are dropped',()=>{
    const css=brandCss({colors:{accent:'#ff0066',primary:'red'},fonts:{heading:'My Font.otf'},logo:'logo.png'});
    expect(css).toContain("src:url('./brand/My%20Font.otf') format('opentype')");
    expect(css).toContain('--accent:#ff0066');
    expect(css).not.toContain('red');
    expect(css).toContain('.logo{');
    expect(brandKit({colors:{accent:'#ff0066',text:'nope'},fonts:{body:'x.ttf'}})).toEqual({colors:{accent:'#ff0066'},fonts:{body:'BrandBody'}});
  });
  test('graphics get the brand files; renderGraphic copies them next to the composition',async()=>{
    const root=await tmp(),src=await tmp('src-');
    await writeFile(join(src,'logo.svg'),'<svg/>');
    let s=await createStyle(root,{name:'g'});
    s=(await addFile(s,join(src,'logo.svg'),'logo')).style;
    s=(await readStyle(root,'g'))!;
    s.info.brand={...s.info.brand,fonts:{body:'gone.ttf'}};
    const g=graphicsBrand(s)!;
    expect(g.files.map(f=>f.name)).toEqual(['logo.svg']);  // the missing font is left out
    expect(g.css).not.toContain('BrandBody');
    const out=await tmp('render-');
    const r=await renderGraphic(out,{id:'g1',html:'<div/>',kitCss:'',width:64,height:36,seconds:1,stills:[0.5],backdrop:{clip:'h',t:0},files:g.files},'',async o=>{
      expect(await readFile(join(o.dir,'brand','logo.svg'),'utf8')).toBe('<svg/>');
      return {ok:false,report:'stopped'};
    });
    expect(r.ok).toBe(false);
  });
});

describe('style rules',()=>{
  test('propose, accept, edit, refuse, retire',async()=>{
    const root=await tmp();
    await createStyle(root,{name:'s'});
    const a=await proposeStyleRule(root,'s',{text:'Logo in the top right',said:'always logo top right'});
    expect(a.fresh).toBe(true);
    expect((await proposeStyleRule(root,'s',{text:'logo in the top right!',said:'x'})).note).toBe('already proposed');
    await decideStyleRule(root,a.rule.id,'accept');
    expect(learnedRules((await readStyle(root,'s'))!.rules).map(r=>r.text)).toEqual(['Logo in the top right']);
    expect((await proposeStyleRule(root,'s',{text:'Logo in the top right',said:''})).note).toBe('already in rules.md');
    await expect(decideStyleRule(root,a.rule.id,'accept')).rejects.toThrow('already accepted');

    const b=await proposeStyleRule(root,'s',{text:'No music under the intro',said:'from now on'});
    await expect(decideStyleRule(root,b.rule.id,'edit')).rejects.toThrow('wording');
    expect((await decideStyleRule(root,b.rule.id,'edit',{text:'No music in the first 10 s'})).text).toBe('No music in the first 10 s');

    const c=await proposeStyleRule(root,'s',{text:'Always add a whoosh',said:'always whoosh'});
    await decideStyleRule(root,c.rule.id,'refuse');
    expect((await proposeStyleRule(root,'s',{text:'always add a whoosh',said:''})).note).toContain('refused');

    await decideStyleRule(root,a.rule.id,'retire');
    expect(learnedRules((await readStyle(root,'s'))!.rules).map(r=>r.text)).toEqual(['No music in the first 10 s']);
    // A rule the creator wrote by hand: retired by its line id, with the style.
    const s=(await readStyle(root,'s'))!;
    await writeFile(join(s.dir,'rules.md'),s.rules.replace('## Learned rules\n','## Learned rules\n- Hand rule\n'));
    const hand=learnedRules((await readStyle(root,'s'))!.rules).find(r=>r.text==='Hand rule')!;
    await expect(decideStyleRule(root,hand.id,'retire')).rejects.toThrow('style');
    await decideStyleRule(root,hand.id,'retire',{style:'s'});
    expect(learnedRules((await readStyle(root,'s'))!.rules).map(r=>r.text)).toEqual(['No music in the first 10 s']);
  });
  test('the old global rules file moves in once',async()=>{
    const root=await tmp(),old=join(await tmp('old-'),'rules.json');
    await writeFile(old,JSON.stringify([{id:'r1',text:'Yellow captions',said:'',status:'accepted',proposedAt:1,decidedAt:1},{id:'r2',text:'Logo top right',said:'',status:'proposed',proposedAt:2}]));
    expect(await migrateGlobalRules(root,old)).toBe(2);
    expect(await migrateGlobalRules(root,old)).toBe(0);
    expect(learnedRules((await readStyle(root,'my-style'))!.rules).map(r=>r.text)).toEqual(['Yellow captions']);
    expect((await loadProposals(root)).filter(r=>r.status==='proposed').map(r=>r.id)).toEqual(['r2']);
  });
});

describe('learn and use a style',()=>{
  test('learn_style folds the analyser\'s reports into the style; use_style brings them to the brief',async()=>{
    const root=await tmp(),refs=await tmp('refs-');
    await writeFile(join(refs,'one.mp4'),'');await writeFile(join(refs,'two.mov'),'');await writeFile(join(refs,'notes.txt'),'');
    await writeFile(join(refs,'one.words.json'),JSON.stringify({words:[{text:'hi.',start:0,end:0.3},{bad:1}]}));
    expect(await sidecarWords(join(refs,'one.mp4'))).toEqual([{text:'hi.',start:0,end:0.3}]);
    await createStyle(root,{name:'Ref Style',base:'fast-paced'});
    const seen:string[]=[];
    const r=await learnStyle(root,'ref-style',{videos:[refs],usage:'long',
      analyse:async q=>{seen.push(`${q.video.split('/').pop()}:${q.words?.length??0}`);return {report:report({video:q.video.split('/').pop()!}),cut_times:[1,1.5,2]};},
      beats:async()=>({bpm:120,first:0,confidence:0.9})});
    expect(seen).toEqual(['one.mp4:1','two.mov:0']);
    expect(r.targets.cuts_per_min).toEqual([12,12]);
    expect(r.style.info.measured?.long?.targets.cuts_on_beat).toEqual([1,1]);
    expect(await readFile(r.report,'utf8')).toContain('| Measure | one.mp4 | two.mov |');
    expect(r.style.rules).toContain('## Measured from references — long');

    const {style,use}=await useStyle(root,'Ref Style');
    expect(style.id).toBe('ref-style');
    expect(style.pace.targetCutsPerMinute).toBe(12);
    expect(use.usage).toBe('long');
    await expect(useStyle(root,'ref-style','short')).rejects.toThrow('no measured "short"');
    const brief=taskPrompt(job({style,styleUse:use,rules:['Logo top right']}),false);
    expect(brief).toContain('Edit style "Ref Style"');
    expect(brief).toContain('--- rules.md ---');
    expect(brief).toContain('Measured on 2 reference(s) (long)');
    expect(brief).toContain('- Logo top right');
  });
  test('local MCP: create a style, set its brand, propose a rule to it, the creator rewords it',async()=>{
    const dir=await tmp('mcp-'),styles=join(dir,'styles');
    const answer=mcpHandler(localEditorServer({folder:dir,graphics:false,rulesFile:join(dir,'none.json'),stylesDir:styles,vision:null},()=>()=>{}));
    const req=async(name:string,args:object)=>(await answer({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}) as any).result;
    expect((await req('create_style',{name:'Talks',base:'podcast'})).content[0].text).toContain('Created talks');
    expect((await req('set_brand',{style:'talks',colors:{accent:'#22cc88'},captions:'white, bold, two words'})).content[0].text).toContain('#22cc88');
    expect((await req('styles',{})).content[0].text).toContain('- talks: Talks');
    const p=(await req('propose_rule',{rule:'Open on the strongest line',said:'always start with the best bit',style:'talks'})).content[0].text as string;
    expect(p).toContain('keep it, change the wording, or drop it');
    const id=/id ([\w-]+)\)/.exec(p)![1]!;
    expect((await req('rules',{})).content[0].text).toContain('[proposed] Open on the strongest line');
    expect((await req('decide_rule',{id,decision:'edit',text:'Open on the strongest line of the video'})).content[0].text).toContain('[accepted]');
    expect((await req('style',{name:'talks'})).content[0].text).toContain('- Open on the strongest line of the video _(added');
    expect((await req('use_style',{name:'talks'})).isError).toBe(true);  // no edit open
  });
  test('the skill text for the coordinator names every style tool',()=>{
    for(const t of ['styles','use_style','learn_style','create_style','add_style_file','propose_rule','decide_rule'])expect(STYLE_SKILL_TEXT).toContain(t);
  });
});
