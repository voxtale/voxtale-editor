// Last REDACTED gaps: proxy shapes, A/V check at open, templates, logo, cut-out stills, D-Log M. Pure parts, no ffmpeg.
import {describe,expect,it} from 'bun:test';
import {proxyFits,proxyToSource} from '../src/video/footage-media';
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
