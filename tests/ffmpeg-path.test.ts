import {expect,test} from 'bun:test';
import {resolveFfmpegPaths} from '../src/video/ffmpeg-path';

const has=(...p:string[])=>(x:string)=>p.includes(x);
const FULL='/opt/homebrew/opt/ffmpeg-full/bin',INTEL='/usr/local/opt/ffmpeg-full/bin';

test('env vars win',()=>{
  expect(resolveFfmpegPaths({env:{SUPERTALE_FFMPEG:'/x/ffmpeg',SUPERTALE_FFPROBE:'/y/ffprobe'},platform:'darwin',exists:has(`${FULL}/ffmpeg`)}))
    .toEqual({ffmpeg:'/x/ffmpeg',ffprobe:'/y/ffprobe'});
});
test('env ffmpeg only: ffprobe from same folder',()=>{
  expect(resolveFfmpegPaths({env:{SUPERTALE_FFMPEG:'/x/ffmpeg'},platform:'linux',exists:has('/x/ffprobe')}))
    .toEqual({ffmpeg:'/x/ffmpeg',ffprobe:'/x/ffprobe'});
});
test('mac prefers ffmpeg-full (Apple silicon)',()=>{
  expect(resolveFfmpegPaths({env:{},platform:'darwin',exists:has(`${FULL}/ffmpeg`,`${FULL}/ffprobe`)}))
    .toEqual({ffmpeg:`${FULL}/ffmpeg`,ffprobe:`${FULL}/ffprobe`});
});
test('mac prefers ffmpeg-full (Intel)',()=>{
  expect(resolveFfmpegPaths({env:{},platform:'darwin',exists:has(`${INTEL}/ffmpeg`,`${INTEL}/ffprobe`)}).ffmpeg).toBe(`${INTEL}/ffmpeg`);
});
test('mac without ffmpeg-full uses PATH',()=>{
  expect(resolveFfmpegPaths({env:{},platform:'darwin',exists:()=>false})).toEqual({ffmpeg:'ffmpeg',ffprobe:'ffprobe'});
});
test('linux/windows ignore ffmpeg-full',()=>{
  for(const platform of ['linux','win32'])
    expect(resolveFfmpegPaths({env:{},platform,exists:()=>true})).toEqual({ffmpeg:'ffmpeg',ffprobe:'ffprobe'});
});
