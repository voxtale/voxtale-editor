// Auto reframe and title motion tracking: path math, schema v8, the render's
// filters and ASS, and the two calls with fake finders. No footage, no network.
import {describe,expect,it} from 'bun:test';
import {
  EDITDOC_VERSION,STYLE_PRESETS,canvasFor,canvasToSource,cropWidth,newEditDoc,parseAspect,parseEditDoc,reframeFromFrames,reframeLeft,
  smoothCenters,sourceToCanvas,trackAt,trackFromFrames,trackStale,upgradeEditDoc,type ClipRef,type EditDoc,type SubjectFrame,type TrackFrame,
} from '@voxtale/editdoc';
import {assScript,pictureFilter,planRender,trackOverlay,type RenderPlan} from '../src/video/render-edit';
import {joinReframes,reframePath,shownSpans} from '../src/video/reframe';
import {planTrack,trackItem} from '../src/video/track-motion';
import {withMotionTracks} from '../src/video/editor/agent/cut';
import type {NativeSubjectRow} from '../src/native/bridge';

const fps={num:30,den:1};
const hash=(c:string)=>c.repeat(64);
const clip=(id:string,c:string,over:Partial<ClipRef>={}):ClipRef=>({id,hash:hash(c),name:`${id}.mp4`,kind:'video',role:'a-roll',roleSource:'creator',
  duration:20,fps,hasAudio:true,timecodeStart:0,width:1920,height:1080,...over});

function doc(over:Record<string,unknown>={},canvas={width:1920,height:1080},clips=[clip('cam','a')]):EditDoc {
  const d=newEditDoc({id:'e',name:'t',clips,fps,style:STYLE_PRESETS.tutorial});
  return parseEditDoc({...d,canvas,tracks:{...d.tracks,'a-roll':[{id:'a1',clipId:'cam',in:2,out:8,start:0,end:6,owner:'agent'}],...over}}).doc;
}

describe('reframe path',()=>{
  it('holds still through small moves and follows a big one',()=>{
    const frames:SubjectFrame[]=Array.from({length:50},(_,k)=>[k*0.2,(k<25?0.3:0.7)+(k%2?0.005:-0.005),0.4,0.1,0.2]);
    const xs=smoothCenters(frames,'default')!;
    expect(Math.max(...xs.slice(0,15))-Math.min(...xs.slice(0,15))).toBeLessThan(1e-6);
    expect(xs[0]).toBeCloseTo(0.3,1);
    expect(xs.at(-1)).toBeCloseTo(0.7,1);
    for(let k=1;k<xs.length;k++)expect(Math.abs(xs[k]!-xs[k-1]!)).toBeLessThan(0.15);
    const r=reframeFromFrames(frames)!;
    expect(r.keys.length).toBeLessThan(frames.length);
    expect(r.keys[0]!.t).toBe(0);
  });
  it('fills gaps and gives null when nobody shows',()=>{
    expect(reframeFromFrames([[0,null,null,null,null],[0.2,null,null,null,null]])).toBeNull();
    const xs=smoothCenters([[0,null,null,null,null],[0.2,0.6,0.5,0.1,0.1],[0.4,null,null,null,null]],'faster')!;
    expect(xs.every(x=>Math.abs(x-0.6)<1e-6)).toBe(true);
  });
  it('clamps the crop inside the frame',()=>{
    const w=cropWidth({width:1920,height:1080},{width:1080,height:1920});
    expect(w).toBeCloseTo(0.3164,3);
    const r={speed:'default' as const,keys:[{t:0,x:0.02},{t:10,x:0.98}]};
    expect(reframeLeft(r,0,w)).toBe(0);
    expect(reframeLeft(r,10,w)).toBeCloseTo(1-w,6);
    expect(reframeLeft(r,5,w)).toBeCloseTo(0.5-w/2,6);
    expect(cropWidth({width:1920,height:1080},{width:1920,height:1080})).toBe(1);
  });
  it('makes canvases from aspects',()=>{
    expect(parseAspect('9:16')).toBeCloseTo(0.5625);
    expect(()=>parseAspect('tall')).toThrow();
    expect(canvasFor({width:1920,height:1080},9/16)).toEqual({width:1080,height:1920});
    expect(canvasFor({width:1920,height:1080},1)).toEqual({width:1920,height:1920});
  });
  it('reframePath: keys from the fake finder, crop and travel',async()=>{
    const subject=async()=>({frames:Array.from({length:40},(_,k)=>[k*0.2,k<20?0.25:0.75,0.4,0.1,0.2,'face'] as NativeSubjectRow)});
    const p=await reframePath({path:'/x.mp4',width:1920,height:1080},{from:0,to:8},'9:16',{subject});
    expect(p.faces).toBe(40);
    expect(p.width).toBeCloseTo(0.3164,3);
    expect(p.moved).toBeGreaterThan(800);
    expect(p.crop.every(c=>c.left>=0&&c.left<=1-p.width+1e-4)).toBe(true);
  });
  it('spans and joins',()=>{
    const d=doc({'a-roll':[{id:'a1',clipId:'cam',in:2,out:4,start:0,end:2,owner:'agent'},{id:'a2',clipId:'cam',in:4.5,out:6,start:2,end:3.5,owner:'agent'},{id:'a3',clipId:'cam',in:12,out:14,start:3.5,end:5.5,owner:'agent'}]});
    expect(shownSpans(d,'cam')).toEqual([{from:2,to:6},{from:12,to:14}]);
    expect(joinReframes([null,{speed:'slower',keys:[{t:12,x:0.4}]},{speed:'default',keys:[{t:2,x:0.5}]}])).toEqual({speed:'slower',keys:[{t:2,x:0.5},{t:12,x:0.4}]});
    expect(joinReframes([null])).toBeNull();
  });
});

describe('schema v8+',()=>{
  it('lifts v7 and keeps reframe and track',()=>{
    expect(EDITDOC_VERSION).toBeGreaterThanOrEqual(8);
    const d=doc();
    expect((upgradeEditDoc({...d,version:7}) as EditDoc).version).toBe(EDITDOC_VERSION);
    const clips=[{...d.clips[0]!,reframe:{speed:'faster',keys:[{t:2,x:0.4}]}}];
    const text=[{id:'t1',start:1,end:3,text:'Hi',template:'title',owner:'agent',track:{clipId:'cam',at:4,anchor:1,point:{x:0.5,y:0.5},keys:[{t:0,dx:0,dy:0}]}}];
    const back=parseEditDoc({...d,clips,tracks:{...d.tracks,text}}).doc;
    expect((back.clips[0] as ClipRef).reframe!.speed).toBe('faster');
    expect(back.tracks.text[0]!.track!.anchor).toBe(1);
  });
});

describe('mapping and tracks',()=>{
  const tall=()=>{
    const d=doc({},{width:1080,height:1920});
    return {...d,clips:[{...d.clips[0]!,reframe:{speed:'default' as const,keys:[{t:2,x:0.3},{t:8,x:0.7}]}}]};
  };
  it('source and canvas round trip under reframe and zoom',()=>{
    const d={...tall(),tracks:{...tall().tracks,zoom:parseEditDoc({...tall(),tracks:{...tall().tracks,zoom:[{id:'z',start:0,end:6,scale:1.3,easeIn:0,easeOut:0,owner:'agent'}]}}).doc.tracks.zoom}};
    const piece=d.tracks['a-roll'][0]!;
    for(const t of [0.5,3,5.5]) {
      const q=sourceToCanvas(d,piece,t,{x:0.4,y:0.3});
      const p=canvasToSource(d,piece,t,q);
      expect(p.x).toBeCloseTo(0.4,6);expect(p.y).toBeCloseTo(0.3,6);
    }
    // The speaker's centre sits mid-frame while the crop follows them.
    expect(sourceToCanvas(tall(),piece,3,{x:0.5,y:0.5}).x).toBeCloseTo(0.5,3);
  });
  it('trackFromFrames: offsets from the anchor, keys cut down, stale on recut',()=>{
    const d=doc();
    const piece=d.tracks['a-roll'][0]!,item={id:'t1',start:1,end:4};
    // Source seconds 2..8; item 1..4 output = 3..6 source. The spot pans left 0.01 a frame-step of 0.1s.
    const frames:TrackFrame[]=Array.from({length:31},(_,k)=>[3+k*0.1,0.6-k*0.01,0.5,1,0]);
    const tr=trackFromFrames(d,item,piece,frames,2,{x:0.6,y:0.5});
    expect(tr.anchor).toBe(1);expect(tr.at).toBe(4);
    expect(tr.keys.length).toBeLessThanOrEqual(3);
    expect(trackAt(tr,1).dx).toBeCloseTo(0,4);
    expect(trackAt(tr,0).dx).toBeCloseTo(0.1,3);
    expect(trackAt(tr,3).dx).toBeCloseTo(-0.2,3);
    expect(tr.keys[0]!.s).toBeUndefined();
    expect(trackStale(d,{start:1,track:tr})).toBeNull();
    const moved={...d,tracks:{...d.tracks,'a-roll':[{...piece,in:5,out:11}]}};
    expect(trackStale(moved,{start:1,track:tr})).toMatch(/moved/);
    const text=[{id:'t1',start:1,end:4,text:'Hi',template:'title' as const,owner:'agent' as const}];
    const withText=parseEditDoc({...d,tracks:{...d.tracks,text}}).doc;
    expect(withMotionTracks(withText,{t1:tr}).tracks.text[0]!.track).toEqual(tr);
    expect(withMotionTracks({...withText,tracks:{...withText.tracks,'a-roll':[{...piece,in:5,out:11}]}},{t1:tr}).tracks.text[0]!.track).toBeUndefined();
  });
  it('planTrack refuses what cannot be followed; trackItem with a fake tracker',async()=>{
    const text=[{id:'t1',start:1,end:4,text:'Hi',template:'title',owner:'agent'}];
    const d=doc({text});
    expect(()=>planTrack(d,'nope',{x:0.5,y:0.5})).toThrow(/no text or graphic/);
    const plan=planTrack(d,'t1',{x:0.5,y:0.5});
    expect(plan).toMatchObject({from:3,to:6,at:4.5,partial:false});
    const tracker=async(o:{start:number;end:number})=>({frames:Array.from({length:Math.round((o.end-o.start)*10)+1},(_,k)=>[o.start+k*0.1,0.5,0.5+k*0.002,1+k*0.01,0] as TrackFrame)});
    const r=await trackItem(d,'t1','/x.mp4',{point:{x:0.5,y:0.5},tracker});
    expect(r.scale[1]).toBeGreaterThan(1.1);
    expect(r.moved).toBeGreaterThan(30);
  });
});

describe('render',()=>{
  const plan={width:1080,height:1920,rate:'30',fps:30} as RenderPlan;
  it('reframe crops along the path; plain cover stays centred',()=>{
    const d=doc({},{width:1080,height:1920});
    const withPath={...d,clips:[{...d.clips[0]!,reframe:{speed:'default' as const,keys:[{t:2,x:0.3},{t:8,x:0.7}]}}]};
    const p=planRender(withPath,{[hash('a')]:'/cam.mp4'}).pictures[0]!;
    expect(p.reframe?.keys.length).toBe(2);
    const f=pictureFilter(p,0,180,plan);
    expect(f).toContain("crop=1080:1920:x='clip(iw*(");
    expect(f).toContain('-1080/2,0,iw-1080)');
    const plain=pictureFilter(planRender(d,{[hash('a')]:'/cam.mp4'}).pictures[0]!,0,180,plan);
    expect(plain).toContain('crop=1080:1920,');
  });
  it('a tracked text moves (\\move) per key stretch and scales; fades only at the ends',()=>{
    const track={clipId:'cam',at:3,anchor:0,point:{x:0.5,y:0.5},keys:[{t:0,dx:0,dy:0,s:1},{t:1,dx:0.1,dy:0,s:1.2},{t:2,dx:0.2,dy:0.05,s:1.2}]};
    const text=[{id:'t1',start:1,end:3,text:'Hi',template:'title',owner:'agent',fadeIn:0.2,fadeOut:0.3,track}];
    const ass=assScript(doc({text}),30);
    const lines=ass.split('\n').filter(l=>l.startsWith('Dialogue:')&&l.includes('Hi'));
    expect(lines.length).toBe(2);
    expect(lines.every(l=>l.includes('\\move('))).toBe(true);
    expect(lines[0]).toContain('\\fad(200,0)');
    expect(lines[1]).toContain('\\fad(0,300)');
    expect(lines[0]).toContain('\\t(0,1000,\\fscx120.0');
    const still=assScript(doc({text:[{...text[0],track:undefined}]}),30);
    expect(still).toContain('\\pos(');
  });
  it('a tracked graphic shifts its overlay',()=>{
    const o=trackOverlay({clipId:'cam',at:3,anchor:0,point:{x:0.5,y:0.5},keys:[{t:0,dx:0,dy:0},{t:2,dx:0.1,dy:-0.05}]},'(t-1)',1920,1080);
    expect(o.x).toContain('192');
    expect(o.y).toContain('-54');
  });
});
