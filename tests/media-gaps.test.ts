// Multicam sync groups, log/HDR conversion and .cube input: pure parts, no ffmpeg.
import {describe,expect,it} from 'bun:test';
import {
  activeMember,checkEditDoc,clipLut,converter,decode,groupFromStarts,newEditDoc,parseCube,parseEditDoc,sampleCube,syncTime,upgradeEditDoc,writeCube,
  EDITDOC_VERSION,STYLE_PRESETS,type ClipRef,type EditDoc,type RGB,
} from '@voxtale/editdoc';
import {planRender,splitBoxes,subjectSpans} from '../src/video/render-edit';

const fps={num:30,den:1};
const hash=(c:string)=>c.repeat(64);
const clip=(id:string,c:string,over:Partial<ClipRef>={}):ClipRef=>({
  id,hash:hash(c),name:`${id}.mp4`,kind:'video',role:'a-roll',roleSource:'creator',
  duration:10,fps,hasAudio:true,timecodeStart:0,width:1920,height:1080,...over,
} as ClipRef);
const media={[hash('a')]:'/wide',[hash('b')]:'/close',[hash('c')]:'/lav'};

// cam "wide" starts 1 s into the group, "close" at 0, the lav at 3.
function doc(item:Record<string,unknown>,canvas={width:1920,height:1080}):EditDoc {
  const d=newEditDoc({id:'m1',name:'Multicam',clips:[clip('wide','a'),clip('close','b'),clip('lav','c',{kind:'audio',role:'mic'})],fps,style:STYLE_PRESETS.tutorial});
  return parseEditDoc({
    ...d,canvas,
    groups:[{id:'g1',via:'sound',members:[{clipId:'wide',start:1},{clipId:'close',start:0},{clipId:'lav',start:3}]}],
    tracks:{...d.tracks,'a-roll':[{id:'a1',clipId:'wide',in:4,out:6,start:0,end:2,owner:'agent',...item}]},
  }).doc;
}

describe('sync groups',()=>{
  it('reads one moment in each member',()=>{
    const g=doc({}).groups;
    expect(syncTime(g,'wide',4,'close')).toBe(5);
    expect(syncTime(g,'wide',4,'lav')).toBe(2);
    expect(syncTime(g,'wide',4,'nope')).toBeUndefined();
  });
  it('puts the earliest file at 0 and drops doubtful matches',()=>{
    const g=groupFromStarts('g',[{clipId:'a',start:2.5},{clipId:'b',start:4,confidence:20},{clipId:'c',start:1,confidence:3}]);
    expect(g!.members.map(m=>[m.clipId,m.start])).toEqual([['a',0],['b',1.5]]);
    expect(groupFromStarts('g',[{clipId:'a',start:0},{clipId:'b',start:1,confidence:2}])).toBeNull();
  });
  it('picks the member loudest over its own median, not the hottest',()=>{
    const g=doc({}).groups[0]!;
    // close is hot everywhere; the lav rises 12 dB over 3..4 s of the group.
    const levels={close:Array(100).fill(-10),lav:Array.from({length:100},(_,i)=>i<5?-30:-42)};
    expect(activeMember(g,levels,0.1,3,3.5)).toBe('lav');
    expect(activeMember(g,levels,0.1,5,6)).toBe('close');
  });
  it('flags an angle outside the group',()=>{
    const d=doc({angle:'close'});
    expect(checkEditDoc(d).filter(i=>i.severity==='error')).toEqual([]);
    const bad:EditDoc={...d,groups:[]};
    expect(checkEditDoc(bad).some(i=>i.path==='tracks.a-roll.0.angle'&&i.severity==='error')).toBe(true);
  });
  it('lifts a v5 doc to v6 with no groups',()=>{
    const {groups:_,...old}={...doc({}),version:5};
    const up=upgradeEditDoc(old) as EditDoc;
    expect(up.version).toBe(EDITDOC_VERSION);
    expect(parseEditDoc(up).doc.groups).toEqual([]);
  });
});

describe('planRender multicam',()=>{
  it('shows the angle and plays the mic in step with the master',()=>{
    const p=planRender(doc({angle:'close',mic:'lav'}),media);
    expect(p.pictures.map(x=>[x.path,x.in])).toEqual([['/close',5]]);
    expect(p.sounds.map(s=>[s.path,s.in])).toEqual([['/lav',2]]);
    expect(p.skipped).toEqual([]);
  });
  it('falls back to the master when the angle does not cover the piece',()=>{
    const p=planRender(doc({in:0,out:0.5,end:0.5,angle:'lav',mic:'lav'}),media);
    expect(p.pictures[0]!.path).toBe('/wide');
    expect(p.skipped.map(s=>s.reason).sort()).toEqual(['angle-out-of-range','mic-out-of-range']);
  });
  it('splits side by side, or top and bottom on a tall canvas',()=>{
    const p=planRender(doc({layout:'split',companions:[{clipId:'close',offset:0}]}),media);
    expect(p.pictures.map(x=>[x.path,x.in,x.box?.x,x.box?.width])).toEqual([['/wide',4,0,960],['/close',5,960,960]]);
    expect(splitBoxes({width:1080,height:1920}).map(b=>[b.y,b.height])).toEqual([[0,960],[960,960]]);
  });
  it('puts the companion in the pip corner',()=>{
    const p=planRender(doc({layout:'pip',pipCorner:'top-left',companions:[{clipId:'close',offset:0}]}),media);
    expect(p.pictures[1]!.box!.x).toBeLessThan(400);
    expect(p.pictures[1]!.box!.y).toBeLessThan(400);
  });
  it('moves the sound by the clip avOffset',()=>{
    const d=doc({});
    const later=parseEditDoc({...d,clips:d.clips.map(c=>c.id==='wide'?{...c,avOffset:0.1}:c)}).doc;
    expect(planRender(later,media).sounds[0]!.in).toBeCloseTo(3.9,6);
    const early=parseEditDoc({...d,clips:d.clips.map(c=>c.id==='wide'?{...c,avOffset:-0.2}:c)}).doc;
    expect(planRender(early,media).sounds[0]!.in).toBeCloseTo(4.2,6);
  });
});

describe('log and HDR',()=>{
  it('decodes 18% grey from the makers\' code values',()=>{
    expect(decode('Sony S-Log3/S-Gamut3.Cine',420/1023)).toBeCloseTo(0.18,3);
    expect(decode('hlg',(0.75*876+64)/1023)).toBeCloseTo(0.9,3);
    expect(decode('pq',(0.58*876+64)/1023)).toBeGreaterThan(0.8);
  });
  it('keeps grey grey and lifts log mid grey to a normal picture',()=>{
    const f=converter('Sony S-Log3/S-Gamut3.Cine')!;
    const c:RGB=[(420-64)/876,(420-64)/876,(420-64)/876];
    f(c);
    expect(Math.abs(c[0]-c[1])+Math.abs(c[1]-c[2])).toBeLessThan(1e-3);
    expect(c[0]).toBeGreaterThan(0.35);
    expect(c[0]).toBeLessThan(0.5);
  });
  it('builds no LUT for a plain Rec.709 clip, one for a log clip',()=>{
    expect(clipLut(clip('x','a'))).toBeNull();
    expect(clipLut(clip('x','a',{color:{log:'Sony S-Log3/S-Gamut3.Cine'}}),null,5)!.length).toBe(5**3*3);
    expect(clipLut(clip('x','a',{color:{log:'Sony S-Log3/S-Gamut3.Cine'},colorSpace:'Rec.709'}))).toBeNull();
  });
  it('reads a .cube back and samples it between points',()=>{
    const id=new Float32Array(2**3*3);
    let k=0;
    for(let b=0;b<2;b++)for(let g=0;g<2;g++)for(let r=0;r<2;r++){id[k++]=r;id[k++]=g;id[k++]=b;}
    const cube=parseCube(writeCube(id,2,'id'));
    expect(sampleCube(cube,[0.25,0.5,0.75]).map(v=>+v.toFixed(4))).toEqual([0.25,0.5,0.75]);
    expect(()=>parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow();
  });
});

describe('EditDoc v6: media and graphics fields together',()=>{
  const full=()=>{
    const d=doc({angle:'close',mic:'lav'});
    return {...d,clips:d.clips.map(c=>c.id==='close'?{...c,avOffset:0.08}:c),
      tracks:{...d.tracks,graphics:[{id:'g1',assetId:'ga-1',start:0,end:2,owner:'agent',behindSubject:true}]}};
  };
  it('one v6 holds groups, angle, mic, avOffset and behindSubject',()=>{
    const p=parseEditDoc(full()).doc;
    expect(p.version).toBe(6);
    expect([p.groups.length,p.tracks['a-roll'][0]!.angle,p.clips.find(c=>c.id==='close')!.avOffset,p.tracks.graphics[0]!.behindSubject]).toEqual([1,'close',0.08,true]);
  });
  it('v3, v4 and v5 docs still load, with none of the new fields',()=>{
    const d=doc({});
    const {groups:_,...old}=d;
    for(const version of [3,4,5]) {
      const p=parseEditDoc({...old,version}).doc;
      expect([p.version,p.groups,p.tracks.graphics]).toEqual([6,[],[]]);
    }
  });
  it('a subject mask follows the angle shown, in step',()=>{
    const [x]=subjectSpans(parseEditDoc(full()).doc);
    expect([x!.clipId,x!.srcStart,x!.srcEnd]).toEqual(['close',5,7]);
  });
});
