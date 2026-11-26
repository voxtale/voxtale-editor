import {describe,expect,test} from 'bun:test';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {decisionsBetween,type ClipRef} from '@voxtale/editdoc';
import {editSchema,mappedCaptions,timeline,type Edit} from '../src/video/model';
import {applyEditStage,clipFromTranscript,editDocFromEdit,editFromEditDoc} from '../src/video/editdoc';

const HASH='b'.repeat(64);
const stamp={at:'2026-09-30T00:00:00.000Z',prompts:{}};

/** Everything the Remotion composition reads, in frames. */
function rendered(edit:Edit) {
  return {
    size:[edit.fps,edit.width,edit.height],
    shots:timeline(edit).map(s=>({from:s.from,duration:s.duration,sourceStart:s.sourceStart,zoom:s.zoom,title:s.title??null,titleStyle:s.title?s.titleStyle:null,
      broll:s.broll?{...s.broll,in:Math.round(s.broll.in*edit.fps)}:null,
      graphics:(s.graphics??[]).map(g=>{const from=Math.max(0,Math.round(g.in*edit.fps)-s.sourceStart);return {from,duration:Math.min(s.duration-from,Math.round(g.out*edit.fps)-Math.round(g.in*edit.fps)),text:g.text,style:g.style};})})),
    captions:mappedCaptions(edit),
    music:edit.music?{path:edit.music.path,volume:+edit.music.volume.toFixed(6)}:null,
    speech:+edit.speechVolume.toFixed(6),accent:edit.accent.toLowerCase(),
  };
}
const source=(edit:Edit):ClipRef=>clipFromTranscript(edit,{sourceHash:HASH,duration:Math.max(...edit.scenes.map(s=>s.out))});
function roundTrip(edit:Edit,mediaClip?:(p:string,k:'image'|'video'|'audio')=>ClipRef) {
  const paths=new Map<string,string>([['source',edit.source]]);
  const doc=editDocFromEdit(edit,{clip:source(edit),mediaClip:mediaClip&&((p,k)=>{const c=mediaClip(p,k);paths.set(c.id,p);return c;})});
  return {doc,back:editFromEditDoc(doc,{clipPath:c=>paths.get(c.id)!})};
}

const OWNPOD=join(import.meta.dir,'../data/video/ownpod-v5');
describe.skipIf(!existsSync(join(OWNPOD,'graphics/edit.json')))('OwnPod regression (EditDoc v2 round trip)',()=>{
  for(const stage of ['takes','graphics','preview-final']) test(`${stage}: same cut, captions and graphics`,()=>{
    const edit=editSchema.parse(JSON.parse(readFileSync(join(OWNPOD,stage,'edit.json'),'utf8')));
    const {doc,back}=roundTrip(edit);
    expect(doc.tracks['a-roll'].length).toBe(edit.scenes.length);
    expect(rendered(back)).toEqual(rendered(edit));
  });
  test('takes → graphics applies as a text-stage patch only',()=>{
    const takes=editSchema.parse(JSON.parse(readFileSync(join(OWNPOD,'takes/edit.json'),'utf8')));
    const graphics=editSchema.parse(JSON.parse(readFileSync(join(OWNPOD,'graphics/edit.json'),'utf8')));
    const before=editDocFromEdit(takes,{clip:source(takes)});
    const after=applyEditStage(before,graphics,['text'],stamp);
    expect(after.revision).toBe(before.revision+1);
    expect(after.tracks['a-roll']).toEqual(before.tracks['a-roll']);
    expect(after.tracks.text.length).toBe(graphics.scenes.flatMap(s=>s.graphics??[]).length);
    expect(rendered(editFromEditDoc(after,{clipPath:()=>takes.source}))).toEqual(rendered(graphics));
  });
});

const base:Edit=editSchema.parse({version:1,name:'Synthetic',source:'/v/cam.mov',fps:30,scenes:[
  {id:'s1',in:1.013,out:4.2,zoom:1.3,title:'Welcome',titleStyle:'card'},
  {id:'s2',in:6.5,out:9.99,graphics:[{id:'g1',in:7,out:8.51,text:'Key number',style:'callout'},{id:'g2',in:9,out:9.99,text:'Part two',style:'chapter'}],
    broll:{path:'broll/city.mp4',kind:'video',in:3,fit:'contain'}},
  {id:'s3',in:2,out:3,title:'Lower',broll:{path:'broll/logo.png',kind:'image',in:0,fit:'cover'}},
],captions:[{start:1.2,end:2.05,text:'Hello there',sceneId:'s1'},{start:2.1,end:6.9,text:'spans a cut'},{start:7.2,end:7.9,text:'Mid'}],
music:{path:'music/bed.mp3',volume:0.12},speechVolume:1.4,accent:'#12AB34'});
const mediaClip=(p:string,k:'image'|'video'|'audio'):ClipRef=>({id:p.replace(/[^a-z0-9]/gi,'-'),hash:HASH,name:p,kind:k==='image'?'image':k,
  role:k==='audio'?'music':'b-roll',roleSource:'creator',duration:k==='image'?3600:60,hasAudio:k!=='image',timecodeStart:0});

describe('EditDoc v2 bridge',()=>{
  test('titles, zoom, b-roll, music, volume, accent and unscoped captions survive',()=>{
    const {doc,back}=roundTrip(base,mediaClip);
    expect(rendered(back)).toEqual(rendered(base));
    expect(doc.tracks.zoom).toMatchObject([{start:doc.tracks['a-roll'][0]!.start,end:doc.tracks['a-roll'][0]!.end,scale:1.3,x:0.5,y:0.5,easeIn:0,easeOut:0}]);
    expect(doc.tracks.text.map(t=>[t.id,t.template])).toEqual([['s1.title','title'],['g1','callout'],['g2','chapter'],['s3.title','lowerThird']]);
    expect(doc.tracks['b-roll'].map(b=>b.clipId)).toEqual(['broll-city-mp4','broll-logo-png']);
    expect(doc.tracks.captions.map(c=>c.id)).toEqual(['cap-s1-1','cap-s1-2','cap-s2-2','cap-s2-3','cap-s3-2']);
    expect(doc.styleRef.snapshot.brand.colors.accent).toBe('#12AB34');
  });
  test('captions carry transcript word ids when given',()=>{
    const words=[{id:0,text:'Hello',start:1.2,end:1.6,confidence:1},{id:1,text:'there',start:1.6,end:2.05,confidence:1}];
    const doc=editDocFromEdit(base,{clip:source(base),mediaClip,transcript:{words}});
    expect(doc.tracks.captions[0]!.words).toEqual(['source:0','source:1']);
  });
  test('refuses what v1 cannot render',()=>{
    const {doc}=roundTrip(base,mediaClip);
    const gap={...doc,tracks:{...doc.tracks,'a-roll':doc.tracks['a-roll'].slice(1)}};
    expect(()=>editFromEditDoc(gap,{clipPath:()=>'/x'})).toThrow(/gap/);
    const two={...doc,clips:[...doc.clips,{...doc.clips[0]!,id:'cam2'}],tracks:{...doc.tracks,'a-roll':doc.tracks['a-roll'].map((a,i)=>i===2?{...a,clipId:'cam2'}:a)}};
    expect(()=>editFromEditDoc(two,{clipPath:()=>'/x'})).toThrow(/one a-roll clip/);
    expect(()=>editDocFromEdit(base,{clip:source(base)})).toThrow(/mediaClip/);
  });
  test('a takes stage lands as assembly + text and logs decisions',()=>{
    const whole=editSchema.parse({...base,scenes:[{id:'s1',in:0,out:10}],captions:[],music:undefined,speechVolume:1});
    const doc=editDocFromEdit(whole,{clip:source(whole)});
    const takes=editSchema.parse({...whole,scenes:[{id:'s1-take-1',in:0,out:4},{id:'s1-take-2',in:6,out:10}],captions:[{start:1,end:2,text:'Kept',sceneId:'s1-take-1'}]});
    const next=applyEditStage(doc,takes,['assembly','text'],stamp);
    expect(next.provenance.map(p=>p.stage)).toEqual(['assembly','text']);
    expect(next.tracks['a-roll'].map(a=>[a.id,a.start,a.end])).toEqual([['s1-take-1',0,4],['s1-take-2',4,8]]);
    expect(decisionsBetween(doc,next)).toEqual([{itemId:'s1',track:'a-roll',action:'deleted',fromRevision:0,toRevision:2,stage:undefined}]);
    expect(rendered(editFromEditDoc(next,{clipPath:()=>whole.source}))).toEqual(rendered(takes));
  });
});
