// Graphic templates without a render: where a card goes and what HTML it gets.
import {describe,expect,test} from 'bun:test';
import {kitCss} from '../src/video/editor/agent/kit';
import {resolvePlace,templateHtml,templateSchema} from '../src/video/editor/agent/templates';

const face={x:0.5,y:0.42,w:0.22,h:0.6};
const at=(_w:number|undefined,fb:number)=>fb;

describe('graphic templates',()=>{
  test('a panel moves off a centred face; a full-screen card stays full',()=>{
    expect(resolvePlace('lower',face)).not.toBe('lower');
    expect(resolvePlace('full',face)).toBe('full');
  });

  test('full screen puts an opaque stage under the card and fades both out',()=>{
    for(const t of [
      {kind:'stat',place:'full',value:40,suffix:'%',label:'of the job is typing'},
      {kind:'list',place:'full',items:[{text:'Find the bug',word:1},{text:'Run the tests',word:2}]},
      {kind:'flow',place:'full',steps:[{text:'Goal',word:1},{text:'Check',word:2}]},
      {kind:'compare',place:'full',left:{label:'Then'},right:{label:'Now',word:3}},
    ]) {
      const html=templateHtml(templateSchema.parse(t),{width:1920,height:1080,seconds:6,at,face});
      expect(html).toContain('<div class="stage" id="st">');
      expect(html).toContain('class="panel full');
      expect(html).toMatch(/tl\.to\('#st',\{opacity:0/);
    }
    const panel=templateHtml(templateSchema.parse({kind:'stat',value:40,label:'x'}),{width:1920,height:1080,seconds:6,at,face});
    expect(panel).not.toContain('class="stage"');
  });

  test('the kit sizes in canvas units, larger on a full-screen card',()=>{
    const css=kitCss(3840,face);
    expect(css).toContain('--u:2.0000px');
    expect(css).toMatch(/\.panel\.full\{--u:3\.2000px/);
    expect(css).toContain('font-size:calc(var(--u)*80)');
  });
});
