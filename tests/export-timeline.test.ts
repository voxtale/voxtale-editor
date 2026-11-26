// Export port: the model from sample EditDocs (multi-cam, pip/split, avOffset)
// and one golden file per adapter. Refresh goldens: UPDATE_GOLDEN=1 bun test tests/export-timeline.test.ts
import {describe,expect,it} from 'bun:test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  buildExportTimeline,exportTimeline,newEditDoc,parseEditDoc,placePicture,pipBox,splitBoxes,STYLE_PRESETS,EXPORT_TARGETS,
  type ClipRef,type EditDoc,type ExportMedia,
} from '@voxtale/editdoc';

const fps={num:25,den:1};
const W=1920,H=1080;
const clip=(id:string,over:Partial<ClipRef>={}):ClipRef=>({
  id,hash:[...id].map(ch=>ch.charCodeAt(0).toString(16)).join('').padEnd(64,'0').slice(0,64),name:`${id}.mp4`,kind:'video',role:'a-roll',roleSource:'creator',
  duration:20,fps,hasAudio:true,timecodeStart:0,width:W,height:H,...over,
});
const media:ExportMedia={clipPath:c=>`/footage/${c.name}`,graphicPath:g=>g.assetId==='gfx1'?{path:'/renders/gfx1.webm',duration:2,fps}:undefined};

/** Two cameras and a lav in one sync group; pip, split, b-roll with speed/crop/corner, ducked music, a graphic. */
function sample():EditDoc {
  const d=newEditDoc({id:'ed1',name:'Export sample',fps,style:STYLE_PRESETS.tutorial,clips:[
    clip('camA'),clip('camB',{timecodeStart:3600}),
    clip('lav',{kind:'audio',role:'a-roll',width:undefined,height:undefined,fps:undefined,avOffset:0.08} as Partial<ClipRef>),
    clip('br',{role:'b-roll',width:3840,height:2160,hasAudio:false}),
    clip('song',{kind:'audio',role:'music',width:undefined,height:undefined,fps:undefined,duration:60}),
  ]});
  return parseEditDoc({
    ...d,canvas:{width:W,height:H},
    groups:[{id:'g1',via:'sound',members:[{clipId:'camA',start:0},{clipId:'camB',start:1},{clipId:'lav',start:0.5}]}],
    tracks:{...d.tracks,
      'a-roll':[
        {id:'a1',clipId:'camA',in:2,out:5,start:0,end:3,owner:'agent',angle:'camB',mic:'lav'},
        {id:'a2',clipId:'camA',in:6,out:8,start:3,end:5,owner:'agent',layout:'pip',pipCorner:'top-left',companions:[{clipId:'camB',offset:0}]},
        {id:'a3',clipId:'camA',in:9,out:10,start:5,end:6,owner:'agent',layout:'split',companions:[{clipId:'camB',offset:0}],gainDb:-3},
        // camB starts 1 s into camA: it does not cover camA 0–0.4, so the angle falls back.
        {id:'a4',clipId:'camA',in:0,out:0.4,start:6,end:6.4,owner:'agent',angle:'camB'},
      ],
      'b-roll':[{id:'b1',clipId:'br',in:0,out:2,start:1,end:2,owner:'agent',status:'applied',fit:'cover',muted:true,opacity:1,speed:2,
        crop:{x:0.25,y:0.25,w:0.5,h:0.5},pip:'bottom-right'}],
      music:[{id:'m1',clipId:'song',in:0,out:6.4,start:0,end:6.4,owner:'agent',status:'applied',gainDb:-18,fadeIn:1,fadeOut:1,duck:true}],
      graphics:[{id:'g1',start:4,end:5,owner:'agent',status:'applied',assetId:'gfx1',assetRevision:1,placement:'full',behindSubject:true}],
      text:[{id:'t1',start:1,end:3,owner:'agent',status:'applied',template:'lowerThird',text:'Jane Doe',subtext:'Host',position:'auto'}],
    },
    markers:[{id:'k1',time:3,kind:'chapter',title:'Part two',owner:'agent',status:'applied'}],
  }).doc;
}

const track=(t:ReturnType<typeof buildExportTimeline>,name:string)=>[...t.video,...t.audio].find(x=>x.name===name)!;

describe('export model',()=>{
  const t=buildExportTimeline(sample(),media);
  it('plays the picked angle, through the sync group, from the file start',()=>{
    const a=track(t,'A-roll').clips;
    expect(a.map(c=>[c.itemId,c.sourceId,c.start,c.end,c.in])).toEqual([
      ['a1','camB',0,75,1],['a2','camA',75,125,6],['a3','camA',125,150,9],['a4','camA',150,160,0],
    ]);
    expect(a[0]!.note.angle).toBe('camB');
    expect(t.warnings).toEqual([{itemId:'a4',note:'angle camB does not cover this piece: plays camA'}]);
  });
  it('hears the mic, moved by its avOffset',()=>{
    const s=track(t,'A-roll audio').clips;
    // lav time = group time - 0.5; camA 2 → lav 1.5; sound moved 0.08 later → read from 1.42.
    expect(s[0]).toMatchObject({itemId:'a1',sourceId:'lav',start:0,end:75});
    expect(s[0]!.in).toBeCloseTo(1.42,6);
    expect(s[0]!.note.mic).toBe('lav');
    expect(s.find(c=>c.itemId==='a3')!.sound!.gainDb).toBe(-3);
  });
  it('lays pip and split out as boxes on their own track',()=>{
    const l=track(t,'A-roll layout').clips;
    expect(l.map(c=>[c.itemId,c.sourceId,c.layout,c.in])).toEqual([['a2','camB','pip',5],['a3','camB','split',8]]);
    expect(l[0]!.picture!.box).toEqual(pipBox({width:W,height:H},'top-left'));
    const [left,right]=splitBoxes({width:W,height:H});
    expect(l[1]!.picture!.box).toEqual(right);
    expect(track(t,'A-roll').clips[2]!.picture!.box).toEqual(left);
  });
  it('b-roll: speed reads twice the source, crop kept, speaker in the corner',()=>{
    const b=track(t,'B-roll').clips[0]!;
    expect([b.in,b.out,b.speed]).toEqual([0,2,2]);
    expect(b.picture!.crop).toEqual({x:0.25,y:0.25,w:0.5,h:0.5});
    const sp=track(t,'Speaker').clips;
    expect(sp.map(c=>[c.sourceId,c.start,c.end,c.layout])).toEqual([['camA',25,50,'speaker-pip']]);
    // A quarter of the 4K frame at cover fills 1920×1080 exactly: the whole source is twice the canvas.
    expect(placePicture({width:3840,height:2160},{width:W,height:H},b.picture!).rect).toEqual({x:-960,y:-540,width:3840,height:2160});
  });
  it('ducks the music under speech, graphics as rendered media, uses per feature',()=>{
    expect(track(t,'Music').clips[0]!.sound!.duck!.length).toBeGreaterThan(1);
    expect(track(t,'Graphics').clips[0]).toMatchObject({sourceId:'gfx:g1',start:100,end:125});
    expect(Object.keys(t.uses).sort()).toEqual(['audio-fade','behind-subject','crop','duck','gain','graphics','layout','loudness','markers','speed','titles']);
  });
});

describe('export port',()=>{
  it('reports what each target cannot carry',()=>{
    const by=Object.fromEntries(EXPORT_TARGETS.map(k=>[k,exportTimeline(sample(),media,k).losses.map(l=>l.feature)]));
    expect(by.premiere).toEqual(['behind-subject','titles','loudness','fallback']);
    expect(by.finalcut).toContain('speed');
    expect(by.finalcut).toContain('duck');
    expect(by.otio).toContain('layout');
    expect(exportTimeline(sample(),media,'otio').losses.find(l=>l.feature==='fallback')!.items).toEqual(['a4']);
  });
  it('throws on a relative path, as before',()=>{
    expect(()=>exportTimeline(sample(),{clipPath:c=>c.name},'premiere')).toThrow(/absolute/);
  });
  it('resolve divides the scale by its fit-to-frame; premiere counts source pixels',()=>{
    const scale=(x:string,item:string)=>x.match(new RegExp(`<name>${item}</name>[\\s\\S]*?<parameterid>scale</parameterid>[\\s\\S]*?<value>([\\d.]+)</value>`))![1];
    const pr=exportTimeline(sample(),media,'premiere').text,re=exportTimeline(sample(),media,'resolve').text;
    expect(scale(pr,'b1')).toBe('100');
    expect(scale(re,'b1')).toBe('200');
  });
});

describe('golden files',()=>{
  const dir=join(import.meta.dir,'golden','export');
  for(const target of EXPORT_TARGETS) it(target,()=>{
    const r=exportTimeline(sample(),media,target),file=join(dir,`sample.${target}.${r.extension}`);
    if(process.env.UPDATE_GOLDEN){mkdirSync(dir,{recursive:true});writeFileSync(file,r.text);}
    expect(r.text).toBe(readFileSync(file,'utf8'));
  });
});
