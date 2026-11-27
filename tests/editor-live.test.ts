// Finished-live → 9:16 clips: transcript pieces, signals, candidates, the
// scan with fakes, layout detection, the v9 stack in cut, render, export and
// checks. No footage, no network, no model.
import {describe,expect,it} from 'bun:test';
import {mkdtemp,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildExportTimeline,checkEditDoc,EDITDOC_VERSION,newEditDoc,parseEditDoc,STYLE_PRESETS,stackBoxes,upgradeEditDoc,type ClipRef,type EditDoc} from '@voxtale/editdoc';
import {listPrompts} from '../src/services/prompts';
import {planRender} from '../src/video/render-edit';
import {findCandidates,mergeRatings,ranked,sentenceEdges,windowAround} from '../src/video/live/candidates';
import {sliceTranscript} from '../src/video/live/clip';
import {camFromFace,detectLayout,readLayout,refineBox,stackFor,staticEdges,type Sample} from '../src/video/live/layout';
import {LIVE_LAYOUT_PROMPT_ID,LIVE_PICK_PROMPT_ID,LIVE_SCAN_PROMPT_ID,LIVE_TITLES_PROMPT_ID} from '../src/video/live/prompts';
import {inside,scanLive} from '../src/video/live/scan';
import {chatPeaks,hms,laughPeaks,parseChat,parseLoudness,parseMarkers,perMinute,replayPeaks,seconds,soundPeaks} from '../src/video/live/signals';
import {applyStacks} from '../src/video/live/stack';
import {mergePieces,pieces,transcribeLive,type LiveWord} from '../src/video/live/transcribe';
import {LIVE_SKILL_TEXT} from '../src/video/live/skill-text';

const words=(from:number,to:number,every=1):LiveWord[]=>Array.from({length:Math.floor((to-from)/every)},(_,k)=>({text:k%8===7?'end.':'word',start:from+k*every,end:from+k*every+0.6}));

describe('live transcript pieces',()=>{
  it('one piece for a short live, 30-min pieces with pads for a long one, a sliver joins the last',()=>{
    expect(pieces(1800)).toHaveLength(1);
    const ps=pieces(4*3600+60);
    expect(ps).toHaveLength(8);
    expect(ps.at(-1)!.to).toBe(4*3600+60);
    expect(ps[1]!.readFrom).toBe(1800-5);
    expect(ps[0]!.readTo).toBe(1805);
  });
  it('keeps a word read twice near a seam once',()=>{
    const [a,b]=pieces(3600,{long:100,piece:1800});
    const w={text:'x',start:1799.6-a!.readFrom,end:1800.2-a!.readFrom};
    const merged=mergePieces([{piece:b!,words:[{text:'x',start:1799.6-b!.readFrom,end:1800.2-b!.readFrom}]},{piece:a!,words:[w]}]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.start).toBeCloseTo(1799.6,6);
  });
  it('never sends a piece twice',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'live-'));
    let sent=0;
    const cut=async(_s:string,_f:number,_t:number,out:string)=>{await writeFile(out,'');};
    const transcribe=async(_a:string,out:string)=>{sent++;await writeFile(out,'{}');return {words:[{id:0,text:'hi',start:10,end:10.5,confidence:1}]};};
    const t=await transcribeLive({source:'/live.mp4',duration:7200,dir,id:'abc',cut,transcribe,long:100,piece:1800});
    expect(t.pieces).toBe(4);
    expect(sent).toBe(4);
    expect(t.words.map(w=>Math.round(w.start))).toEqual([10,1805,3605,5405]);
    await transcribeLive({source:'/live.mp4',duration:7200,dir,id:'abc',cut,transcribe,long:100,piece:1800});
    expect(sent).toBe(4);
    expect((await readdir(join(dir,'pieces'))).filter(f=>f.endsWith('.json'))).toHaveLength(4);
  });
});

describe('live signals',()=>{
  it('times both ways',()=>{
    expect(hms(3725)).toBe('1:02:05');
    expect(seconds('1:02:05')).toBe(3725);
    expect(seconds('2:05')).toBe(125);
  });
  it('loud moments over the bar, one per 20 s',()=>{
    const levels=parseLoudness(Array.from({length:300},(_,i)=>`lavfi.astats.Overall.RMS_level=${i===100||i===101?-5:-30}`).join('\n'));
    expect(levels).toHaveLength(300);
    const s=soundPeaks(levels);
    expect(s).toHaveLength(1);
    expect(s[0]!.t).toBe(200);
  });
  it('reads Twitch, chat-downloader, YouTube and plain chat',()=>{
    expect(parseChat(JSON.stringify({comments:[{content_offset_seconds:12,commenter:{display_name:'a'},message:{body:'KEKW'}}]}))[0]).toEqual({t:12,author:'a',text:'KEKW'});
    expect(parseChat(JSON.stringify([{time_in_seconds:5,author:{name:'b'},message:'hey'}]))[0]!.t).toBe(5);
    const yt=JSON.stringify({replayChatItemAction:{videoOffsetTimeMsec:'61000',actions:[{addChatItemAction:{item:{liveChatTextMessageRenderer:{authorName:{simpleText:'c'},message:{runs:[{text:'lol'}]}}}}}]}});
    expect(parseChat(`${yt}\n${yt}`)).toHaveLength(2);
    expect(parseChat('[1:00:05] dan: what a play')[0]).toEqual({t:3605,author:'dan',text:'what a play'});
  });
  it('chat spikes and laughter',()=>{
    const chat=[...Array.from({length:600},(_,i)=>({t:i*6,text:i%10?'hi':'lol'})),...Array.from({length:40},(_,i)=>({t:1200+i,text:'LUL'}))];
    const per=perMinute(chat);
    expect(chatPeaks(per).map(s=>s.t)).toEqual([1200]);
    const laughs=laughPeaks([{text:'haha',start:300,end:300.5},{text:'(laughs)',start:301,end:302}],chat);
    expect(laughs.some(s=>s.t===300&&s.note.includes('streamer'))).toBe(true);
    expect(laughs.some(s=>s.note.includes('chat'))).toBe(true);
  });
  it('markers and most replayed',()=>{
    expect(parseMarkers('1:00:00 boss down\n2:30 clutch').map(m=>m.t)).toEqual([3600,150]);
    expect(parseMarkers(JSON.stringify([{start_time:90,title:'intro'}]))[0]).toMatchObject({t:90,note:'intro'});
    expect(replayPeaks([{start_time:0,end_time:10,value:1},{start_time:10,end_time:20,value:0.7},{start_time:20,end_time:30,value:0.2}]).map(s=>s.t)).toEqual([10]);
  });
});

describe('live candidates',()=>{
  const duration=3*3600,ws=words(0,duration,2);
  it('signals rank windows; every 20-min block gets a look; windows 15-90 s',()=>{
    const cs=findCandidates(ws,[{t:5000,kind:'marker',weight:1,note:'clutch'},{t:9000,kind:'chat',weight:1,note:'chat ×4'}],duration,{top:5});
    expect(cs.length).toBeGreaterThanOrEqual(9);
    const best=ranked(cs)[0]!;
    expect(best.cues).toContain('marker');
    expect(best.start).toBeLessThan(5000);expect(best.end).toBeGreaterThan(5000);
    for(const c of cs){expect(c.end-c.start).toBeGreaterThanOrEqual(15-1e-6);expect(c.end-c.start).toBeLessThanOrEqual(90+1e-6);}
  });
  it('windows snap to sentence edges',()=>{
    const s=sentenceEdges([{text:'a',start:0,end:1},{text:'b.',start:1,end:2},{text:'c',start:10,end:11}]);
    expect(s).toEqual([[0,2],[10,11]]);
    const [a,b]=windowAround(100,[[75,85],[120,130]],1000);
    expect(a).toBe(75);expect(b).toBe(130);
  });
  it('ratings merge; bad bounds are refused',()=>{
    const cs=findCandidates(ws,[],duration,{top:3});
    const id=cs[0]!.id,other=cs[1]!.id;
    const m=mergeRatings(cs,[{id,rating:9,start:cs[0]!.start+1,end:cs[0]!.start+31,what:'w'},{id:other,rating:12,start:0,end:500}],duration);
    expect(m[0]).toMatchObject({rating:9,what:'w',end:cs[0]!.start+31});
    expect(m[1]).toMatchObject({rating:10,start:cs[1]!.start,end:cs[1]!.end});
  });
  it('moves an answer in the wrong hour back',()=>{
    expect(inside({start:1690,end:1720},6*3600+1680,6*3600+1740)).toEqual({start:6*3600+1690,end:6*3600+1720});
    expect(inside({start:10,end:20},50000,50100)).toBeNull();
  });
  it('scanLive: fakes only, saved and reused, the model pass rates windows',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'live-scan-'));
    const transcribe=async(_a:string,out:string)=>{await writeFile(out,'{}');return {words:words(0,3600,2).map((w,id)=>({...w,id,confidence:1}))};};
    const source=join(dir,'live.mp4');await writeFile(source,'not video');
    const o={source,duration:3600,dir,cut:async(_s:string,_f:number,_t:number,out:string)=>{await writeFile(out,'');},transcribe,levels:async()=>Array(1800).fill(-30)};
    await writeFile(join(dir,'markers.txt'),'0:30:00 big moment');
    const a=await scanLive({...o,markers:join(dir,'markers.txt'),top:5});
    expect(a.rated).toBe(false);
    expect(a.candidates.some(c=>c.cues.includes('marker'))).toBe(true);
    let calls=0;
    const ask=async(_s:string,input:unknown)=>{calls++;const text=(input as {windows:string}).windows;
      return {ratings:[...text.matchAll(/^## (w\d+)/gm)].map(m=>({id:m[1]!,rating:5,start:'0:00:00',end:'0:00:01',what:'x',why:'y'}))};};
    const b=await scanLive({...o,ask});
    expect(calls).toBeGreaterThan(0);
    expect(b.rated).toBe(true);
    expect(b.candidates.every(c=>c.rating===5)).toBe(true);
    expect(b.candidates.map(c=>c.id).sort()).toEqual(a.candidates.map(c=>c.id).sort());
    await scanLive({...o,ask});
    expect(calls).toBe(Math.ceil(a.candidates.length/15));
  });
  it('slices the live transcript onto the clip clock',()=>{
    const t=sliceTranscript(words(0,200,2),100,130,{source:'/c.mp4',sourceHash:'h'.repeat(64),duration:30,id:'x'});
    expect(t.words[0]!.start).toBe(0);
    expect(t.words.every(w=>w.end<=30)).toBe(true);
    expect(t.words.map(w=>w.id)).toEqual(t.words.map((_,i)=>i));
  });
});

describe('live layout',()=>{
  it('a small face is a webcam box pulled to the edge',()=>{
    const b=camFromFace({x:0.1,y:0.12,w:0.06,h:0.1});
    expect(b.x).toBe(0);expect(b.y).toBe(0);
    expect(b.w).toBeGreaterThan(0.15);
  });
  it('refines a box onto a still border',()=>{
    const W=160,H=90,make=(seed:number)=>{
      const d=new Uint8Array(W*H);
      for(let y=0;y<H;y++)for(let x=0;x<W;x++)d[y*W+x]=x<48&&y<30?200:(x*7+y*13+seed*31)%97;
      return {width:W,height:H,data:d};
    };
    const e=staticEdges([make(1),make(2),make(3),make(4)])!;
    const r=refineBox({x:0,y:0,w:0.25,h:0.28},e);
    expect(r.w).toBeCloseTo(48/160,1);
    expect(r.h).toBeCloseTo(30/90,1);
  });
  it('detects stack, a corner change, full screen, game; flickers smoothed',()=>{
    const s:Sample[]=[];
    for(let i=0;i<10;i++)s.push({t:i*2,face:i===4?null:{x:0.1,y:0.12,w:0.06,h:0.1}});
    for(let i=10;i<20;i++)s.push({t:i*2,face:{x:0.9,y:0.85,w:0.06,h:0.1}});
    for(let i=20;i<26;i++)s.push({t:i*2,face:{x:0.5,y:0.4,w:0.25,h:0.4}});
    for(let i=26;i<32;i++)s.push({t:i*2,face:null});
    const p=detectLayout(s);
    expect(p.map(x=>x.layout)).toEqual(['stack','stack','full','game']);
    expect(p.map(x=>x.from)).toEqual([0,20,40,52]);
    if(p[1]!.layout==='stack')expect(p[1]!.facecam.x).toBeGreaterThan(0.6);
    expect(detectLayout([])).toEqual([{from:0,layout:'game',x:0.5}]);
  });
  it('reads the agent\'s list: split as stack, bad parts dropped, first from 0',()=>{
    const l=readLayout([{from:3,layout:'split',facecam:{x:0,y:0,w:0.3,h:0.3}},{from:10,layout:'game',x:2},{from:12,layout:'stack',facecam:{x:0.9,y:0,w:0.3,h:0.3}},{from:15,layout:'zoom'}]);
    expect(l).toEqual([{from:0,layout:'stack',facecam:{x:0,y:0,w:0.3,h:0.3}},{from:10,layout:'game',x:0.5}]);
    expect(readLayout('nope')).toEqual([{from:0,layout:'game',x:0.5}]);
  });
  it('stack: band from the box shape, game beside the webcam',()=>{
    const st=stackFor({x:0,y:0,w:0.25,h:0.25},{width:1920,height:1080});
    expect(st.split).toBeGreaterThanOrEqual(0.25);expect(st.split).toBeLessThanOrEqual(0.5);
    expect(st.bottom.x).toBeGreaterThanOrEqual(0.25-1e-6);
    expect(st.bottom.x+st.bottom.w).toBeLessThanOrEqual(1+1e-6);
    const r=stackFor({x:0.75,y:0.7,w:0.25,h:0.3},{width:1920,height:1080});
    expect(r.bottom.x+r.bottom.w).toBeLessThanOrEqual(0.75+1e-6);
  });
});

describe('EditDoc v9 stack',()=>{
  const fps={num:30,den:1};
  const clip:ClipRef={id:'c1',hash:'a'.repeat(64),name:'c1.mp4',kind:'video',role:'a-roll',roleSource:'creator',duration:30,fps,hasAudio:true,timecodeStart:0,width:1920,height:1080};
  const stack={top:{x:0,y:0,w:0.25,h:0.25},bottom:{x:0.3,y:0,w:0.3,h:1},split:0.35};
  const doc=(items:unknown[]):EditDoc=>{const d=newEditDoc({id:'e',name:'t',clips:[clip],fps,style:STYLE_PRESETS.tutorial});
    return parseEditDoc({...d,canvas:{width:1080,height:1920},tracks:{...d.tracks,'a-roll':items}}).doc;};
  it('is version 9 and lifts v8',()=>{
    expect(EDITDOC_VERSION).toBe(9);
    const d=doc([{id:'a1',clipId:'c1',in:0,out:10,start:0,end:10,owner:'agent'}]);
    expect((upgradeEditDoc({...d,version:8}) as EditDoc).version).toBe(9);
  });
  it('applyStacks splits at span edges and keeps fades on the ends',()=>{
    const d=doc([{id:'a1',clipId:'c1',in:2,out:12,start:0,end:10,owner:'agent',fadeIn:0.2,fadeOut:0.3}]);
    const out=applyStacks(d,{c1:[{from:5,to:9,stack}]});
    const a=out.tracks['a-roll'];
    expect(a.map(i=>[i.start,i.end,i.layout??null])).toEqual([[0,3,null],[3,7,'stack'],[7,10,null]]);
    expect(a[0]!.fadeIn).toBe(0.2);expect(a[2]!.fadeOut).toBe(0.3);expect(a[1]!.fadeIn).toBeUndefined();
    expect(a.map(i=>i.id)).toEqual(['a1-l1','a1-l2','a1-l3']);
    expect(checkEditDoc(parseEditDoc(out).doc).filter(i=>i.severity==='error')).toEqual([]);
  });
  it('a stack without regions is an error',()=>{
    const d=doc([{id:'a1',clipId:'c1',in:0,out:10,start:0,end:10,owner:'agent'}]);
    const bad={...d,tracks:{...d.tracks,'a-roll':[{...d.tracks['a-roll'][0]!,layout:'stack' as const}]}};
    expect(checkEditDoc(bad).some(i=>i.severity==='error'&&i.path.endsWith('.stack'))).toBe(true);
  });
  it('render: two bands from one picture, no border, no zoom',()=>{
    const d=doc([{id:'a1',clipId:'c1',in:0,out:10,start:0,end:10,owner:'agent',layout:'stack',stack}]);
    const plan=planRender(d,{[clip.hash]:'/c1.mp4'});
    const ps=plan.pictures.filter(p=>p.path==='/c1.mp4');
    expect(ps.map(p=>p.itemId)).toEqual(['a1','a1.stack']);
    const [top,bottom]=stackBoxes(d.canvas,0.35);
    expect(ps[0]!.box).toEqual(top);expect(ps[1]!.box).toEqual(bottom);
    expect(ps.every(p=>p.band&&p.zoom.length===0)).toBe(true);
    // Each crop matches its band's shape.
    for(const [p,b] of [[ps[0]!,top],[ps[1]!,bottom]] as const)expect(p.crop!.w*1920/(p.crop!.h*1080)).toBeCloseTo(b.width/b.height,2);
  });
  it('export: the main clip on top, a .stack clip below',()=>{
    const d=doc([{id:'a1',clipId:'c1',in:0,out:10,start:0,end:10,owner:'agent',layout:'stack',stack}]);
    const t=buildExportTimeline(d,{clipPath:()=>'/c1.mp4',graphicPath:()=>undefined});
    const all=JSON.stringify(t);
    expect(all).toContain('a1.stack');
    expect(all).toContain('"layout":"stack"');
  });
});

describe('live prompts and skill text',()=>{
  it('registers the four prompts',()=>{
    const ids=listPrompts().map(p=>p.id);
    for(const id of [LIVE_SCAN_PROMPT_ID,LIVE_PICK_PROMPT_ID,LIVE_LAYOUT_PROMPT_ID,LIVE_TITLES_PROMPT_ID])expect(ids).toContain(id);
    expect([LIVE_SCAN_PROMPT_ID,LIVE_PICK_PROMPT_ID,LIVE_LAYOUT_PROMPT_ID,LIVE_TITLES_PROMPT_ID]).toEqual(['live.scan','live.pick','live.layout','live.titles']);
  });
  it('skill text names the live tools',()=>{
    for(const t of ['live_scan','live_candidates','live_rate','live_make_clip','live_layout'])expect(LIVE_SKILL_TEXT).toContain(t);
  });
});
