// Screen craft: a region of the frame blown up, footage sped up, and the
// speaker kept in a corner over it. Cut build, validation and render plan.
import {describe,expect,test} from 'bun:test';
import {clipRefSchema,parseEditDoc,pipBox} from '@voxtale/editdoc';

import {buildCut,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {planRender} from '../src/video/render-edit';

const words='one two three four five six seven eight nine ten eleven twelve'.split(' ').map((text,i)=>({id:i,text,start:2+i,end:2.4+i}));
const hash=(c:string)=>c.repeat(64);
const speaker:JobClip={ref:clipRefSchema.parse({id:'c1',hash:hash('a'),name:'c1.mov',kind:'video',role:'a-roll',roleSource:'index',duration:60,width:1920,height:1080,hasAudio:true}),words};
const screen:JobClip={ref:clipRefSchema.parse({id:'s1',hash:hash('b'),name:'s1.mov',kind:'video',role:'screen',roleSource:'index',duration:40,width:2560,height:1440,hasAudio:false}),words:[]};
const job:Job={id:'j',name:'J',clips:[speaker,screen],style:styleOf(undefined)};
const segs=[{clip:'c1',from:0,to:11}];
const shot=(extra:object)=>buildCut(job,segs,{broll:[{id:'x',broll:'s1',clip:'c1',word:4,seconds:3,in:5,reason:'r',...extra}]});
const media={[hash('a')]:'/a.mov',[hash('b')]:'/b.mov'};

describe('screen craft',()=>{
  test('speed: source runs longer than the shot, and the doc still parses',()=>{
    const doc=shot({speed:4}),b=doc.tracks['b-roll'][0]!;
    expect(b.speed).toBe(4);
    expect(b.out-b.in).toBeCloseTo((b.end-b.start)*4,3);
    expect(()=>parseEditDoc(JSON.parse(JSON.stringify(doc)))).not.toThrow();
  });
  test('speed stops at the end of the source',()=>{
    const b=shot({speed:8,in:20}).tracks['b-roll'][0]!;
    expect(b.out).toBeLessThanOrEqual(40+1e-6);
    expect(b.end-b.start).toBeLessThan(3);
  });
  test('a source length that does not match the speed is refused',()=>{
    const doc=JSON.parse(JSON.stringify(shot({speed:4})));
    doc.tracks['b-roll'][0].out-=3;
    expect(()=>parseEditDoc(doc)).toThrow();
  });
  test('crop: a region the shape of the frame fills it; another shape shows whole; outside the frame is refused',()=>{
    expect(shot({crop:{x:0.1,y:0.1,w:0.5,h:0.5}}).tracks['b-roll'][0]).toMatchObject({fit:'cover',crop:{w:0.5}});
    expect(shot({crop:{x:0,y:0,w:0.3,h:0.9}}).tracks['b-roll'][0]!.fit).toBe('contain');
    const doc=JSON.parse(JSON.stringify(shot({crop:{x:0.1,y:0.1,w:0.5,h:0.5}})));
    doc.tracks['b-roll'][0].crop.x=0.8;
    expect(()=>parseEditDoc(doc)).toThrow();
  });
  test('the render plan carries crop and speed to the picture',()=>{
    const p=planRender(shot({speed:2,crop:{x:0.1,y:0.1,w:0.5,h:0.5}}),media).pictures.find(p=>p.itemId==='b-x')!;
    expect(p).toMatchObject({speed:2,crop:{x:0.1}});
  });
  test('pip: the speaker is drawn in the corner for as long as the shot, in step with the voice',()=>{
    const doc=shot({pip:'top-right'}),b=doc.tracks['b-roll'][0]!,a=doc.tracks['a-roll'][0]!;
    const plan=planRender(doc,media),k=plan.pictures.findIndex(p=>p.itemId.startsWith('b-x.pip')),p=plan.pictures[k]!;
    expect(k).toBeGreaterThan(plan.pictures.findIndex(x=>x.itemId==='b-x'));
    expect(p.path).toBe('/a.mov');
    expect(p.box).toEqual(pipBox(doc.canvas,'top-right'));
    expect(p.in).toBeCloseTo(a.in+(b.start-a.start),3);
    expect(p.fe-p.fs).toBe(plan.pictures.find(x=>x.itemId==='b-x')!.fe-plan.pictures.find(x=>x.itemId==='b-x')!.fs);
  });
  test('the corner box keeps the canvas shape and stays inside it',()=>{
    for(const canvas of [{width:1920,height:1080},{width:1080,height:1920}])for(const c of ['top-left','top-right','bottom-left','bottom-right'] as const) {
      const b=pipBox(canvas,c);
      expect(b.x).toBeGreaterThan(0);
      expect(b.y).toBeGreaterThan(0);
      expect(b.x+b.width).toBeLessThan(canvas.width);
      expect(b.y+b.height).toBeLessThan(canvas.height);
      expect(b.width/b.height).toBeCloseTo(canvas.width/canvas.height,1);
    }
  });
});
