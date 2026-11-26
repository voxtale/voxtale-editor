// Last REDACTED gaps: proxy shapes, A/V check at open, templates, logo, cut-out stills, D-Log M. Pure parts, no ffmpeg.
import {describe,expect,it} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makerLut,proxyFits,proxyToSource} from '../src/video/footage-media';
import {avCheckOn,avOffsetNote} from '../src/video/editor/local-mcp/project';

describe('proxy frame sizes (60q)',()=>{
  it('accepts a 720p copy of 4K and of odd-sized phone video',()=>{
    expect(proxyFits({width:3840,height:2160},{width:1280,height:720})).toBe(true);
    expect(proxyFits({width:1080,height:1920},{width:406,height:720})).toBe(true);
    expect(proxyFits({width:2704,height:1520},{width:1280,height:720})).toBe(true);
  });
  it('refuses a copy turned the other way or squashed',()=>{
    expect(proxyFits({width:1080,height:1920},{width:1280,height:720})).toBe(false);
    expect(proxyFits({width:3840,height:2160},{width:960,height:720})).toBe(false);
    expect(proxyFits({width:0,height:0},{width:1280,height:720})).toBe(false);
  });
  it('maps proxy pixels to the original, each axis on its own',()=>{
    expect(proxyToSource({x:640,y:360,w:100,h:50},{width:1280,height:720},{width:3840,height:2160})).toEqual({x:1920,y:1080,w:300,h:150});
    expect(proxyToSource({x:10,y:20},{width:1280,height:720},{width:2560,height:1440})).toEqual({x:20,y:40});
  });
});

describe('A/V offset at open (c7h)',()=>{
  it('is on by default and off by option or env',()=>{
    expect(avCheckOn(undefined,undefined)).toBe(true);
    expect(avCheckOn(false,undefined)).toBe(false);
    expect(avCheckOn(undefined,'0')).toBe(false);
  });
  it('says nothing under one frame or without a match',()=>{
    expect(avOffsetNote('c1',null,30)).toBeUndefined();
    expect(avOffsetNote('c1',{offset:0.02,confidence:5},30)).toBeUndefined();
  });
  it('reports a frame or more, with the fix',()=>{
    const s=avOffsetNote('c1',{offset:0.2,confidence:4.2},25)!;
    expect(s).toContain('200ms ahead');
    expect(s).toContain('set_av_offset c1');
    expect(avOffsetNote('c2',{offset:-0.04,confidence:6},25)).toContain('behind');
  });
});

describe('DJI D-Log M (bq4)',()=>{
  it('finds the fetched maker LUT, nothing when absent or for formula profiles',()=>{
    const d=mkdtempSync(join(tmpdir(),'luts-'));
    expect(makerLut('DJI D-Log M',d)).toBeUndefined();
    writeFileSync(join(d,'DJI D-Log M to Rec.709.cube'),'LUT_3D_SIZE 2\n');
    expect(makerLut('DJI D-Log M',d)).toBe(join(d,'DJI D-Log M to Rec.709.cube'));
    expect(makerLut('Sony S-Log3/S-Gamut3.Cine',d)).toBeUndefined();
    expect(makerLut(undefined,d)).toBeUndefined();
  });
});

describe('brand logo on the cut (jo6.1)',async()=>{
  const {checkEditDoc,clipRefSchema}=await import('@voxtale/editdoc');
  const {buildCut,styleOf}=await import('../src/video/editor/agent/cut');
  const {logoClip,placeLogos}=await import('../src/video/editor/agent/logo');
  const {planRender}=await import('../src/video/render-edit');
  const speaker=clipRefSchema.parse({id:'c1',hash:'a'.repeat(64),name:'c.mov',kind:'video',role:'a-roll',roleSource:'index',duration:60,width:1920,height:1080,hasAudio:true});
  const words='this one habit doubled my income in six months'.split(' ').map((text,i)=>({id:i,text,start:1+i*0.4,end:1.35+i*0.4}));
  const job={id:'j',name:'J',clips:[{ref:speaker,words}],style:styleOf(undefined)};
  const logo=logoClip({hash:'b'.repeat(64),name:'logo.png',width:400,height:200});
  const cut=(items:Parameters<typeof placeLogos>[3])=>buildCut(job,[{clip:'c1',from:0,to:8}],{logo:{ref:logo,items}});

  it('puts a corner logo inside the margin, its height from the image shape',()=>{
    const doc=cut([{id:'mark',size:0.1}]);
    const [l]=doc.logos;
    expect(doc.clips.some(c=>c.id==='brand-logo')).toBe(true);
    expect(l!.start).toBe(0);
    expect(l!.x+l!.w).toBeCloseTo(1-0.04*1080/1920,5);
    expect(l!.y).toBeCloseTo(0.04,5);
    const b=placeLogos(job,doc,logo,[{id:'b',corner:'bottom-left',size:0.2}])[0]!;
    expect(b.y+0.2*1920*0.5/1080).toBeCloseTo(0.96,5);
    expect(checkEditDoc(doc).filter(i=>/Logo/.test(i.message))).toEqual([]);
  });
  it('spans spoken words and drops a span with no length',()=>{
    const doc=cut([{id:'w',size:0.1,from:{clip:'c1',word:2},to:{clip:'c1',word:4}},{id:'none',size:0.1,from:{clip:'c1',word:4},to:{clip:'c1',word:2}}]);
    expect(doc.logos.map(l=>l.id)).toEqual(['logo-w']);
    expect(doc.logos[0]!.end).toBeGreaterThan(doc.logos[0]!.start);
  });
  it('renders as a scaled picture over the footage',()=>{
    const doc=cut([{id:'mark',size:0.1,opacity:0.6}]);
    const pic=planRender(doc,{['a'.repeat(64)]:'/x/c.mov',['b'.repeat(64)]:'/x/logo.png'}).pictures.find(p=>p.logo);
    expect(pic?.box?.width).toBe(Math.round(0.1*1920));
  });
  it('flags a logo that runs off the frame',()=>{
    const doc=cut([{id:'mark',size:0.1}]);
    const bad={...doc,logos:[{...doc.logos[0]!,x:0.95}]};
    expect(checkEditDoc(bad).some(i=>/Logo/.test(i.message))).toBe(true);
  });
});
