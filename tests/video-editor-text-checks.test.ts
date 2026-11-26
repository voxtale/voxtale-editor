// Two measured checks on placed text: reading time (place_text report) and
// text over the speaker's face (watch_cut changed). No model, no network.
import {describe,expect,test} from 'bun:test';
import type {EditDoc} from '@voxtale/editdoc';
import {readSeconds,readWarning} from '../src/video/editor/agent/reading';
import {covered,faceOnScreen,faceWarnings} from '../src/video/editor/agent/face-text';

describe('reading time',()=>{
  test('short lines, a lone number and long lines',()=>{
    expect(readSeconds('one goal')).toBe(1);
    expect(readSeconds('42%')).toBe(1);
    expect(readSeconds('the six words that matter here')).toBe(2);
    expect(readSeconds('one two three four five six seven eight nine ten')).toBeCloseTo(2.5,5);
  });
  test('fades count against the time on screen',()=>{
    expect(readWarning({label:'text a',text:'six words of text up here',start:0,end:3})).toBeNull();
    const w=readWarning({label:'text a',text:'six words of text up here',start:0,end:2.2,fadeIn:0.4,fadeOut:0.4});
    expect(w).toContain('TOO SHORT TO READ: text a is readable 1.4s of 2.2s');
    expect(w).toContain('6 words need about 2.0s');
  });
});

// A 16:9 speaker in a 9:16 frame: cover fit crops the sides.
const doc=(o:{tall?:boolean;zoom?:boolean;broll?:boolean}={}):EditDoc=>({
  clips:[{id:'c1',kind:'video',width:1920,height:1080}],
  canvas:o.tall?{width:1080,height:1920}:{width:1920,height:1080},
  tracks:{
    'a-roll':[{id:'a',clipId:'c1',start:0,end:10,in:5,out:15,status:'accepted'}],
    'b-roll':o.broll?[{id:'b',clipId:'c1',start:0,end:10,status:'accepted'}]:[],
    graphics:[],
    zoom:o.zoom?[{id:'z',start:0,end:10,scale:2,x:0.5,y:0.5,easeIn:0,easeOut:0,status:'accepted'}]:[],
  },
} as unknown as EditDoc);
const face=()=>({x:0.5,y:0.4,w:0.1,h:0.2});

describe('face on screen',()=>{
  test('wide frame: the index box as is',()=>{
    const b=faceOnScreen(doc(),2,face)!;
    expect(b.x).toBeCloseTo(0.45,5);expect(b.y).toBeCloseTo(0.3,5);expect(b.w).toBeCloseTo(0.1,5);expect(b.h).toBeCloseTo(0.2,5);
  });
  test('cover fit into a tall frame widens the face; a 2x zoom doubles it',()=>{
    const tall=faceOnScreen(doc({tall:true}),2,face)!;
    expect(tall.w).toBeCloseTo(0.1*256/81,3);
    const z=faceOnScreen(doc({zoom:true}),2,face)!;
    expect(z.w).toBeCloseTo(0.2,5);expect(z.y).toBeCloseTo(0.1,5);
  });
  test('no face check while footage covers the speaker',()=>{
    expect(faceOnScreen(doc({broll:true}),2,face)).toBeNull();
  });
  test('a title over the mouth is flagged; a caption low in the frame is not',()=>{
    expect(covered({x:0,y:0,w:1,h:1},{x:0.4,y:0.4,w:0.2,h:0.2})).toBeCloseTo(1,6);
    const rows=[
      {t:2,label:'text "big claim"',m:{box:{x:0.3,y:0.4,w:0.4,h:0.12}}},
      {t:2,label:'caption "low line"',m:{box:{x:0.2,y:0.82,w:0.6,h:0.08}}},
    ];
    const w=faceWarnings(doc(),rows,face);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('OVER THE FACE');
    expect(w[0]).toContain('text "big claim"');
  });
});
