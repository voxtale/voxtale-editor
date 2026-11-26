// Zoom kinds in the agent's cut: a punch, a slow push, and the reframe that
// moves the speaker clear of a side panel.
import {describe,expect,test} from 'bun:test';
import {clipRefSchema,zoomAt} from '@voxtale/editdoc';

import {buildCut,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {LINE_PUSH,PUNCH,REFRAME_MAX,reframeFor} from '../src/video/zoom';

const words='one two three four five six seven eight nine ten eleven twelve'.split(' ').map((text,i)=>({id:i,text,start:2+i,end:2.4+i}));
const speaker:JobClip={ref:clipRefSchema.parse({id:'c1',hash:'a'.repeat(64),name:'c1.mov',kind:'video',role:'a-roll',roleSource:'index',duration:60,width:1920,height:1080,hasAudio:true}),words};
const job:Job={id:'j',name:'J',clips:[speaker],style:styleOf(undefined)};
const segs=[{clip:'c1',from:0,to:3},{clip:'c1',from:6,to:11}];

describe('stress zooms',()=>{
  test('a punch cuts in; a push eases in over its line',()=>{
    const zoom=(kind?:'punch'|'push')=>buildCut(job,segs,{zooms:[{clip:'c1',from:7,to:9,why:'the turn',...(kind?{kind}:{})}]}).tracks.zoom.find(z=>/key line/.test(z.reason??''))!;
    const punch=zoom(),push=zoom('push');
    expect(punch.scale).toBe(PUNCH);
    expect(punch.easeIn).toBe(0);
    expect(push.scale).toBe(LINE_PUSH);
    expect(push.easeIn).toBeCloseTo(push.end-push.start,2);
    expect(push.reason).toContain('the turn');
  });
  test('a push on a stretch too short to read as movement is a punch',()=>{
    const z=buildCut(job,[{clip:'c1',from:0,to:3},{clip:'c1',from:6,to:6},{clip:'c1',from:8,to:11}],{zooms:[{clip:'c1',from:6,to:6,kind:'push'}]}).tracks.zoom.find(z=>/key line/.test(z.reason??''))!;
    expect(z.scale).toBe(PUNCH);
  });
});

describe('reframe for a side panel',()=>{
  const g=(placement:string)=>({id:'g',start:10,end:16,placement});
  test('the speaker moves to the free side, inside the frame',()=>{
    for(const [placement,face] of [['right',0.5],['left',0.5],['right',0.6],['left',0.45]] as const) {
      const z=reframeFor(g(placement),{x:face,y:0.4})!;
      const shown=z.x+z.scale*(face-z.x);
      expect(z.scale).toBeLessThanOrEqual(REFRAME_MAX);
      if(placement==='right')expect(shown).toBeLessThan(face-0.1);
      else expect(shown).toBeGreaterThan(face+0.1);
      expect(z.easeIn).toBeGreaterThan(0);
      expect(z.easeOut).toBeGreaterThan(0);
    }
  });
  test('none when the face is already clear, the graphic is not a side panel, or it is too brief',()=>{
    expect(reframeFor(g('right'),{x:0.3,y:0.4})).toBeUndefined();
    expect(reframeFor(g('left'),{x:0.7,y:0.4})).toBeUndefined();
    expect(reframeFor(g('full'),{x:0.5,y:0.4})).toBeUndefined();
    expect(reframeFor(g('bottom'),{x:0.5,y:0.4})).toBeUndefined();
    expect(reframeFor({...g('right'),end:10.8},{x:0.5,y:0.4})).toBeUndefined();
  });
  test('the cut reframes under a panel, in place of any stress zoom there',()=>{
    const doc=buildCut(job,segs,{graphics:[{id:'p',clip:'c1',word:7,seconds:3,placement:'right',reason:'r'}],
      zooms:[{clip:'c1',from:7,to:9,why:'x'}],eyesAt:()=>({x:0.5,y:0.4})});
    const g=doc.tracks.graphics[0]!,zs=doc.tracks.zoom.filter(z=>z.start<g.end&&z.end>g.start);
    expect(zs).toHaveLength(1);
    expect(zs[0]).toMatchObject({start:g.start,end:g.end,x:1});
    // Wide at both ends, in and across at the middle: no jump as the panel comes and goes.
    expect(zoomAt(doc.tracks.zoom,g.start).scale).toBeCloseTo(1,2);
    expect(zoomAt(doc.tracks.zoom,(g.start+g.end)/2).scale).toBeCloseTo(zs[0]!.scale,2);
    expect(zoomAt(doc.tracks.zoom,g.end-0.001).scale).toBeCloseTo(1,1);
  });
});
