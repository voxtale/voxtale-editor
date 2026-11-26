// Screen recordings read by code: the page inside the window bars, the
// changes that fall under kept speech, and footage ranked against words.
import {describe,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clipRefSchema} from '@voxtale/editdoc';
import type {FrameHost} from '@voxtale/frames';

import {buildCut,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {rankFootage,screenActivity,shownMeanwhile,stem,terms} from '../src/video/editor/agent/footage';
import {editorTools,type Workspace} from '../src/video/editor/agent/tools';
import {CONTENT_H as H,CONTENT_W as W,contentBox,spreadTimes} from '../src/video/screen';

/** A grey frame: `page` fills the window, with bars drawn by `paint`. */
const frame=(page:(x:number,y:number)=>number,paint:(x:number,y:number)=>number|undefined)=>{
  const f=new Uint8Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)f[y*W+x]=paint(x,y)??page(x,y);
  return f;
};
/** A dark bar on top (8%), a strip on the left (4%), a dock at the bottom (7%). */
const bars=(x:number,y:number)=>y<16?30:y>=186?40:x<13?25:undefined;
/** Page content that differs frame to frame, as a scrolling page does. */
const scrolling=(k:number)=>(x:number,y:number)=>200+(((x>>3)+(y>>3)+k)%2?30:0);

describe('the page inside the bars',()=>{
  test('bars, side strip and dock fall outside it',()=>{
    const box=contentBox([0,1,2,3,4].map(k=>frame(scrolling(k),bars)))!;
    expect(box.y).toBeCloseTo(16/H,2);
    expect(box.x).toBeCloseTo(13/W,2);
    expect(box.y+box.h).toBeCloseTo(186/H,2);
    expect(box.x+box.w).toBe(1);
  });
  test('footage with no bars is left whole',()=>{
    expect(contentBox([0,1,2].map(k=>frame(scrolling(k),()=>undefined)))).toBeUndefined();
  });
  test('a line of text near the top is not a bar: its edges come in short broken runs',()=>{
    // Dashes 6px long with 6px gaps, still in every frame.
    const text=(x:number,y:number)=>y>=20&&y<24&&x>40&&x<280&&x%12<6?20:undefined;
    const box=contentBox([0,1,2].map(k=>frame(scrolling(k),(x,y)=>bars(x,y)??text(x,y))))!;
    expect(box.y).toBeCloseTo(16/H,2);
  });
  test('an edge deep in the frame is content, whatever its length',()=>{
    const mid=(x:number,y:number)=>y<80?30:undefined;
    expect(contentBox([0,1,2].map(k=>frame(scrolling(k),mid)))).toBeUndefined();
  });
  test('a bar that is there in only some frames is not cut',()=>{
    const fs=[frame(scrolling(0),bars),frame(scrolling(1),()=>undefined),frame(scrolling(2),bars)];
    expect(contentBox(fs)).toBeUndefined();
  });
  test('times spread over the stretches shown',()=>{
    const ts=spreadTimes([[10,12],[50,58]]);
    expect(ts).toHaveLength(5);
    expect(ts[0]!).toBeGreaterThanOrEqual(10);
    expect(ts.at(-1)!).toBeLessThanOrEqual(58);
    expect(ts.filter(t=>t>12&&t<50)).toEqual([]);
  });
});

const hash=(c:string)=>c.repeat(64);
const say=(text:string,t0=1,each=0.3,gap=0.1)=>text.split(' ').map((w,i)=>({id:i,text:w,start:t0+i*(each+gap),end:t0+i*(each+gap)+each}));
const moment=(k:number,start:number,end:number,description:string,changed='')=>({id:`M${String(k).padStart(3,'0')}`,start,end,frame:end-0.5,description,changed,onScreenText:[],subjects:[]});
const moments=(clipHash:string,ms:ReturnType<typeof moment>[])=>({clipHash,provider:'dense' as const,model:'m',promptVersion:'p',every:0.5,moments:ms,costUsd:0,ms:0});

describe('footage against words',()=>{
  test('stems and stop words',()=>{
    expect(stem('charts')).toBe(stem('chart'));
    expect(stem('coding')).toBe(stem('code'));
    expect(terms('And this is the chart, really')).toEqual(['chart']);
  });
  const clip=(id:string,h:string,ms:ReturnType<typeof moment>[]):JobClip=>({ref:clipRefSchema.parse({id,hash:hash(h),name:`${id}.mov`,kind:'video',role:'b-roll',roleSource:'index',duration:60,width:640,height:360,hasAudio:false}),words:[],moments:moments(hash(h),ms)});
  const b1=clip('b1','b',[moment(1,0,10,'A browser shows a video site'),moment(2,10,20,'A browser shows a bell curve chart of salaries'),moment(3,20,30,'A browser shows a search page')]);
  test('the entry holding the rare words comes first; a word every entry has counts for little',()=>{
    const hits=rankFootage([b1],'look at the bell curve in the browser');
    expect(hits[0]!.id).toBe('M002');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score*2);
    expect(hits[0]!.shared).toContain(stem('bell'));
  });
  test('nothing shared, nothing claimed',()=>{
    expect(rankFootage([b1],'my grandmother baked bread')).toEqual([]);
  });
});

describe('a clip recorded with the speaker',()=>{
  const words=say('so here is the feed and now look at this chart it shows the whole story of pay. that is the point of it all.',1,0.4,0.1);
  const speaker:JobClip={ref:clipRefSchema.parse({id:'c1',hash:hash('a'),name:'cam.mov',kind:'video',role:'a-roll',roleSource:'index',duration:30,width:640,height:360,hasAudio:true}),words};
  const screen:JobClip={ref:clipRefSchema.parse({id:'s1',hash:hash('b'),name:'screen.mov',kind:'video',role:'screen',roleSource:'index',duration:30,width:640,height:400,hasAudio:false}),words:[],
    moments:moments(hash('b'),[moment(1,0,5,'A video feed'),moment(2,5,9,'A chart of pay','Switched to a chart'),moment(3,9,30,'The chart, held','None.')])};
  const job:Job={id:'j',name:'J',style:styleOf(undefined),clips:[speaker,screen],sync:[{clip:'s1',with:'c1',offset:0}]};

  test('each change under kept speech, at its second of the cut and its word',()=>{
    const doc=buildCut(job,[{clip:'c1',from:0,to:words.length-1}]);
    const text=screenActivity(job,doc);
    expect(text).toContain('1 changes under kept speech, 0 of them on screen');
    expect(text).toMatch(/word \d+ "\w+" M002: Switched to a chart \| not shown/);
    // "None." is the model saying the picture held: not a change to cut on.
    expect(text).not.toContain('M003');
  });
  test('a change cut out of the speech is not listed; one the cut shows is marked shown',()=>{
    const late=words.findIndex(w=>w.start>9.5);
    expect(screenActivity(job,buildCut(job,[{clip:'c1',from:late,to:words.length-1}]))).toContain('0 changes under kept speech');
    const at=words.findIndex(w=>w.start>=4.4);
    const doc=buildCut(job,[{clip:'c1',from:0,to:words.length-1}],{broll:[{id:'x',broll:'s1',seconds:4,clip:'c1',word:at,sync:true,reason:'t'}]});
    expect(screenActivity(job,doc)).toContain('1 of them on screen');
  });
  test('what it showed while a stretch of words was said',()=>{
    const lines=shownMeanwhile(job,'c1',5.5,8).join('\n');
    expect(lines).toContain('M002');
    expect(lines).not.toContain('M001');
  });

  describe('in the agent tools',()=>{
    const mk=(grey:(k:number)=>Uint8Array,asked:{times:number[]}[]=[]):Workspace=>({dir:mkdtempSync(join(tmpdir(),'screen-test-')),job,
      segments:[],placements:[],captions:[],zooms:[],broll:[],text:[],chapters:[],graphics:{},graphicsEnabled:false,
      frames:{filmstrip:async()=>new Uint8Array(),joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:'no'}),
        frames:async(_c,ts)=>{asked.push({times:ts});return ts.map((_,k)=>grey(k));}} as FrameHost});
    const run=(ws:Workspace,name:string,args:Record<string,unknown>={})=>editorTools(ws).find(t=>t.name===name)!.run(args);
    const all={segments:[{clip:'c1',from:0,to:words.length-1}]};
    const shot={id:'chart',footage:'s1',clip:'c1',word:10,seconds:4,sync:true,reason:'the chart'};

    test('find_footage with "said" leads with what the synced clip showed then',async()=>{
      const ws=mk(()=>new Uint8Array());
      const from=words.findIndex(w=>w.start>=5.5),to=words.findIndex(w=>w.start>=8);
      const text=(await run(ws,'find_footage',{said:{clip:'c1',from,to}})).text!;
      expect(text).toContain('on s1 while these words were said');
      expect(text).toContain('M002');
    });
    test('screen_activity needs a cut, then lists the changes; the cut report points at it',async()=>{
      const ws=mk(()=>new Uint8Array());
      await expect(run(ws,'screen_activity')).rejects.toThrow();
      expect((await run(ws,'set_cut',all)).text).toContain('screen_activity');
      expect((await run(ws,'screen_activity')).text).toContain('M002');
    });
    test('a shot that cannot be read keeps the whole frame; crop "full" asks for no frames',async()=>{
      const asked:{times:number[]}[]=[];
      // Not JPEGs: decoding fails, so no content area is found.
      const ws=mk(()=>new Uint8Array([1,2,3]),asked);
      await run(ws,'set_cut',all);
      const n=asked.length;
      const text=(await run(ws,'show_footage',shot)).text!;
      expect(text).toContain('placed chart');
      expect(text).not.toContain('cropped');
      expect(ws.broll[0]!.crop).toBeUndefined();
      expect(asked.length).toBeGreaterThan(n);
      const m=asked.length;
      await run(ws,'show_footage',{...shot,crop:'full'});
      expect(asked.length).toBe(m);
      expect(ws.broll[0]!.crop).toBeUndefined();
    });
  });
});
