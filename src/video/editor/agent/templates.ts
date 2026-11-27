// Designed graphic templates. The agent picks one and fills the words; code
// writes the HyperFrames HTML on top of the kit, so layout, type and motion
// come out the same every time. Beats are spoken words: each reveal lands on
// the word that says it.
import {z} from 'zod/v4';
import {FULL_SCALE,PANEL_PAD,sideRoom,type Face} from './kit';

/** full = a full-screen card over the speaker (voice continues); the rest are panels beside or over them. */
const place=z.enum(['left','right','lower','top','center','full']);
const line=z.string().min(1).max(48);
const beat=z.number().int().describe('word id (same clip as the anchor) where this part is spoken');

export const templateSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('list'),place:place.default('right'),kicker:z.string().max(40).optional(),
    marker:z.enum(['num','dot','check']).default('num'),
    items:z.array(z.object({text:line,word:beat})).min(2).max(5)}),
  z.object({kind:z.literal('stat'),place:place.default('right'),kicker:z.string().max(40).optional(),
    value:z.number(),decimals:z.number().int().min(0).max(2).default(0),prefix:z.string().max(3).optional(),suffix:z.string().max(4).optional(),
    of:z.number().positive().optional().describe('draw a bar filled to value/of, e.g. 40 of 100'),
    label:z.string().min(1).max(60)}),
  z.object({kind:z.literal('beforeAfter'),place:place.default('right'),kicker:z.string().max(40).optional(),
    before:z.object({label:z.string().max(16).default('Before'),text:line}),
    after:z.object({label:z.string().max(16).default('Now'),text:line,word:beat})}),
  z.object({kind:z.literal('keyTerm'),place:place.default('lower'),kicker:z.string().max(40).optional(),
    text:z.string().min(1).max(60).describe('the phrase, up to ~6 words'),quote:z.boolean().default(false),
    sub:z.string().max(80).optional(),subWord:beat.optional()}),
  z.object({kind:z.literal('compare'),place:z.enum(['lower','center','full']).default('lower'),
    left:z.object({label:z.string().max(24),points:z.array(line).max(3).default([])}),
    right:z.object({label:z.string().max(24),points:z.array(line).max(3).default([]),word:beat})}),
  // A section title card; motion per skill pro-motion §5.
  z.object({kind:z.literal('title'),place:z.enum(['full','lower','center']).default('full'),kicker:z.string().max(40).optional().describe('e.g. "Part 2"'),
    text:z.string().min(1).max(60).describe('the section title, the speaker\'s own words, sentence case'),
    sub:z.string().max(80).optional(),subWord:beat.optional()}),
  z.object({kind:z.literal('flow'),place:z.enum(['lower','top','full']).default('lower'),kicker:z.string().max(40).optional(),
    steps:z.array(z.object({text:z.string().min(1).max(24),word:beat})).min(2).max(4)}),
  // A word underlined in felt pen.
  z.object({kind:z.literal('marked'),place:place.default('lower'),kicker:z.string().max(40).optional(),
    text:z.string().min(1).max(60).describe('the headline, up to ~6 words'),
    mark:z.number().int().min(0).max(9).describe('which word of text to underline, 0 = first'),word:beat.optional().describe('spoken word the stroke lands on')}),
  // A title that becomes a corner label.
  z.object({kind:z.literal('chapter'),place:z.literal('center').default('center').describe('always over the speaker; it parks in corner'),corner:z.enum(['top-left','top-right']).default('top-left'),kicker:z.string().max(40).optional().describe('e.g. "Part 2"'),
    text:z.string().min(1).max(40).describe('the section title, short, sentence case'),word:beat.optional().describe('spoken word where it leaves for the corner')}),
  // Cards dealt onto a pile.
  z.object({kind:z.literal('cards'),place:z.enum(['left','right','center']).default('center'),kicker:z.string().max(40).optional(),
    cards:z.array(z.string().min(1).max(32)).min(3).max(8).describe('short examples, one per card'),word:beat.optional().describe('spoken word the first card lands on')}),
  // Text on the beat.
  z.object({kind:z.literal('beatWords'),place:place.default('lower'),
    words:z.array(z.object({text:z.string().min(1).max(20),word:beat})).min(2).max(8).describe('the line, one entry per word; each lights on its spoken word')}),
]);
export type Template=z.infer<typeof templateSchema>;

const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const f=(x:number)=>x.toFixed(2);

/** Template-only CSS; sizes in --u (1px at 1920 wide) so they scale with the canvas. */
const CSS=`
.items{display:flex;flex-direction:column;gap:calc(var(--u)*22)}
.items .item{font-size:var(--it,calc(var(--u)*58))}
.chk{flex:none;width:calc(var(--u)*56);height:calc(var(--u)*56);border-radius:50%;background:var(--accent);display:grid;place-items:center}
.chk svg{width:60%;height:60%}
.statrow{display:flex;align-items:baseline;gap:calc(var(--u)*8)}
.roll{display:inline-block;height:1em;overflow:hidden;vertical-align:top}
.roll>span{display:flex;flex-direction:column}
.roll>span>span{height:1em;line-height:1}
.meter{position:relative;height:calc(var(--u)*14);border-radius:calc(var(--u)*7);background:rgba(255,255,255,.12);overflow:hidden;min-width:calc(var(--u)*420)}
.meter>i{position:absolute;inset:0;background:linear-gradient(90deg,var(--accent),#9fd0ff);border-radius:inherit;transform-origin:0 50%}
.ba{display:flex;flex-direction:column;gap:calc(var(--u)*18)}
.lbl{font-size:calc(var(--u)*28);font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.6;margin-bottom:calc(var(--u)*6)}
.was{position:relative;display:inline-block}
.cross{position:absolute;left:-2%;right:-2%;top:52%;height:calc(var(--u)*7);border-radius:calc(var(--u)*4);background:var(--warn);transform-origin:0 50%}
.arrow{width:calc(var(--u)*64);height:calc(var(--u)*64)}
.arrow path{fill:none;stroke:var(--accent);stroke-width:7;stroke-linecap:round;stroke-linejoin:round}
.now .item{color:var(--accent)}
.kt{font-size:var(--kt,calc(var(--u)*80));display:flex;flex-wrap:wrap;column-gap:.28em;row-gap:.06em;max-width:calc(var(--u)*1300)}
.mask{display:inline-block;overflow:hidden;padding-bottom:.08em;margin-bottom:-.08em}
.mask>span{display:inline-block}
.qm{font-size:calc(var(--u)*150);font-weight:800;line-height:.6;height:calc(var(--u)*60);color:var(--accent)}
.uline{height:calc(var(--u)*8);width:calc(var(--u)*180);border-radius:calc(var(--u)*4);background:var(--accent);transform-origin:0 50%}
.cmp{flex-direction:row;align-items:stretch;gap:calc(var(--u)*48)}
.col{display:flex;flex-direction:column;gap:calc(var(--u)*16);min-width:calc(var(--u)*360)}
.col .item{font-size:calc(var(--u)*46)}
.vs{align-self:center;font-size:calc(var(--u)*40);font-weight:800;color:#0c0e14;background:#fff;border-radius:50%;width:calc(var(--u)*84);height:calc(var(--u)*84);display:grid;place-items:center}
.warnk{color:var(--warn)}
.flow{display:flex;align-items:center;gap:0}
.step{display:flex;align-items:center;gap:calc(var(--u)*16);font-size:calc(var(--u)*46);font-weight:700;white-space:nowrap}
.link{position:relative;width:calc(var(--u)*90);height:calc(var(--u)*6);margin:0 calc(var(--u)*22);border-radius:calc(var(--u)*3);background:rgba(255,255,255,.15);overflow:hidden}
.link>i{position:absolute;inset:0;background:var(--accent);transform-origin:0 50%}
/* Felt-pen stroke under the word, 0.12 em thick, slanted like italic. */
.mk{position:relative;display:inline-block}
.pen{position:absolute;left:-4%;width:108%;bottom:-.14em;height:.32em;transform:skewX(-10deg);overflow:visible;filter:drop-shadow(0 0 calc(var(--u)*10) var(--accent))}
.pen path{fill:none;stroke:var(--accent);stroke-width:.12em;stroke-linecap:round;vector-effect:non-scaling-stroke}
/* The title parks in a corner as a label. */
.chap{position:absolute;top:calc(var(--u)*48);display:flex;flex-direction:column;gap:calc(var(--u)*10)}
.chap.top-left{left:calc(var(--u)*60);transform-origin:0 0}
.chap.top-right{right:calc(var(--u)*60);transform-origin:100% 0;align-items:flex-end}
.chap .kt{max-width:none;flex-wrap:nowrap;text-shadow:0 calc(var(--u)*4) calc(var(--u)*24) rgba(0,0,0,.55)}
/* A pile of cards. */
.pile{position:absolute;top:50%;width:calc(var(--u)*620);height:calc(var(--u)*300);transform:translateY(-50%)}
.pile.center{left:calc(50% - var(--u)*310)}.pile.left{left:calc(var(--u)*110)}.pile.right{right:calc(var(--u)*110)}
.pile .kicker{position:absolute;top:calc(var(--u)*-70);left:0}
.card{position:absolute;inset:0;border-radius:calc(var(--u)*26);background:#f5f6fa;color:#0c0e14;display:grid;place-items:center;padding:calc(var(--u)*30);
  font-size:calc(var(--u)*52);font-weight:800;text-align:center;box-shadow:0 calc(var(--u)*18) calc(var(--u)*50) rgba(0,0,0,.4)}
/* Each word lights on its beat; nothing moves. */
.beat{display:flex;flex-wrap:wrap;column-gap:.28em;font-size:calc(var(--u)*72);font-weight:800;max-width:calc(var(--u)*1400)}
/* Beside the speaker, wide layouts stack. */
.side.cmp{flex-direction:column;gap:calc(var(--u)*22)}
.side.cmp .vs{align-self:flex-start;width:calc(var(--u)*64);height:calc(var(--u)*64);font-size:calc(var(--u)*30)}
.side .flow{flex-direction:column;align-items:flex-start}
.side .link{width:calc(var(--u)*6);height:calc(var(--u)*34);margin:calc(var(--u)*8) 0 calc(var(--u)*8) calc(var(--u)*29)}
.side .link>i{transform-origin:50% 0}
`;

type Place=z.infer<typeof place>;
/** Rough panel heights (fraction of frame) for the wide layouts. */
const NEED={lower:0.3,top:0.26};
/**
 * Where the panel can go without covering the face: a wide place the head
 * leaves no room for moves beside the speaker, to the roomier side.
 */
export function resolvePlace(want:Place,face?:Face):Place {
  if(!face||want==='left'||want==='right'||want==='full')return want;
  const chin=face.y+face.h/2,crown=face.y-face.h*0.6;
  if(want==='lower'&&0.94-chin>=NEED.lower)return want;
  if(want==='top'&&crown-0.04>=NEED.top)return want;
  const right=0.95-(face.x+face.w*0.75),left=face.x-face.w*0.75-0.05;
  return right>=left?'right':'left';
}

/** Seconds into the graphic where each beat word is spoken, kept inside the hold. */
export type BeatClock=(word:number|undefined,fallback:number)=>number;

export function templateHtml(t0:Template,o:{width:number;height:number;seconds:number;at:BeatClock;face?:Face}):string {
  const p=resolvePlace(t0.place,o.face);
  const t={...t0,place:p} as Template;
  const side=p==='left'||p==='right';
  const S=o.seconds,end=Math.max(1,S-0.45);
  const at=(w:number|undefined,fb:number)=>Math.min(Math.max(o.at(w,fb),0.35),end-0.8);
  const kicker=(k?:string,cls='')=>k?`<div class="kicker ${cls}" id="k">${esc(k)}</div>`:'';
  const js:string[]=[];
  let body='';
  const full=p==='full';
  // Shared entrance: panel rises in, accent rule grows, kicker fades.
  const open=()=>js.push(`tl.fromTo('#g',{opacity:0,y:28,scale:.965},{opacity:1,y:0,scale:1,duration:.6,ease:kit.curves.moderate},0)`,
    `tl.fromTo('.edge',{scaleY:0},{scaleY:1,duration:.5,ease:kit.curves.moderate},.15)`,
    `tl.fromTo('#k',{opacity:0,x:-14},{opacity:1,x:0,duration:.4,ease:kit.curves.moderate},.2)`);
  switch(t.kind) {
    case 'list': {
      const mark=(i:number)=>t.marker==='num'?`<span class="num" id="m${i}">${i+1}</span>`:t.marker==='dot'?`<span class="dot" id="m${i}"></span>`
        :`<span class="chk" id="m${i}"><svg viewBox="0 0 24 24"><path id="c${i}" d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#0c0e14" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg></span>`;
      // Item size: largest (≤58) where every item fits in 2 lines and the list fits 80% of the height
      // (Inter 700 ≈ 0.55 em per letter; marker + gap take 84 units).
      const room=(side?sideRoom(p as 'left'|'right',o.face)*1920:p==='full'?1500/FULL_SCALE:1500)-PANEL_PAD-84;
      const lines=(s:number)=>t.items.map(it=>{
        const max=room/(0.55*s);let n=1,len=0;
        for(const w of it.text.split(/\s+/)){if(len&&len+1+w.length>max){n++;len=w.length;}else len+=(len?1:0)+w.length;}
        return n;
      });
      let size=58;
      while(size>38&&(Math.max(...lines(size))>2||lines(size).reduce((a,b)=>a+b,0)*1.1*size+t.items.length*22+90>0.8*1080))size-=2;
      body=`<div class="panel ${t.place}" id="g" style="--it:calc(var(--u)*${size})"><div class="edge"></div>${kicker(t.kicker)}<div class="items">${t.items.map((it,i)=>
        `<div class="item dim" id="i${i}">${mark(i)}<span>${esc(it.text)}</span></div>`).join('')}</div></div>`;
      open();
      const first=0.55,span=(end-1.2-first)/Math.max(1,t.items.length-1);
      t.items.forEach((it,i)=>{
        const s=f(at(it.word,first+i*span));
        js.push(`tl.to('#i${i}',{opacity:1,duration:.3,ease:kit.curves.moderate},${s})`,
          `tl.fromTo('#m${i}',{scale:.5},{scale:1,duration:1.2,ease:kit.snapEase(1.2)},${s})`,
          `tl.fromTo('#i${i}>span:last-child',{x:-10},{x:0,duration:.4,ease:kit.curves.moderate},${s})`);
        if(t.marker==='check')js.push(`tl.to('#c${i}',{strokeDashoffset:0,duration:.35,ease:kit.curves.moderate},${f(+s+.15)})`);
      });
      break;
    }
    case 'stat': {
      const text=t.value.toFixed(t.decimals).replace(/\B(?=(\d{3})+(?!\d))/g,',');
      // Odometer: each digit is a 0-9 column that rolls to its value.
      let k=0;
      const digits=[...text].map(ch=>/\d/.test(ch)
        ?`<span class="roll"><span id="d${k++}" data-v="${ch}">${Array.from({length:10},(_,n)=>`<span>${n}</span>`).join('')}</span></span>`
        :`<span>${esc(ch)}</span>`).join('');
      body=`<div class="panel ${t.place}" id="g"><div class="edge"></div>${kicker(t.kicker)}<div class="stat statrow">`
        +`${t.prefix?`<span class="accent">${esc(t.prefix)}</span>`:''}${digits}${t.suffix?`<span class="accent">${esc(t.suffix)}</span>`:''}</div>`
        +`${t.of?'<div class="meter"><i id="bar"></i></div>':''}<div class="sub" id="lab">${esc(t.label)}</div></div>`;
      open();
      [...text].filter(ch=>/\d/.test(ch)).forEach((ch,i)=>js.push(
        `tl.fromTo('#d${i}',{yPercent:0},{yPercent:${-Number(ch)*10},duration:${f(1.1+i*.12)},ease:kit.curves.glide},.35)`));
      if(t.of)js.push(`tl.fromTo('#bar',{scaleX:0},{scaleX:${f(Math.min(1,t.value/t.of))},duration:1.2,ease:kit.snapEase(1.2)},.45)`);
      js.push(`tl.fromTo('#lab',{opacity:0,y:12},{opacity:.82,y:0,duration:.45,ease:kit.curves.moderate},.9)`);
      break;
    }
    case 'beforeAfter': {
      body=`<div class="panel ${t.place}" id="g"><div class="edge"></div>${kicker(t.kicker)}<div class="ba">`
        +`<div id="bw"><div class="lbl">${esc(t.before.label)}</div><div class="was"><div class="item" id="b">${esc(t.before.text)}</div><i class="cross" id="x"></i></div></div>`
        +`<svg class="arrow" id="arr" viewBox="0 0 64 64"><path id="ap" d="M32 8v44M16 38l16 16 16-16" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg>`
        +`<div class="now" id="aw"><div class="lbl">${esc(t.after.label)}</div><div class="item" id="a">${esc(t.after.text)}</div></div></div></div>`;
      open();
      const s=at(t.after.word,Math.min(2,end*.45));
      js.push(`tl.fromTo('#bw',{opacity:0,y:14},{opacity:1,y:0,duration:.45,ease:kit.curves.moderate},.3)`,
        `tl.fromTo('#x',{scaleX:0},{scaleX:1,duration:1.2,ease:kit.snapEase(1.2)},${f(Math.max(.8,s-.55))})`,
        `tl.to('#b',{opacity:.45,duration:.3},${f(Math.max(.9,s-.4))})`,
        `tl.to('#ap',{strokeDashoffset:0,duration:.35,ease:kit.curves.moderate},${f(Math.max(1,s-.25))})`,
        `tl.fromTo('#aw',{opacity:0,y:18,scale:.96},{opacity:1,y:0,scale:1,duration:.5,ease:kit.curves.moderate},${f(s)})`);
      break;
    }
    case 'keyTerm': {
      const words=t.text.split(/\s+/).filter(Boolean);
      // Headline size so the longest word fits the panel (Inter 800 ≈ 0.62 em per letter).
      const room=(side?sideRoom(p as 'left'|'right',o.face)*1920:p==='full'?1500/FULL_SCALE:1500)-PANEL_PAD;
      const size=Math.round(Math.min(80,room/(0.62*Math.max(...words.map(w=>w.length)))));
      body=`<div class="panel ${t.place}" id="g" style="--kt:calc(var(--u)*${size})"><div class="edge"></div>${kicker(t.kicker)}${t.quote?'<div class="qm" id="qm">“</div>':''}`
        +`<div class="title kt">${words.map((w,i)=>`<span class="mask"><span id="w${i}">${esc(w)}</span></span>`).join('')}</div>`
        +`<div class="uline" id="ul"></div>${t.sub?`<div class="sub" id="sub">${esc(t.sub)}</div>`:''}</div>`;
      open();
      if(t.quote)js.push(`tl.fromTo('#qm',{opacity:0,scale:.6},{opacity:1,scale:1,duration:.5,ease:kit.curves.moderate},.25)`);
      words.forEach((_,i)=>js.push(`tl.fromTo('#w${i}',{yPercent:115},{yPercent:0,duration:.55,ease:kit.curves.moderate},${f(.35+i*.08)})`));
      js.push(`tl.fromTo('#ul',{scaleX:0},{scaleX:1,duration:1.2,ease:kit.snapEase(1.2)},${f(.55+words.length*.08)})`);
      if(t.sub)js.push(`tl.fromTo('#sub',{opacity:0,y:12},{opacity:.82,y:0,duration:.45,ease:kit.curves.moderate},${f(at(t.subWord,.9+words.length*.08))})`);
      break;
    }
    case 'compare': {
      const col=(id:string,c:{label:string;points:string[]},cls:string)=>`<div class="col" id="${id}"><div class="kicker ${cls}">${esc(c.label)}</div>`
        +c.points.map((p,i)=>`<div class="item" id="${id}p${i}"><span class="dot" ${cls?'style="background:var(--warn)"':''}></span><span>${esc(p)}</span></div>`).join('')+'</div>';
      body=`<div class="panel ${t.place} cmp${side?' side':''}" id="g">${col('L',t.left,'warnk')}<div class="vs" id="vs">vs</div>${col('R',t.right,'')}</div>`;
      js.push(`tl.fromTo('#g',{opacity:0,y:28},{opacity:1,y:0,duration:.55,ease:kit.curves.moderate},0)`,
        `tl.fromTo('#L',{opacity:0,x:-30},{opacity:1,x:0,duration:.5,ease:kit.curves.moderate},.25)`);
      t.left.points.forEach((_,i)=>js.push(`tl.fromTo('#Lp${i}',{opacity:0},{opacity:.75,duration:.3},${f(.5+i*.12)})`));
      const s=at(t.right.word,Math.min(2,end*.45));
      js.push(`tl.fromTo('#vs',{scale:0,rotation:-30},{scale:1,rotation:0,duration:1.2,ease:kit.snapEase(1.2)},${f(Math.max(.6,s-.35))})`,
        `tl.fromTo('#R',{opacity:0,x:30},{opacity:1,x:0,duration:.5,ease:kit.curves.moderate},${f(s)})`);
      t.right.points.forEach((_,i)=>js.push(`tl.fromTo('#Rp${i}',{opacity:0},{opacity:1,duration:.3},${f(s+.25+i*.12)})`));
      break;
    }
    case 'title': {
      // A standard title reveals in 1.77 s, a linear sweep;
      // words rise ~100% of their height; the title rises into place on glide; new text arrives in the accent and cools.
      const words=t.text.split(/\s+/).filter(Boolean);
      const room=(p==='full'?1500/FULL_SCALE:1500)-PANEL_PAD;
      const size=Math.round(Math.min(p==='full'?96:80,room/(0.62*Math.max(...words.map(w=>w.length)))));
      body=`<div class="panel ${t.place}" id="g" style="--kt:calc(var(--u)*${size})">${kicker(t.kicker)}`
        +`<div class="title kt" id="tt">${words.map((w,i)=>`<span class="mask"><span id="w${i}">${esc(w)}</span></span>`).join('')}</div>`
        +`${t.sub?`<div class="sub" id="sub">${esc(t.sub)}</div>`:''}</div>`;
      js.push(`tl.fromTo('#g',{opacity:0},{opacity:1,duration:.1},0)`,
        `tl.fromTo('#g',{y:70},{y:0,duration:${f(Math.min(1.6,end*.5))},ease:kit.curves.glide},0)`,
        `tl.fromTo('#k',{opacity:0},{opacity:1,duration:.3,ease:kit.curves.moderate},.1)`);
      const sweep=Math.min(1.77,end*.45);
      words.forEach((_,i)=>js.push(`tl.fromTo('#w${i}',{yPercent:100,opacity:0},{yPercent:0,opacity:1,duration:.5,ease:kit.curves.moderate},${f(.2+sweep*i/words.length)})`));
      js.push(`kit.cool(tl,'#tt',.2)`);
      if(t.sub)js.push(`tl.fromTo('#sub',{opacity:0,y:12},{opacity:.82,y:0,duration:.45,ease:kit.curves.moderate},${f(at(t.subWord,.3+sweep))})`);
      break;
    }
    case 'flow': {
      body=`<div class="panel ${t.place}${side?' side':''}" id="g"><div class="edge"></div>${kicker(t.kicker)}<div class="flow">${t.steps.map((st,i)=>
        (i?`<div class="link"><i id="l${i}"></i></div>`:'')+`<div class="step dim" id="s${i}"><span class="num" id="n${i}">${i+1}</span><span>${esc(st.text)}</span></div>`).join('')}</div></div>`;
      open();
      const first=0.55,span=(end-1.2-first)/Math.max(1,t.steps.length-1);
      t.steps.forEach((st,i)=>{
        const s=at(st.word,first+i*span);
        if(i)js.push(`tl.fromTo('#l${i}',{${side?'scaleY':'scaleX'}:0},{${side?'scaleY':'scaleX'}:1,duration:1.2,ease:kit.snapEase(1.2)},${f(Math.max(.4,s-.35))})`);
        js.push(`tl.to('#s${i}',{opacity:1,duration:.3,ease:kit.curves.moderate},${f(s)})`,
          `tl.fromTo('#n${i}',{scale:.5},{scale:1,duration:1.2,ease:kit.snapEase(1.2)},${f(s)})`);
      });
      break;
    }
    case 'marked': {
      // The title lands, then 4-8 frames later a hand stroke draws under one word in 0.33 s (glide, no bounce).
      const words=t.text.split(/\s+/).filter(Boolean),mk=Math.min(t.mark,words.length-1);
      const room=(side?sideRoom(p as 'left'|'right',o.face)*1920:p==='full'?1500/FULL_SCALE:1500)-PANEL_PAD;
      const size=Math.round(Math.min(80,room/(0.62*Math.max(...words.map(w=>w.length)))));
      body=`<div class="panel ${t.place}" id="g" style="--kt:calc(var(--u)*${size})"><div class="edge"></div>${kicker(t.kicker)}`
        +`<div class="title kt">${words.map((w,i)=>{const m=`<span class="mask"><span id="w${i}">${esc(w)}</span></span>`;
          return i===mk?`<span class="mk">${m}<svg class="pen" viewBox="0 0 100 12" preserveAspectRatio="none"><path id="pen" d="M2 8 C 22 5, 45 10, 66 6 S 92 5, 98 7" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg></span>`:m;}).join('')}</div></div>`;
      open();
      words.forEach((_,i)=>js.push(`tl.fromTo('#w${i}',{yPercent:115},{yPercent:0,duration:.55,ease:kit.curves.moderate},${f(.35+i*.08)})`));
      const landed=.35+words.length*.08+.55+6/24;
      js.push(`tl.to('#pen',{strokeDashoffset:0,duration:.33,ease:kit.curves.glide},${f(Math.max(landed,at(t.word,landed)))})`);
      break;
    }
    case 'chapter': {
      // Hold the title centred >= 0.6 s, then one swing curve (0.95 s) carries it to the
      // corner and shrinks it to a label about 48 px tall at 1080 (never under ~32 px).
      const words=t.text.split(/\s+/).filter(Boolean);
      const size=Math.round(Math.min(110,1500/(0.62*Math.max(4,t.text.length*0.9))));
      const label=Math.max(0.3,Math.min(0.6,48/size));
      body=`<div class="chap ${t.corner}" id="g" style="--kt:calc(var(--u)*${size})">${kicker(t.kicker)}`
        +`<div class="title kt" id="tt">${words.map((w,i)=>`<span class="mask"><span id="w${i}">${esc(w)}</span></span>`).join('')}</div></div>`;
      const reveal=.2+Math.min(.9,words.length*.12)+.5,leave=Math.min(Math.max(reveal+.6,at(t.word,reveal+.6)),end-1.2);
      js.push(`var R=document.getElementById('root').getBoundingClientRect(),G=document.getElementById('g').getBoundingClientRect()`,
        `tl.set('#g',{x:R.left+(R.width-G.width)/2-G.left,y:R.top+(R.height-G.height)/2-G.top})`,
        `tl.fromTo('#g',{opacity:0},{opacity:1,duration:.15},0)`,
        `tl.fromTo('#k',{opacity:0},{opacity:1,duration:.3,ease:kit.curves.moderate},.1)`);
      words.forEach((_,i)=>js.push(`tl.fromTo('#w${i}',{yPercent:100,opacity:0},{yPercent:0,opacity:1,duration:.5,ease:kit.curves.moderate},${f(.2+i*.12)})`));
      js.push(`tl.to('#g',{x:0,y:0,scale:${f(label)},duration:.95,ease:kit.curves.swing},${f(leave)})`);
      break;
    }
    case 'cards': {
      // Each card flies in on flowIn (X and Y on their own curves, so it arcs) to the pile;
      // the gap tightens from 0.27 s to 0.1 s like a deal speeding up, then everything holds still >= 0.5 s.
      const n=t.cards.length,trip=1;
      body=`<div class="pile ${t.place}" id="g">${kicker(t.kicker)}${t.cards.map((c,i)=>`<div class="card" id="c${i}" style="transform:rotate(${((i*37)%11-5)*.9}deg)">${esc(c)}</div>`).join('')}</div>`;
      let s=Math.min(at(t.word,.3),Math.max(.3,end-trip-.5-.27*n));
      js.push(`tl.fromTo('#k',{opacity:0},{opacity:1,duration:.3,ease:kit.curves.moderate},.1)`);
      t.cards.forEach((_,i)=>{
        js.push(`tl.fromTo('#c${i}',{opacity:0},{opacity:1,duration:.08},${f(s)})`,
          `tl.fromTo('#c${i}',{x:${t.place==='left'?-1100:1100}},{x:0,duration:${trip},ease:kit.curves.flowIn},${f(s)})`,
          `tl.fromTo('#c${i}',{y:420},{y:0,duration:${trip},ease:kit.curves.glide},${f(s)})`);
        s+=.27-(.17*i)/Math.max(1,n-2);
      });
      break;
    }
    case 'beatWords': {
      // The spoken word lights in the accent and returns to colour in 14 frames (glide,
      // no overshoot); a beat closer than that returns faster so the line never shivers. Nothing moves.
      const times=t.words.map((w,i)=>at(w.word,.5+i*.4));
      body=`<div class="panel ${t.place}" id="g"><div class="edge"></div><div class="beat">${t.words.map((w,i)=>`<span id="b${i}">${esc(w.text)}</span>`).join('')}</div></div>`;
      open();
      js.push(`var acc=getComputedStyle(document.getElementById('root')).getPropertyValue('--accent').trim()||'#5eb0ff'`);
      times.forEach((s,i)=>{
        const gap=i+1<times.length?times[i+1]!-s:1,back=Math.max(.15,Math.min(14/24,gap-1/24));
        js.push(`tl.fromTo('#b${i}',{color:acc,textShadow:'0 0 18px '+acc},{color:'#fff',textShadow:'0 0 0px rgba(0,0,0,0)',duration:${f(back)},ease:kit.curves.glide,immediateRender:false},${f(s)})`);
      });
      break;
    }
  }
  js.push(`tl.to('#g',{opacity:0,y:-14,duration:.4,ease:kit.curves.flowOut},${f(end)})`);
  // Full screen: the backdrop cuts in under the card and fades out with it.
  if(full)js.unshift(`tl.fromTo('#st',{opacity:0},{opacity:1,duration:.25,ease:kit.curves.moderate},0)`,
    `tl.fromTo('#st .glow',{scale:1.15},{scale:1,duration:${f(S)},ease:'none'},0)`);
  if(full)js.push(`tl.to('#st',{opacity:0,duration:.35,ease:kit.curves.flowOut},${f(end+.05)})`);
  return `<!doctype html>
<html><head><meta charset="UTF-8">
<script src="./gsap.min.js"></script>
<link rel="stylesheet" href="./kit.css">
<style>${CSS}</style>
</head><body>
<div id="root" data-composition-id="main" data-start="0" data-width="${o.width}" data-height="${o.height}" data-duration="${S}">
${full?`<div class="stage" id="st"><div class="glow"></div></div>\n<div class="fill">${body}</div>`:body}
</div>
<script>
const tl=gsap.timeline({paused:true});
${js.join(';\n')};
window.__timelines["main"]=tl;
</script></body></html>`;
}
