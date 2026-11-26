// Audio stage (P6): music beds per chapter, effects on what appears, speech
// lifted to the loudness target. All by code, from the creator's own files.
import {describe,expect,test} from 'bun:test';
import {STYLE_PRESETS,newEditDoc,parseEditDoc,type ClipRef,type EditDoc,type EditStyle} from '@voxtale/editdoc';
import {SFX_LEAD,SFX_MAX,planAudio,speechLoudness} from '../src/video';

const fps={num:30,den:1};
const clip=(id:string,role:ClipRef['role'],duration:number,over:Partial<ClipRef>={}):ClipRef=>({id,hash:Buffer.from(id).toString('hex').repeat(64).slice(0,64),name:`${id}.wav`,
  kind:role==='a-roll'?'video':'audio',role,roleSource:'creator',duration,fps,hasAudio:true,timecodeStart:0,...over});

function doc(clips:ClipRef[],style:EditStyle,extra:Record<string,unknown>={},markers:unknown[]=[]):EditDoc {
  const d=newEditDoc({id:'e',name:'e',clips,fps,style});
  const aroll=[{id:'a1',clipId:'cam',in:0,out:30,start:0,end:30,owner:'agent'},{id:'a2',clipId:'cam',in:40,out:70,start:30,end:60,owner:'agent'}];
  return parseEditDoc({...d,tracks:{...d.tracks,'a-roll':aroll,...extra},markers}).doc;
}
const cam=clip('cam','a-roll',120,{loudness:{lufs:-20,truePeakDb:-3}});
const chapters=[{id:'ch1',time:20,kind:'chapter',title:'Two',owner:'agent'},{id:'ch2',time:40,kind:'chapter',title:'Three',owner:'agent'}];

describe('music',()=>{
  test('one track loops under the whole video with fades at the ends',()=>{
    const {music}=planAudio(doc([cam,clip('m1','music',25)],STYLE_PRESETS['calm-explainer']));
    expect(music.map(m=>[m.start,m.end])).toEqual([[0,25],[25,50],[50,60]]);
    // -14 target, 26 dB below, lifted 12 dB in the gaps, from a track assumed at -14 LUFS.
    expect(music.every(m=>m.clipId==='m1'&&m.duck&&m.gainDb===-14)).toBe(true);
    expect(music[0]!.fadeIn).toBe(1);
    expect(music.at(-1)!.fadeOut).toBe(2);
  });
  test('several tracks change at chapters, in file order',()=>{
    const {music}=planAudio(doc([cam,clip('m1','music',100),clip('m2','music',100)],STYLE_PRESETS['calm-explainer'],{},chapters));
    expect(music.map(m=>[m.clipId,m.start,m.end])).toEqual([['m1',0,20],['m2',20,40],['m1',40,60]]);
  });
  test('a loud track is turned down more',()=>{
    const {music}=planAudio(doc([cam,clip('m1','music',100,{loudness:{lufs:-8,truePeakDb:0}})],STYLE_PRESETS['calm-explainer']));
    expect(music[0]!.gainDb).toBe(-20);
  });
  test('no music files, no music',()=>{
    expect(planAudio(doc([cam],STYLE_PRESETS['calm-explainer'])).music).toEqual([]);
  });
});

describe('effects',()=>{
  const g=(id:string,start:number)=>({id,assetId:id,start,end:start+3,owner:'agent'});
  test('land just before graphics and chapters, spaced by the style',()=>{
    const {sfx}=planAudio(doc([cam,clip('s1','sfx',3),clip('s2','sfx',0.5)],STYLE_PRESETS.tutorial,{graphics:[g('g1',10),g('g2',12),g('g3',30)]},chapters));
    expect(sfx.map(s=>s.id)).toEqual(['sfx-g1','sfx-ch1','sfx-g3','sfx-ch2']);
    expect(sfx[0]!.start).toBeCloseTo(10-SFX_LEAD,5);
    // The short file ticks on the graphic; the long one sweeps into the chapter, cut to the longest effect.
    expect(sfx[0]!.clipId).toBe('s2');
    expect(sfx[1]!.clipId).toBe('s1');
    expect(sfx[1]!.end-sfx[1]!.start).toBeCloseTo(SFX_MAX,5);
    expect(sfx[0]!.tiedTo).toBe('g1');
  });
  test('a style without effects adds none',()=>{
    expect(planAudio(doc([cam,clip('s1','sfx',1)],STYLE_PRESETS['calm-explainer'],{graphics:[g('g1',10)]})).sfx).toEqual([]);
  });
  test('says so when effects are wanted but no files were chosen',()=>{
    expect(planAudio(doc([cam],STYLE_PRESETS.tutorial,{graphics:[g('g1',10)]})).notes.join(' ')).toMatch(/sound effect/i);
  });
});

describe('loudness',()=>{
  test('lifts speech to the style target',()=>{
    const d=doc([cam],STYLE_PRESETS['calm-explainer']);
    expect(speechLoudness(d)).toBeCloseTo(-20,5);
    expect(planAudio(d).mix).toEqual({loudnessLufs:-14,speechGainDb:6});
  });
  test('unmeasured clips leave speech gain alone',()=>{
    expect(planAudio(doc([{...cam,loudness:undefined}],STYLE_PRESETS['calm-explainer'])).mix).toEqual({loudnessLufs:-14});
  });
});
