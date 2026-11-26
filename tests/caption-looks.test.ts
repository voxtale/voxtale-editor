// Caption looks: presets, word timing, and the shared state renderers draw from.
import {describe,expect,test} from 'bun:test';
import {CAPTION_PRESET_IDS,CAPTION_PRESETS,captionLook,captionStyleSchema,captionWords,clipRefSchema,parseEditDoc,withCaptionPreset} from '@voxtale/editdoc';

import {buildCut,styleOf,type Job} from '../src/video/editor/agent/cut';
import {assScript} from '../src/video/render-edit';

const ref=(w:number,h:number)=>clipRefSchema.parse({id:'c1',hash:'a'.repeat(64),name:'c.mov',kind:'video',role:'a-roll',roleSource:'index',duration:60,width:w,height:h,hasAudio:true});
const words='this one habit doubled my income in six months'.split(' ').map((text,i)=>({id:i,text,start:1+i*0.4,end:1.35+i*0.4}));
function cut(preset:keyof typeof CAPTION_PRESETS,w=1080,h=1920) {
  const base=styleOf(undefined);
  const job:Job={id:'j',name:'J',clips:[{ref:ref(w,h),words}],
    style:{...base,pace:{...base.pace,captions:'full'},brand:{...base.brand,captionStyle:withCaptionPreset(base.brand.captionStyle,preset)}}};
  return buildCut(job,[{clip:'c1',from:0,to:8}],{captions:[{clip:'c1',from:0,to:8}]});
}

describe('caption looks',()=>{
  test('every preset is a valid style, and an old style still parses',()=>{
    for(const id of CAPTION_PRESET_IDS)expect(()=>withCaptionPreset(captionStyleSchema.parse({}),id)).not.toThrow();
    const old=captionStyleSchema.parse({size:64,weight:800});
    expect(old).toMatchObject({animation:'none',box:'line',strokeWidth:0,case:'none'});
  });
  test('captions carry one start per shown word, and the doc validates',()=>{
    const doc=cut('bold');
    parseEditDoc(JSON.parse(JSON.stringify(doc)));
    for(const c of doc.tracks.captions) {
      expect(c.wordStarts).toHaveLength(c.text.split(' ').length);
      expect(c.wordStarts![0]).toBeCloseTo(0,1);
    }
  });
  test('the spoken word is the one whose start has passed; a rewritten line has none',()=>{
    const c={text:'a b c',wordStarts:[0,0.4,0.8]};
    expect(captionWords(c,0.5)!.map(w=>[w.active,w.spoken])).toEqual([[false,true],[true,false],[false,false]]);
    expect(captionWords({...c,text:'a b c d'},0.5)).toBeUndefined();
    expect(captionWords({text:'a b c'},0.5)).toBeUndefined();
  });
  test('type is sized on the short side, and lines fit the width',()=>{
    const tall=cut('bold'),wide=cut('bold',1920,1080);
    expect(captionLook(tall).fontSize).toBe(captionLook(wide).fontSize);
    const look=captionLook(tall);
    for(const c of tall.tracks.captions)expect(c.text.length*look.fontSize*0.65).toBeLessThanOrEqual(tall.canvas.width);
  });
  test('a moving look draws one event per spoken word; a still look one per line',()=>{
    const events=(d:ReturnType<typeof cut>)=>assScript(d,30).split('\n').filter(l=>l.startsWith('Dialogue:')).length;
    const still=cut('classic'),moving=cut('bold');
    expect(events(still)).toBe(still.tracks.captions.length);
    expect(events(moving)).toBe(words.length);
    expect(assScript(moving,30)).toContain('THIS');
  });
});
