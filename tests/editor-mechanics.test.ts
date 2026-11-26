// Editing mechanics added in EditDoc v4: transitions, J/L cuts, zoom curves,
// picture fades, word fixes, variants. Schema + checks + render plan, and
// small real renders where ffmpeg is on the machine.
import {afterAll,beforeAll,describe,expect,it} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  EDITDOC_VERSION,SETTLE_BACK,checkEditDoc,ease,toFcpxml,zoomAt,zoomKeysBetween,newEditDoc,parseEditDoc,soundSpans,toOtio,transitionJoins,transitionLength,upgradeEditDoc,STYLE_PRESETS,
  type ClipRef,type EditDoc,
} from '@voxtale/editdoc';
import {chunkBounds,keyedExpr,outputFilter,planRender,renderEditDoc,type OutputShape} from '../src/video/render-edit';
import {buildCut,fadeFields,fitSplits,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {clipRefSchema} from '@voxtale/editdoc';

// An agent job: one speaker, words 0.4 s long, 1 s apart.
const speakerRef=clipRefSchema.parse({id:'c1',hash:'e'.repeat(64),name:'c1.mov',kind:'video',role:'a-roll',roleSource:'index',duration:60,width:1920,height:1080,hasAudio:true});
const words='one two three four five six seven eight nine ten eleven twelve'.split(' ').map((text,i)=>({id:i,text,start:2+i,end:2.4+i}));
const speaker:JobClip={ref:speakerRef,words};
const job:Job={id:'j',name:'J',clips:[speaker],style:styleOf(undefined)};

const hasFfmpeg=Bun.spawnSync(['ffmpeg','-version']).exitCode===0;
const fps={num:30,den:1};
const W=426,H=240;
const hash=(c:string)=>c.repeat(64);
const clip=(id:string,c:string,over:Partial<ClipRef>={}):ClipRef=>({
  id,hash:hash(c),name:`${id}.mp4`,kind:'video',role:'a-roll',roleSource:'creator',
  duration:10,fps,hasAudio:true,timecodeStart:0,width:W,height:H,...over,
});
const media={[hash('a')]:'/grey.mp4',[hash('b')]:'/dark.mp4'};

/** Two a-roll pieces joined at 2 s: grey (source 2–4) then dark (source 3–5). */
function doc(aroll:Record<string,unknown>={},over:Record<string,unknown>={}):EditDoc {
  const d=newEditDoc({id:'ed1',name:'Mechanics',clips:[clip('grey','a'),clip('dark','b')],fps,style:STYLE_PRESETS.tutorial});
  return parseEditDoc({
    ...d,canvas:{width:W,height:H},
    tracks:{...d.tracks,'a-roll':[
      {id:'a1',clipId:'grey',in:2,out:4,start:0,end:2,owner:'agent'},
      {id:'a2',clipId:'dark',in:3,out:5,start:2,end:4,owner:'agent',...aroll},
    ]},
    ...over,
  }).doc;
}

describe('EditDoc v4',()=>{
  it('lifts a v3 doc by its number only',()=>{
    const v3={...doc(),version:3};
    const up=upgradeEditDoc(v3) as EditDoc;
    expect(up.version).toBe(EDITDOC_VERSION);
    expect(EDITDOC_VERSION).toBe(6);
    expect(parseEditDoc(v3).doc.tracks['a-roll']).toEqual(doc().tracks['a-roll']);
  });
});

describe('transitions',()=>{
  it('rounds lengths to an even number of frames inside 0.2–1 s',()=>{
    expect(transitionLength(0.4,fps)).toBeCloseTo(0.4,9);
    expect(transitionLength(0.45,fps)*30%2).toBeCloseTo(0,6);
    expect(transitionLength(0.05,fps)).toBeCloseTo(0.2,9);
    expect(transitionLength(3,fps)).toBeCloseTo(1,9);
    const ntsc={num:30000,den:1001};
    const f=transitionLength(1,ntsc)*30000/1001;
    expect(Math.round(f)%2).toBe(0);
    expect(transitionLength(1,ntsc)).toBeLessThanOrEqual(1);
  });
  it('finds a join only where the piece before ends at the start',()=>{
    const d=doc({transition:{kind:'crossfade',duration:0.4}});
    const j=transitionJoins(d.tracks['a-roll'],d.fps);
    expect(j.map(x=>[x.from.id,x.to.id,x.at])).toEqual([['a1','a2',2]]);
    // Ripple keeps it: the field rides on a2, so moving both pieces keeps the middle on the join.
    const moved=d.tracks['a-roll'].map(i=>({...i,start:i.start+1,end:i.end+1}));
    expect(transitionJoins(moved,d.fps)[0]!.at).toBe(3);
  });
  it('refuses odd frame counts, too little source, and warns on a lone piece',()=>{
    expect(()=>doc({transition:{kind:'crossfade',duration:0.3}})).toThrow(/even number of frames/);
    // dark starts at source 0.1: a 0.4 s crossfade needs 0.2 s before it.
    expect(()=>doc({in:0.1,out:2.1,transition:{kind:'crossfade',duration:0.4}})).toThrow(/needs 0.20s of dark before a2/);
    // A dip needs no source past the join.
    expect(()=>doc({in:0.1,out:2.1,transition:{kind:'dip-black',duration:0.4}})).not.toThrow();
    const lone=doc({start:2.5,end:4.5,transition:{kind:'dip-white',duration:0.4}});
    expect(checkEditDoc(lone).some(i=>i.severity==='warning'&&/hard cut/.test(i.message))).toBe(true);
  });
  it('plans a crossfade: the piece before runs on, the piece after starts early and fades in',()=>{
    const p=planRender(doc({transition:{kind:'crossfade',duration:0.4}}),media);
    const [a,b]=p.pictures;
    expect([a!.fs,a!.fe]).toEqual([0,66]);
    expect([b!.fs,b!.fe,b!.start,b!.in]).toEqual([54,120,1.8,2.8]);
    expect(b!.fx).toEqual([{type:'fade',t0:1.8,t1:2.2,dir:'in'}]);
    expect(p.holds).toContainEqual([54,66]);
    // Sound still cuts at the join.
    expect(p.sounds.map(s=>[s.start,s.end])).toEqual([[0,2],[2,4]]);
  });
  it('plans dips, whips and zooms',()=>{
    const dip=planRender(doc({transition:{kind:'dip-white',duration:0.4}}),media).pictures;
    expect(dip[0]!.fx).toEqual([{type:'fade',t0:1.8,t1:2,dir:'out',color:'white'}]);
    expect(dip[1]!.fx).toEqual([{type:'fade',t0:2,t1:2.2,dir:'in',color:'white'}]);
    expect(dip[0]!.fe).toBe(60);
    const whip=planRender(doc({transition:{kind:'whip',duration:0.4}}),media).pictures;
    expect(whip[0]!.fx!.map(x=>x.type)).toEqual(['slide','blur']);
    expect(whip[1]!.fs).toBe(54);
    const zoom=planRender(doc({transition:{kind:'zoom',duration:0.4}}),media).pictures;
    expect(zoom[0]!.fx![0]).toMatchObject({type:'push',from:1,curve:'in'});
    expect(zoom[1]!.fx![0]).toMatchObject({type:'push',to:1,curve:'out'});
  });
  it('set_cut puts a segment\'s transition on its first piece, rounded to even frames',()=>{
    const d=buildCut(job,[{clip:'c1',from:0,to:2},{clip:'c1',from:6,to:8,transition:{kind:'crossfade',seconds:0.45}}]);
    const a=d.tracks['a-roll'];
    expect(a[0]!.transition).toBeUndefined();
    expect(a[1]!.transition?.kind).toBe('crossfade');
    expect(Math.round(a[1]!.transition!.duration*30)%2).toBe(0);
    // A transition on the first segment has no join to sit on: dropped.
    expect(buildCut(job,[{clip:'c1',from:0,to:2,transition:{kind:'dip-black'}}]).tracks['a-roll'][0]!.transition).toBeUndefined();
  });
  it('never splits an effect across render chunks',()=>{
    expect(chunkBounds(120,30)).toEqual([{k:0,c0:0,c1:30},{k:1,c0:30,c1:60},{k:2,c0:60,c1:90},{k:3,c0:90,c1:120}]);
    const c=chunkBounds(120,30,[[54,66]]);
    expect(c.map(x=>x.c1)).toEqual([30,66,96,120]);
    expect(c.every(x=>!(x.c1>54&&x.c1<66))).toBe(true);
  });
  it('exports a transition between the two clips in OTIO, none on the sound',()=>{
    const otio=toOtio(doc({transition:{kind:'crossfade',duration:0.4}}),{clipPath:c=>`/m/${c.name}`}) as any;
    const tracks=otio.tracks.children as {name:string;children:{OTIO_SCHEMA:string;transition_type?:string;in_offset?:{value:number}}[]}[];
    const v=tracks.find(t=>t.name==='A-roll')!.children;
    expect(v.map(c=>c.OTIO_SCHEMA)).toEqual(['Clip.2','Transition.1','Clip.2']);
    expect(v[1]).toMatchObject({transition_type:'SMPTE_Dissolve',in_offset:{value:6},out_offset:{value:6}});
    expect(tracks.find(t=>t.name==='A-roll audio')!.children.map(c=>c.OTIO_SCHEMA)).toEqual(['Clip.2','Clip.2']);
    const whip=toOtio(doc({transition:{kind:'whip',duration:0.4}}),{clipPath:c=>`/m/${c.name}`}) as any;
    expect(whip.tracks.children[0].children[1]).toMatchObject({transition_type:'Custom_Transition',metadata:{voxtale:{kind:'whip'}}});
  });
});

/** The same two pieces with a1 also carrying fields. */
const doc2=(a1:Record<string,unknown>,a2:Record<string,unknown>={})=>{
  const d=doc(a2);
  return parseEditDoc({...d,tracks:{...d.tracks,'a-roll':[{...d.tracks['a-roll'][0]!,...a1},d.tracks['a-roll'][1]!]}}).doc;
};

describe('J/L cuts',()=>{
  it('moves the sound cut, never the picture cut',()=>{
    const j=doc({audioLead:0.5});
    expect(soundSpans(j.tracks['a-roll'],fps).map(s=>[s.item.id,s.start,s.end,s.in])).toEqual([['a1',0,1.5,2],['a2',1.5,4,2.5]]);
    const l=doc2({audioLag:0.5});
    expect(soundSpans(l.tracks['a-roll'],fps).map(s=>[s.start,s.end,s.in])).toEqual([[0,2.5,2],[2.5,4,3.5]]);
    expect(planRender(j,media).sounds.map(s=>[s.start,s.end,s.in])).toEqual([[0,1.5,2],[1.5,4,2.5]]);
    expect(planRender(j,media).pictures.map(p=>[p.fs,p.fe])).toEqual([[0,60],[60,120]]);
  });
  it('checks frames, source, one split per join, and a neighbour to split with',()=>{
    expect(()=>doc({audioLead:0.51})).toThrow(/whole number of frames/);
    expect(()=>doc({in:0.2,out:2.2,audioLead:0.5})).toThrow(/J-cut needs 0.50s of dark before a2/);
    expect(()=>doc2({out:9.9,in:7.9,audioLag:0.5})).toThrow(/L-cut needs 0.50s of grey after a1/);
    expect(()=>doc2({audioLag:0.5},{audioLead:0.5})).toThrow(/use one/);
    expect(()=>doc({audioLead:2})).toThrow(/no sound left/);
    const lone=doc({start:2.5,end:4.5,audioLead:0.5});
    expect(checkEditDoc(lone).some(i=>/does nothing/.test(i.message))).toBe(true);
  });
  it('exports the moved sound in OTIO; the picture keeps its cut',()=>{
    const otio=toOtio(doc({audioLead:0.5}),{clipPath:c=>`/m/${c.name}`}) as any;
    const t=(n:string)=>otio.tracks.children.find((x:any)=>x.name===n).children.filter((c:any)=>c.OTIO_SCHEMA==='Clip.2')
      .map((c:any)=>[c.source_range.start_time.value,c.source_range.duration.value]);
    expect(t('A-roll')).toEqual([[60,60],[90,60]]);
    expect(t('A-roll audio')).toEqual([[60,45],[75,75]]);
  });
  it('set_cut trims a lead or lag to the footage, in whole frames',()=>{
    const d=buildCut(job,[{clip:'c1',from:0,to:2},{clip:'c1',from:6,to:8,audioLead:0.37}]);
    const lead=d.tracks['a-roll'][1]!.audioLead!;
    expect(lead).toBeGreaterThan(0.3);
    expect(Math.abs(lead*30-Math.round(lead*30))).toBeLessThan(1e-6);
    // A lead into the first segment has no join: dropped.
    expect(buildCut(job,[{clip:'c1',from:0,to:2,audioLead:0.5}]).tracks['a-roll'][0]!.audioLead).toBeUndefined();
    const a1={id:'a1',clipId:'c1',in:0.1,out:2,start:0,end:1.9,owner:'agent' as const,status:'applied' as const,gainDb:0};
    const a2={...a1,id:"a2",in:5,out:6,start:1.9,end:2.9,audioLead:2.5};
    expect(fitSplits(job,[a1,{...a2,audioLead:0.05}],fps)[1]!.audioLead).toBeCloseTo(1/30,9);
    // Capped at the piece before, less a frame.
    expect(fitSplits(job,[a1,a2],fps)[1]!.audioLead).toBeCloseTo(1.9-1/30,6);
  });
});

async function ff(args:string[]) {
  const p=Bun.spawn(['ffmpeg','-hide_banner','-loglevel','error','-y',...args],{stderr:'pipe',stdout:'pipe'});
  const out=new Uint8Array(await new Response(p.stdout).arrayBuffer());
  const err=await new Response(p.stderr).text();
  if(await p.exited!==0)throw new Error(err);
  return out;
}
describe('render output shape',()=>{
  it('fits the cut whole by default; cover crops only when asked',()=>{
    const c={width:1280,height:720};
    expect(outputFilter(c,30)).toBeNull();
    expect(outputFilter(c,30,{width:1280,height:720,fps:30})).toBeNull();
    const pillar=outputFilter({width:658,height:480},30,{width:1920,height:1080})!;
    expect(pillar).toContain('force_original_aspect_ratio=decrease');
    expect(pillar).toContain('pad=1920:1080');
    expect(pillar).not.toContain('crop');
    expect(outputFilter(c,30,{width:1080,height:1920,fit:'cover'})).toContain('crop=1080:1920');
    expect(outputFilter(c,30,{fps:24})).toBe('fps=24');
    expect(()=>outputFilter(c,30,{width:1921,height:1080})).toThrow(/even/);
  });
});

/** Evaluates a keyedExpr ffmpeg expression in JS at u. */
function evalExpr(expr:string,u:number):number {
  const js=expr.replace(/\bif\(/g,'iff(');
  return new Function('u','iff','lt','gte','pow',`return ${js};`)(u,(c:number,a:number,b:number)=>c?a:b,(a:number,b:number)=>+(a<b),(a:number,b:number)=>+(a>=b),Math.pow);
}

describe('zoom curves',()=>{
  const z={start:0,end:3,scale:2,x:0.5,y:0.5,easeIn:1,easeOut:1,status:'applied' as const};
  it('each curve runs 0 to 1 with its own shape',()=>{
    for(const c of ['linear','ease-in-out','snap','build','settle'] as const){
      expect(ease(c,0)).toBeCloseTo(0,9);expect(ease(c,1)).toBeCloseTo(1,9);
    }
    expect(ease('snap',0.5)).toBeCloseTo(0.875,9);   // fast start
    expect(ease('build',0.5)).toBeCloseTo(0.125,9);  // slow start
    expect(ease('hold',0.99)).toBe(0);
    const peak=Math.max(...Array.from({length:101},(_,i)=>ease('settle',i/100)));
    expect(peak).toBeGreaterThan(1.03);expect(peak).toBeLessThan(1.08); // a small overshoot, then rest
    expect(SETTLE_BACK).toBe(1.2);
  });
  it('ffmpeg expressions match ease() for every curve',()=>{
    for(const c of ['linear','ease-in-out','snap','build','settle'] as const){
      const e=keyedExpr([{time:1,value:1,easing:c},{time:3,value:2}],'u');
      for(const t of [1,1.3,2,2.6,2.99])expect(evalExpr(e,t)).toBeCloseTo(1+ease(c,(t-1)/2),6);
    }
    const h=keyedExpr([{time:1,value:1,easing:'hold'},{time:3,value:2}],'u');
    expect(evalExpr(h,2.9)).toBe(1);expect(evalExpr(h,3)).toBe(2);
  });
  it('curves shape the move in time order, in and out',()=>{
    // No curve: the old smooth ease both ways.
    expect(zoomAt([z],0.25).scale).toBeCloseTo(1+ease('ease-in-out',0.25),9);
    expect(zoomAt([z],2.75).scale).toBeCloseTo(2-ease('ease-in-out',0.75),9);
    // snap out: leaves the zoom fast; build in: starts slow.
    expect(zoomAt([{...z,curveOut:'snap'}],2.25).scale).toBeCloseTo(2-ease('snap',0.25),9);
    expect(zoomAt([{...z,curveIn:'build'}],0.5).scale).toBeCloseTo(1.125,9);
    // hold: stays wide until the ease ends, then jumps.
    expect(zoomAt([{...z,curveIn:'hold'}],0.9).scale).toBe(1);
    expect(zoomAt([{...z,curveIn:'hold'}],1).scale).toBe(2);
  });
  it('keys carry the curve of the move they start',()=>{
    const keys=zoomKeysBetween([{...z,curveIn:'settle',curveOut:'snap'}],0,3,{width:W,height:H}).filter(k=>k.property==='scale');
    expect(keys.find(k=>k.time===0)!.easing).toBe('settle');
    expect(keys.find(k=>k.time===2)!.easing).toBe('snap');
  });
  it('FCPXML takes the nearest interp, and a hold gets a key a frame before the move',()=>{
    const d=doc({},{});
    const withZoom=(curveIn:string)=>parseEditDoc({...d,tracks:{...d.tracks,zoom:[{id:'z1',start:0,end:1.5,scale:1.5,easeIn:0.5,easeOut:0.5,curveIn,owner:'agent',status:'applied'}]}}).doc;
    const clipPath=(c:ClipRef)=>`/footage/${c.name}`;
    const interps=(x:string)=>[...x.matchAll(/interp="(\w+)"/g)].map(m=>m[1]);
    expect(interps(toFcpxml(withZoom('snap'),{clipPath}))).toContain('easeOut');
    expect(interps(toFcpxml(withZoom('build'),{clipPath}))).toContain('easeIn');
    const smooth=toFcpxml(withZoom('smooth'),{clipPath}),hold=toFcpxml(withZoom('hold'),{clipPath});
    expect(interps(smooth)).toContain('ease');
    expect(interps(hold).length).toBeGreaterThan(interps(smooth).length);
  });
  it('set_zooms curves land on the zoom over that line; a punch gets ease time',()=>{
    const d=buildCut(job,[{clip:'c1',from:0,to:5}],{zooms:[{clip:'c1',from:2,to:3,why:'stress',curveIn:'snap',curveOut:'settle'}]});
    const zs=d.tracks.zoom.filter(x=>x.curveIn||x.curveOut);
    expect(zs.length).toBe(1);
    expect(zs[0]).toMatchObject({curveIn:'snap',curveOut:'settle'});
    expect(zs[0]!.easeIn).toBeGreaterThan(0);
    expect(zs[0]!.easeOut).toBeGreaterThan(0);
  });
});

describe('picture fades',()=>{
  const faded=(a1:Record<string,unknown>)=>{const d=doc();return parseEditDoc({...d,tracks:{...d.tracks,'a-roll':[{...d.tracks['a-roll'][0]!,...a1},d.tracks['a-roll'][1]!]}}).doc;};
  it('fit inside their item',()=>{
    expect(checkEditDoc(faded({fadeIn:1,fadeOut:0.5})).some(i=>i.severity==='error')).toBe(false);
    const bad=faded({fadeIn:1,fadeOut:0.5});
    Object.assign(bad.tracks['a-roll'][0]!,{fadeIn:1.5,fadeOut:1});
    expect(checkEditDoc(bad).some(i=>i.severity==='error'&&/fadeIn \+ fadeOut/.test(i.message))).toBe(true);
  });
  it('tool lengths shrink in step to fit',()=>{
    expect(fadeFields({in:2,out:2},2)).toEqual({fadeIn:1,fadeOut:1});
    expect(fadeFields({in:0.5},2)).toEqual({fadeIn:0.5});
    expect(fadeFields(undefined,2)).toEqual({});
  });
  it('render: pictures fade to see-through; text gets an ASS fade',()=>{
    const d=faded({fadeIn:1});
    const withText=parseEditDoc({...d,tracks:{...d.tracks,text:[{id:'t1',start:0.5,end:2.5,owner:'agent',template:'callout',text:'Hi',fadeIn:0.3,fadeOut:0.25}]}}).doc;
    const p=planRender(withText,media);
    expect(p.pictures.find(x=>x.itemId==='a1')!.fx).toEqual([{type:'fade',t0:0,t1:1,dir:'in'}]);
    expect(p.ass).toContain('\\fad(300,250)');
  });
  it('OTIO carries them in metadata',()=>{
    const otio=toOtio(faded({fadeOut:0.5}),{clipPath:c=>`/m/${c.name}`}) as any;
    expect(otio.tracks.children[0].children[0].metadata.voxtale.fadeOut).toBe(0.5);
  });
  it('set_cut fades land on the first and last piece of a segment',()=>{
    const d=buildCut(job,[{clip:'c1',from:0,to:2,fade:{in:0.5}},{clip:'c1',from:5,to:7,fade:{out:9}}]);
    const a=d.tracks['a-roll'];
    expect(a[0]!.fadeIn).toBe(0.5);
    expect(a.at(-1)!.fadeOut).toBeCloseTo(a.at(-1)!.end-a.at(-1)!.start,6);
    expect(checkEditDoc(d).filter(i=>i.severity==='error')).toEqual([]);
  });
});

const frame=(file:string,n:number)=>ff(['-i',file,'-vf',`select=eq(n\\,${n}),format=gray`,'-frames:v','1','-f','rawvideo','-']);
const mean=(b:Uint8Array)=>b.reduce((s,x)=>s+x,0)/b.length;

describe.skipIf(!hasFfmpeg)('rendered mechanics',()=>{
  let dir='';
  const files:Record<string,string>={};
  beforeAll(async()=>{
    dir=await mkdtemp(join(tmpdir(),'vt-mech-'));
    files[hash('a')]=join(dir,'grey.mp4');
    files[hash('b')]=join(dir,'dark.mp4');
    await ff(['-f','lavfi','-i',`color=c=0xC8C8C8:s=${W}x${H}:r=30:d=10`,'-f','lavfi','-i','sine=f=440:r=48000:d=10','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',files[hash('a')]!]);
    await ff(['-f','lavfi','-i',`color=c=0x101010:s=${W}x${H}:r=30:d=10`,'-f','lavfi','-i','anullsrc=r=48000:cl=mono:d=10','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',files[hash('b')]!]);
  },60_000);
  afterAll(async()=>{await rm(dir,{recursive:true,force:true});});
  const render=async(d:EditDoc,name:string,output?:OutputShape)=>{
    const out=join(dir,`${name}.mp4`);
    // 1 s chunks: the 54–66 transition window would straddle the boundary at 60 without holds.
    await renderEditDoc({doc:d,media:files,out,work:join(dir,`w-${name}`),chunkSeconds:1,...(output?{output}:{})});
    return out;
  };

  it('crossfades through the middle of the join',async()=>{
    const out=await render(doc({transition:{kind:'crossfade',duration:0.4}}),'xfade');
    const before=mean(await frame(out,50)),mid=mean(await frame(out,60)),after=mean(await frame(out,70));
    expect(before).toBeGreaterThan(190);
    expect(after).toBeLessThan(25);
    expect(mid).toBeGreaterThan(80);
    expect(mid).toBeLessThan(130);
  },60_000);
  it('dips to white on the join',async()=>{
    const out=await render(doc({transition:{kind:'dip-white',duration:0.4}}),'dip');
    expect(mean(await frame(out,59))).toBeGreaterThan(235);
    expect(mean(await frame(out,60))).toBeGreaterThan(235);
    expect(mean(await frame(out,70))).toBeLessThan(25);
  },60_000);
  it('J-cut: the next voice comes in under the picture before',async()=>{
    // grey sounds a tone, dark is silent: the lead stops the tone 0.5 s before the picture cut.
    const level=async(out:string,t:number)=>{
      const p=Bun.spawn(['ffmpeg','-hide_banner','-ss',String(t),'-t','0.3','-i',out,'-af','volumedetect','-f','null','-'],{stderr:'pipe'});
      const e=await new Response(p.stderr).text();await p.exited;
      return Number(/mean_volume: (-?[\d.]+)/.exec(e)?.[1]??-99);
    };
    const hard=await render(doc(),'hard'),j=await render(doc({audioLead:0.5}),'jcut');
    expect(await level(hard,1.6)).toBeGreaterThan(-30);
    expect(await level(j,1.6)).toBeLessThan(-60);
    expect(mean(await frame(j,55))).toBeGreaterThan(190);
  },60_000);
  it('whips: the picture before slides out sideways',async()=>{
    const out=await render(doc({transition:{kind:'whip',duration:0.4}}),'whip');
    const f=await frame(out,60);
    // Mid-whip both pictures share the frame: left part grey, right part dark.
    const col=(x:number)=>{let s=0;for(let y=0;y<H;y++)s+=f[y*W+x]!;return s/H;};
    expect(col(10)).toBeGreaterThan(150);
    expect(col(W-10)).toBeLessThan(60);
  },60_000);
  it('delivers the size and rate asked for, letterboxed, never cropped',async()=>{
    // 426x240 cut into a square 480x480 at 25 fps: grey band in the middle, black above and below.
    const out=await render(doc(),'square',{width:480,height:480,fps:25});
    const p=Bun.spawnSync(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height,r_frame_rate','-of','csv=p=0',out]);
    expect(p.stdout.toString().trim()).toBe('480,480,25/1');
    const f=await ff(['-i',out,'-vf','select=eq(n\\,10),format=gray','-frames:v','1','-f','rawvideo','-']);
    const row=(y:number)=>{let s=0;for(let x=0;x<480;x++)s+=f[y*480+x]!;return s/480;};
    expect(row(20)).toBeLessThan(20);
    expect(row(240)).toBeGreaterThan(180);
    expect(row(460)).toBeLessThan(20);
  },60_000);
  it('fades the opening in from black',async()=>{
    const d=doc();
    const out=await render(parseEditDoc({...d,tracks:{...d.tracks,'a-roll':[{...d.tracks['a-roll'][0]!,fadeIn:1},d.tracks['a-roll'][1]!]}}).doc,'fadein');
    expect(mean(await frame(out,0))).toBeLessThan(20);
    const mid=mean(await frame(out,15));
    expect(mid).toBeGreaterThan(70);
    expect(mid).toBeLessThan(140);
    expect(mean(await frame(out,45))).toBeGreaterThan(190);
  },60_000);
});
