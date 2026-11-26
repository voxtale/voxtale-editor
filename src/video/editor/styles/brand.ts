// A style's brand kit reaching the graphics: its fonts and logo copied next to
// each composition (./brand/<file>), and kit CSS that puts them and the accent
// colour on the kit's classes. Captions and cards take the colours through
// withBrand (@voxtale/editdoc). Pure except for the file list.
import {existsSync} from 'node:fs';
import {extname,join} from 'node:path';
import type {BrandKit} from '../state';
import type {BrandInfo,Style} from './folder';

/** What a graphic render needs from the brand: CSS laid over the kit, and files to copy into its folder. */
export interface GraphicsBrand {css:string;files:{name:string;path:string}[];logo?:string}

const HEX=/^#[0-9a-fA-F]{6}$/;
const FORMAT:Record<string,string>={'.otf':'opentype','.ttf':'truetype','.woff':'woff','.woff2':'woff2'};
const cssUrl=(f:string)=>`./brand/${encodeURI(f).replace(/'/g,'%27')}`;

/** Colours and font names for withBrand: only valid hex colours; fonts by their family name in the kit. */
export function brandKit(b:BrandInfo|undefined):BrandKit|undefined {
  if(!b)return undefined;
  const colors=Object.fromEntries(Object.entries(b.colors??{}).filter(([,v])=>typeof v==='string'&&HEX.test(v)));
  const fonts={...(b.fonts?.heading?{heading:'BrandHeading'}:{}),...(b.fonts?.body?{body:'BrandBody'}:{})};
  return Object.keys(colors).length||Object.keys(fonts).length?{...(Object.keys(colors).length?{colors}:{}),...(Object.keys(fonts).length?{fonts}:{})}:undefined;
}

/** CSS laid after kit.css: brand fonts on titles and body text, the accent, and a .logo class for the logo file. */
export function brandCss(b:BrandInfo|undefined):string {
  if(!b)return '';
  const out:string[]=[];
  const face=(family:string,f:string)=>`@font-face{font-family:${family};src:url('${cssUrl(f)}') format('${FORMAT[extname(f).toLowerCase()]??'opentype'}')}`;
  if(b.fonts?.heading)out.push(face('BrandHeading',b.fonts.heading),`.title,.stat,.kicker,.item{font-family:BrandHeading,Inter,sans-serif}`);
  if(b.fonts?.body)out.push(face('BrandBody',b.fonts.body),`#root{font-family:BrandBody,Inter,sans-serif}`);
  const vars=[b.colors?.accent&&HEX.test(b.colors.accent)?`--accent:${b.colors.accent}`:'',
    b.colors?.primary&&HEX.test(b.colors.primary)?`--brand-primary:${b.colors.primary}`:'',
    b.colors?.background&&HEX.test(b.colors.background)?`--brand-background:${b.colors.background}`:'',
    b.colors?.text&&HEX.test(b.colors.text)?`--brand-text:${b.colors.text}`:''].filter(Boolean);
  if(vars.length)out.push(`#root{${vars.join(';')}}`);
  if(b.logo)out.push(`.logo{position:absolute;right:4%;top:5%;height:calc(var(--u)*72);width:auto;object-fit:contain}`);
  return out.join('\n');
}

/** The brand for graphics: CSS and the files it names, from the style's brand/ folder. Files gone from disk are left out. */
export function graphicsBrand(s:Style):GraphicsBrand|undefined {
  const b=s.info.brand;
  if(!b)return undefined;
  const names=[b.fonts?.heading,b.fonts?.body,b.logo].filter((x):x is string=>!!x);
  const files=names.map(name=>({name,path:join(s.dir,'brand',name)})).filter(f=>existsSync(f.path));
  const have=new Set(files.map(f=>f.name));
  const kept:BrandInfo={...b,fonts:{...(b.fonts?.heading&&have.has(b.fonts.heading)?{heading:b.fonts.heading}:{}),...(b.fonts?.body&&have.has(b.fonts.body)?{body:b.fonts.body}:{})},
    ...(b.logo&&have.has(b.logo)?{logo:b.logo}:{logo:undefined})};
  const css=brandCss(kept);
  return css||files.length?{css,files,...(kept.logo?{logo:cssUrl(kept.logo)}:{})}:undefined;
}

/** Brand lines for the brief. */
export function brandLines(b:BrandInfo|undefined,g:GraphicsBrand|undefined):string[] {
  if(!b)return [];
  const c=Object.entries(b.colors??{}).map(([k,v])=>`${k} ${v}`).join(', ');
  return [`Brand: ${[c&&`colours ${c} (the kit's --accent is the accent)`,b.fonts?.heading&&'heading font on .title/.stat/.kicker',b.fonts?.body&&'body font on everything else',
    g?.logo&&`logo: <img class="logo" src="${g.logo}"> in a graphic (top right; move it with style)`,b.tone&&`tone: ${b.tone}`].filter(Boolean).join('; ')}.`];
}
