// Clip moments without a model: change detection over grey frames, which
// clips share a clock, footage that stays in step with the voice through
// cuts, and the moments as the agent reads them.
import {describe,expect,test} from 'bun:test';
import {clipRefSchema} from '@voxtale/editdoc';

import {buildCut,styleOf,type Job,type JobClip} from '../src/video/editor/agent/cut';
import {footageText} from '../src/video/editor/agent/footage';
import {editorTools,type Workspace} from '../src/video/editor/agent/tools';
import {changeSpans,denseMoments,syncClips,SAMPLE_H,SAMPLE_W,type ClipMoments} from '../src/video/moments';

const N=SAMPLE_W*SAMPLE_H;

describe('changeSpans',()=>{
  test('finds a small steady change and ignores a busy strip',()=>{
    // 40 frames at 0.5s: a blinking strip (row 0) every frame, a small stroke at frame 20.
    const count=40,px=new Uint8Array(N*count).fill(200);
    for(let i=0;i<count;i++) {
      if(i%2)px.fill(0,i*N,i*N+SAMPLE_W);
      if(i>=20)for(let k=0;k<30;k++)px[i*N+30*SAMPLE_W+k]=20;
    }
    const spans=changeSpans(px,{every:0.5,duration:20});
    expect(spans.map(s=>s.start)).toEqual([0,10]);
    expect(spans[0]!.frame).toBeLessThan(10);
    expect(spans.at(-1)!.end).toBe(20);
  });

  test('splits a long still stretch',()=>{
    const spans=changeSpans(new Uint8Array(N*200).fill(90),{every:0.5,duration:100});
    expect(spans.length).toBe(4);
    expect(Math.max(...spans.map(s=>s.end-s.start))).toBeLessThanOrEqual(30);
  });
});

describe('syncClips',()=>{
  test('pairs a silent video with the speaking clip of the same length',()=>{
    const s=syncClips([
      {id:'c1',kind:'video',role:'a-roll',duration:972.8,hasAudio:true,speaks:true},
      {id:'c2',kind:'video',role:'screen',duration:972.6,hasAudio:false,speaks:false},
      {id:'c3',kind:'video',role:'b-roll',duration:12,hasAudio:false,speaks:false},
      {id:'c4',kind:'video',role:'b-roll',duration:400,hasAudio:false,speaks:false},
    ]);
    expect(s).toEqual([{clip:'c2',with:'c1',offset:0}]);
  });
});

const ref=(id:string,role:'a-roll'|'screen',hash:string,w=1920,h=1080)=>clipRefSchema.parse({id,hash:hash.repeat(64),name:`${id}.mov`,kind:'video',role,roleSource:'index',
  duration:60,width:w,height:h,hasAudio:role==='a-roll'});
const words='one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ')
  .map((text,i)=>({id:i,text,start:2+i*2,end:3+i*2}));
const moments:ClipMoments={clipHash:'b'.repeat(64),provider:'dense',model:'m',promptVersion:'v',every:0.5,costUsd:0,ms:0,moments:[
  {id:'M001',start:0,end:20,frame:19,description:'An article titled Fired at 48',changed:'',onScreenText:['Fired at 48'],subjects:['article']},
  {id:'M002',start:20,end:60,frame:40,description:'A bell curve on a whiteboard',changed:'whiteboard opens',onScreenText:[],subjects:['bell curve']},
]};
const speaker:JobClip={ref:ref('c1','a-roll','a'),words};
const screen:JobClip={ref:ref('c2','screen','b',2940,1912),words:[],moments};
const job:Job={id:'j',name:'J',clips:[speaker,screen],style:styleOf(undefined),sync:[{clip:'c2',with:'c1',offset:0}]};

describe('show footage in step',()=>{
  test('a synced shot shows the source time of each kept stretch',()=>{
    // Keep words 0-4 (2-11s) and 8-14 (18-31s); show the screen from word 3 for 12s.
    const doc=buildCut(job,[{clip:'c1',from:0,to:4},{clip:'c1',from:8,to:14}],
      {broll:[{id:'curve',broll:'c2',clip:'c1',word:3,seconds:12,sync:true,reason:'speaker points at the screen'}]});
    const a=doc.tracks['a-roll'],b=doc.tracks['b-roll'];
    // One piece per kept stretch under it (pause trims split the speaker too).
    expect(b.length).toBeGreaterThan(1);
    expect(b.reduce((n,p)=>n+p.end-p.start,0)).toBeGreaterThan(8);
    for(const p of b) {
      const under=a.find(i=>i.start<=p.start+1e-6&&i.end>=p.end-1e-6)!;
      expect(p.in).toBeCloseTo(under.in+(p.start-under.start),3);
      expect(p.fit).toBe('contain');
    }
    for(let k=1;k<b.length;k++)expect(b[k]!.in).toBeGreaterThanOrEqual(b[k-1]!.out-1e-6);
  });

  test('two shots of the same screen need the face between them',async()=>{
    const ws:Workspace={dir:`${process.env.TMPDIR??'/tmp'}/face-gap-${Date.now()}`,job,segments:[{clip:'c1',from:0,to:19}],placements:[],captions:[],zooms:[],broll:[],text:[],chapters:[],graphics:{},graphicsEnabled:false,
      frames:{filmstrip:async()=>new Uint8Array(),joins:async()=>new Uint8Array(),frames:async(_c:string,ts:number[])=>ts.map(()=>null),graphic:async()=>({ok:false,report:''})}};
    await (await import('node:fs/promises')).mkdir(ws.dir,{recursive:true});
    const show=editorTools(ws).find(t=>t.name==='show_footage')!;
    const shot=(id:string,word:number)=>show.run({id,footage:'c2',clip:'c1',word,seconds:6,sync:true,reason:'r'});
    await shot('one',3);
    // One covers words 3-7; two straight after it would chain the screen into one long hold.
    await expect(shot('two',8)).rejects.toThrow('back to the speaker');
    expect(ws.broll.map(b=>b.id)).toEqual(['one']);
    await shot('two',10);
    expect(ws.broll.map(b=>b.id)).toEqual(['one','two']);
  });

  test('an unsynced shot plays from in',()=>{
    const doc=buildCut(job,[{clip:'c1',from:0,to:14}],{broll:[{id:'cut',broll:'c2',in:30,clip:'c1',word:5,seconds:4,reason:'r'}]});
    expect(doc.tracks['b-roll']).toMatchObject([{id:'b-cut',in:30,out:34}]);
  });
});

describe('zoom on stressed lines',()=>{
  // Words 0-4 and 8-14 of one clip: the second segment starts on a jump cut.
  const segs=[{clip:'c1',from:0,to:4},{clip:'c1',from:8,to:14}];
  const punches=(zooms?:{clip:string;from:number;to:number;why?:string}[])=>
    buildCut(job,segs,zooms?{zooms}:{}).tracks.zoom.filter(z=>z.scale>1.1);
  test('without stressed lines a jump cut punches in',()=>{
    expect(punches().length).toBeGreaterThan(0);
  });
  test('given stressed lines, only those punch in',()=>{
    expect(punches([])).toEqual([]);
    const z=punches([{clip:'c1',from:10,to:11,why:'the number'}]);
    // Pause trims split the line into pieces; each piece of it zooms, nothing else does.
    expect(z.length).toBeGreaterThan(0);
    for(const x of z)expect(x.reason).toContain('the number');
  });
});

describe('footageText',()=>{
  test('lists moments with the shared clock and keeps a window',()=>{
    const all=footageText([screen],{},job);
    expect(all).toContain('recorded with c1: same clock');
    expect(all).toContain('M002 20.0-60.0s');
    const early=footageText([screen],{end:10},job);
    expect(early).toContain('M001');
    expect(early).not.toContain('M002');
    expect(footageText([screen],{query:'bell curve'},job)).not.toContain('M001');
  });
});

describe('denseMoments',()=>{
  test('describes each span and keeps code-owned times',async()=>{
    const px=new Uint8Array(N*40).fill(200);
    for(let i=20;i<40;i++)px.fill(0,i*N,i*N+N/4);
    const frames={sample:async()=>px,frames:async(_:string,ts:number[])=>ts.map(()=>new Uint8Array([1])),
      filmstrip:async()=>new Uint8Array(),joins:async()=>new Uint8Array(),graphic:async()=>({ok:false,report:''})};
    const seen:string[]=[];
    const r=await denseMoments({hash:'b'.repeat(64),duration:20,words:[{text:'look',start:11,end:11.4}],frames},async(_s,parts)=>{
      const ids=parts.flatMap(p=>p.type==='text'?[p.text]:[]);
      seen.push(...ids);
      return {model:'fake',json:{moments:ids.map(t=>({id:t.slice(0,4),description:`frame ${t.slice(0,4)}`,changed:'',onScreenText:[],subjects:[]}))}};
    });
    expect(r.moments.map(m=>[m.start,m.end])).toEqual([[0,10],[10,20]]);
    expect(r.moments[1]!.description).toBe('frame M002');
    expect(seen[1]).toContain('words: look');
  });
});
