// Style → graphics-kit tokens, with text contrast fixed by code. Spike 3
// found the perceiver too strict on contrast, so contrast is never a model
// question: every text colour the kit draws is pushed to a readable ratio
// against the panel colour before the graphic is written.
import type {EditStyle} from '@voxtale/editdoc';

export interface GraphicTokens {
  colors:{primary:string;accent:string;background:string;text:string;muted:string};
  fonts:{heading:string;body:string};
  radius:number;
  safe:number;
}

/** WCAG contrast needs for large text (headings) and body text. */
export const HEADING_CONTRAST=3,BODY_CONTRAST=4.5;

const channels=(hex:string)=>{const h=hex.replace('#','');const f=h.length===3?h.split('').map(c=>c+c).join(''):h.slice(0,6);return [0,2,4].map(i=>parseInt(f.slice(i,i+2),16));};
const toHex=(c:number[])=>'#'+c.map(v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0')).join('').toUpperCase();
function luminance(hex:string):number {
  const [r,g,b]=channels(hex).map(v=>{const s=v/255;return s<=0.03928?s/12.92:((s+0.055)/1.055)**2.4;});
  return 0.2126*r!+0.7152*g!+0.0722*b!;
}
export function contrast(a:string,b:string):number {
  const [x,y]=[luminance(a),luminance(b)].sort((p,q)=>q-p);
  return (x!+0.05)/(y!+0.05);
}
/** Mix `fg` toward white or black (whichever the background is far from) until it reaches `ratio`. */
export function readable(fg:string,bg:string,ratio:number):string {
  if(contrast(fg,bg)>=ratio)return fg.toUpperCase();
  const target=luminance(bg)>0.18?[0,0,0]:[255,255,255];
  const from=channels(fg);
  for(let t=0.05;t<=1.0001;t+=0.05) {
    const c=toHex(from.map((v,i)=>v+(target[i]!-v)*t));
    if(contrast(c,bg)>=ratio)return c;
  }
  return toHex(target);
}

/** Kit tokens from the edit style, contrast-checked against the panel colour. */
export function graphicTokens(style:EditStyle):GraphicTokens {
  const {colors,fonts,safeMargins}=style.brand;
  const bg=colors.background;
  const text=readable(colors.text,bg,BODY_CONTRAST);
  // Muted text is the text colour pulled toward the panel, then pushed back to the body ratio.
  const muted=readable(toHex(channels(text).map((v,i)=>v*0.62+channels(bg)[i]!*0.38)),bg,BODY_CONTRAST);
  return {
    colors:{primary:readable(colors.primary,bg,HEADING_CONTRAST),accent:readable(colors.accent,bg,HEADING_CONTRAST),background:bg.toUpperCase(),text,muted},
    fonts:{heading:`${fonts.heading}, Inter, Arial, sans-serif`,body:`${fonts.body}, Inter, Arial, sans-serif`},
    radius:18,safe:Math.max(0.03,safeMargins),
  };
}
