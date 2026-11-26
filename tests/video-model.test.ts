import {describe,expect,test} from 'bun:test';
import {editSchema,timeline,mappedCaptions,parseSrt,keepOutsideSilence} from '../src/video/model';
import {silenceRanges,localPath} from '../src/video/media';
const edit=()=>editSchema.parse({version:1,name:'Cuts',source:'footage.mp4',fps:30,
 scenes:[{id:'a',in:2,out:4},{id:'b',in:6,out:8}],
 captions:[{start:1,end:3,text:'First'},{start:3.5,end:6.5,text:'Across removed footage'},{start:7,end:8,text:'Last'}]});
describe('source-to-output timing',()=>{
 test('keeps captions in sync across removed ranges',()=>{
  expect(timeline(edit()).map(s=>[s.from,s.sourceStart,s.duration])).toEqual([[0,60,60],[60,180,60]]);
  expect(mappedCaptions(edit())).toEqual([
   {from:0,duration:30,text:'First'}, {from:45,duration:15,text:'Across removed footage'},
   {from:60,duration:15,text:'Across removed footage'}, {from:90,duration:30,text:'Last'},
  ]);
 });
 test('reordered and repeated footage keeps the matching captions',()=>{
  const e=edit();e.scenes=[e.scenes[1]!,e.scenes[0]!,{...e.scenes[1]!,id:'again'}];
  expect(mappedCaptions(e).filter(c=>c.text==='Last').map(c=>c.from)).toEqual([30,150]);
 });
 test('rejects duplicate IDs, zero-frame cuts and unsupported fields',()=>{
  const e=edit();expect(()=>editSchema.parse({...e,scenes:[e.scenes[0],e.scenes[0]]})).toThrow();
  expect(()=>editSchema.parse({...e,scenes:[{id:'x',in:2,out:2.001}]})).toThrow();
  expect(()=>editSchema.parse({...e,avatar:'fake'})).toThrow();
 });
});
describe('silence suggestions',()=>{
 test('keeps breathing room around detected silence',()=>expect(keepOutsideSilence(5,[{start:1,end:3}])).toEqual([{in:0,out:1.15},{in:2.85,out:5}]));
 test('clips silence outside a selected scene',()=>expect(keepOutsideSilence(3,[{start:-5,end:-1},{start:5,end:8}])).toEqual([{in:0,out:3}]));
 test('merges overlap and handles trailing silence',()=>{
  expect(keepOutsideSilence(5,[{start:1,end:3},{start:2,end:4}],0)).toEqual([{in:0,out:1},{in:4,out:5}]);
  expect(silenceRanges('silence_start: 2\nsilence_end: 3\nsilence_start: 4',5)).toEqual([{start:2,end:3},{start:4,end:5}]);
 });
});
test('SRT import accepts CRLF and strips markup',()=>{
 expect(parseSrt('1\r\n00:00:02,100 --> 00:00:03,200\r\n<b>Hello</b>\r\nworld')).toEqual([{start:2.1,end:3.2,text:'Hello world'}]);
 expect(()=>parseSrt('bad')).toThrow();
});
test('media is local and paths resolve from the manifest',()=>{
 expect(localPath('/tmp/edit','media/a.mp4')).toBe('/tmp/edit/media/a.mp4');
 expect(()=>localPath('/tmp','https://example.com/a.mp4')).toThrow();
});

test('scene-scoped captions render only in their own occurrence',()=>{
 const e=edit();e.scenes=[{...e.scenes[0]!,id:'a'},{...e.scenes[0]!,id:'b'}];
 e.captions=[{sceneId:'a',start:2,end:3,text:'First occurrence'},{sceneId:'b',start:2,end:3,text:'Second occurrence'}];
 expect(mappedCaptions(e)).toEqual([{from:0,duration:30,text:'First occurrence'},{from:60,duration:30,text:'Second occurrence'}]);
});
