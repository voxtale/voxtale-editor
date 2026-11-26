import {describe,expect,test} from 'bun:test';
import {activityLevels,avOffsetFrom,crossCorrelate,envelope,placeBySound} from '../src/video/sound-sync';
import {colorFromTags,needsProxy,profileOf} from '../src/video/footage-media';
import {syncFromGroups} from '../src/video/editor/agent/multicam';

// Seeded noise so the tests are the same every run.
function noise(n:number,seed=1):Float64Array {
  // mulberry32
  let a=seed>>>0;const out=new Float64Array(n);
  for(let i=0;i<n;i++){a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);out[i]=((t^(t>>>14))>>>0)/4294967296-0.5;}
  return out;
}

describe('sound sync', () => {
  test('crossCorrelate finds a known lag', () => {
    const a=noise(4000),lag=137,b=a.slice(lag,lag+3000);
    const r=crossCorrelate(a,b);
    expect(r.lag).toBe(lag);
    expect(r.confidence).toBeGreaterThan(8);
  });

  // White noise scores ~8 peak/median even when unrelated (REDACTED's floor was set on speech), so the test floor is 20.
  test('placeBySound puts each file on a shared clock; an unrelated file gets no start', () => {
    const base=noise(6000,3);
    const envs=[{clipId:'a',env:base.slice(0,5000)},{clipId:'b',env:base.slice(500,5500)},{clipId:'c',env:noise(5000,99)}];
    const r=placeBySound(envs,{rate:500,min:20});
    expect(r[0]).toEqual({clipId:'a',start:0});
    expect(r[1]!.start).toBeCloseTo(1,5);
    expect(r[2]!.start).toBeUndefined();
  });

  test('envelope is zero mean and unit spread', () => {
    const e=envelope(Float32Array.from(noise(1600)));
    const m=e.reduce((s,x)=>s+x,0)/e.length;
    expect(Math.abs(m)).toBeLessThan(1e-9);
    expect(e.reduce((s,x)=>s+x*x,0)/e.length).toBeCloseTo(1,6);
  });

  test('activityLevels: silence is -90 dB, a loud part is higher', () => {
    const x=new Float32Array(1600);x.fill(0.5,800);
    const l=activityLevels(x,8000,0.1);
    expect(l).toEqual([-90,expect.closeTo(-6.02,1)]);
  });

  test('avOffsetFrom: sound 4 frames late is found; flat input is null', () => {
    const motion=[...noise(600,7)],loud=[0,0,0,0,...motion.slice(0,596)];
    const r=avOffsetFrom(motion,loud,25);
    expect(r?.offset).toBeCloseTo(-4/25,3);
    expect(avOffsetFrom(new Array(600).fill(1),new Array(600).fill(1),25)).toBeNull();
  });
});

describe('footage media', () => {
  test('needsProxy: 4K, HEVC or 10-bit yes; 720p H.264 8-bit no', () => {
    expect(needsProxy({width:3840,height:2160,codec:'h264',pixFmt:'yuv420p'})).toBe(true);
    expect(needsProxy({width:1280,height:720,codec:'hevc',pixFmt:'yuv420p'})).toBe(true);
    expect(needsProxy({width:1280,height:720,codec:'h264',pixFmt:'yuv420p10le'})).toBe(true);
    expect(needsProxy({width:1280,height:720,codec:'h264',pixFmt:'yuv420p'})).toBe(false);
  });

  test('colorFromTags: Sony notes, HLG/PQ tags, 8-bit, then the picture decides', () => {
    const t={pixFmt:'yuv420p10le',tags:{}};
    const sony=colorFromTags(t,'<Item name="CaptureGammaEquation" value="s-log3-cine"/><Item name="CaptureColorPrimaries" value="S-Gamut3.Cine"/> modelName="ILCE-7M4"');
    expect('color' in sony&&sony.color.log).toBe('Sony S-Log3/S-Gamut3.Cine');
    const hlg=colorFromTags({...t,colorTransfer:'arib-std-b67',colorRange:'pc'});
    expect('color' in hlg&&hlg.color).toMatchObject({hdr:'hlg',fullRange:true});
    expect('color' in colorFromTags({...t,colorTransfer:'smpte2084'})&&(colorFromTags({...t,colorTransfer:'smpte2084'}) as {color:{hdr?:string}}).color.hdr).toBe('pq');
    const eight=colorFromTags({pixFmt:'yuv420p',tags:{}});
    expect('color' in eight&&eight.color.log).toBeUndefined();
    expect('look' in colorFromTags({...t,tags:{make:'DJI'}})).toBe(true);
  });

  test('profileOf by brand', () => {
    expect(profileOf('DJI Osmo Action')).toBe('DJI D-Log M');
    expect(profileOf('Apple iPhone 16 Pro')).toBe('Apple Log/Rec. 2020');
    expect(profileOf('unknown')).toBe('Log');
  });
});

describe('multicam', () => {
  test('syncFromGroups: offsets against the talk clip', () => {
    const groups=[{id:'g1',via:'sound' as const,members:[{clipId:'c1',start:2},{clipId:'c2',start:0},{clipId:'c3',start:5}]}];
    expect(syncFromGroups(groups,'c1')).toEqual([{clip:'c2',with:'c1',offset:2},{clip:'c3',with:'c1',offset:-3}]);
    expect(syncFromGroups(groups,'zz')).toEqual([]);
  });
});
