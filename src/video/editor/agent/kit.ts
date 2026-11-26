// The graphics kit: fonts, type scale and panel layouts sized to the canvas,
// written next to every composition as ./kit.css. The agent composes with its
// classes and sets no sizes, so text comes out the right size by construction.
/** Face box as fractions of the frame (centre x/y, width/height). */
export interface Face {x:number;y:number;w:number;h:number}
/** Headphones, hair and ears reach this far past the face box, in face widths from its centre. */
const HEAD=0.75,GAP=0.02;

/** Widest a side panel may be (fraction of frame width): it stops short of the speaker's head. */
export function sideRoom(side:'left'|'right',face?:Face):number {
  if(!face)return 0.34;
  return Math.max(0.2,side==='right'?0.95-(face.x+face.w*HEAD+GAP):face.x-face.w*HEAD-GAP-0.05);
}
/** Type and spacing grow by this on a full-screen card. */
export const FULL_SCALE=1.6;
/** Panel padding, left + right, in px at 1920 wide. */
export const PANEL_PAD=104;

export function kitCss(width:number,face?:Face):string {
  const u=(px:number)=>`calc(var(--u)*${px})`;
  const pct=(f:number)=>`${(f*100).toFixed(1)}%`;
  const right=sideRoom('right',face),left=sideRoom('left',face);
  return `@font-face{font-family:Inter;src:url(./fonts/Inter-Regular.otf);font-weight:400}
@font-face{font-family:Inter;src:url(./fonts/Inter-Medium.otf);font-weight:500}
@font-face{font-family:Inter;src:url(./fonts/Inter-SemiBold.otf);font-weight:600}
@font-face{font-family:Inter;src:url(./fonts/Inter-Bold.otf);font-weight:700}
@font-face{font-family:Inter;src:url(./fonts/Inter-ExtraBold.otf);font-weight:800}
@font-face{font-family:'JetBrains Mono';src:url(./fonts/JetBrainsMono-Bold.ttf);font-weight:700}
html,body{margin:0;background:transparent}
#root{position:relative;width:100%;height:100%;overflow:hidden;font-family:Inter,sans-serif;color:#fff;
  --u:${(width/1920).toFixed(4)}px;--accent:#5eb0ff;--warn:#ff7a6b;--panel:rgba(12,14,20,.86)}
/* Panels size to their content. Pick one place: left / right (beside a centred speaker), lower, top, center, full. */
.panel{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;gap:${u(22)};padding:${u(44)} ${u(PANEL_PAD/2)};
  border-radius:${u(28)};background:linear-gradient(155deg,rgba(26,30,42,.94),rgba(9,11,16,.9));
  border:${u(1.5)} solid rgba(255,255,255,.1);box-shadow:0 ${u(28)} ${u(70)} rgba(0,0,0,.45);width:max-content;max-width:34%}
/* Accent rule down the panel's left edge. */
.edge{position:absolute;left:0;top:${u(30)};bottom:${u(30)};width:${u(6)};border-radius:0 ${u(6)} ${u(6)} 0;background:var(--accent)}
.panel.left{left:5%;top:50%;translate:0 -50%;max-width:${pct(left)}}
.panel.right{right:5%;top:50%;translate:0 -50%;max-width:${pct(right)}}
.panel.lower{left:50%;bottom:8%;translate:-50% 0;max-width:80%}
.panel.top{left:50%;top:7%;translate:-50% 0;max-width:80%}
.panel.center{left:50%;top:50%;translate:-50% -50%;max-width:60%}
/* Full screen: an opaque stage covers the speaker; the card sits on it unboxed, everything bigger. */
.stage{position:absolute;inset:0;overflow:hidden;background:linear-gradient(160deg,#141a29,#07080c)}
.stage .glow{position:absolute;inset:-10%;background:radial-gradient(60% 55% at 22% 18%,rgba(94,176,255,.26),transparent 70%),
  radial-gradient(50% 50% at 88% 95%,rgba(255,122,107,.14),transparent 70%)}
.stage::after{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),
  linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:${u(96)} ${u(96)};
  -webkit-mask-image:radial-gradient(circle at 50% 45%,#000 20%,transparent 75%)}
/* Centre by flex, not translate: GSAP folds a CSS translate into its own transform and can drop it. */
.fill{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.panel.full{--u:${(FULL_SCALE*width/1920).toFixed(4)}px;position:relative;max-width:80%;
  background:none;border:0;box-shadow:none}
.panel.full .edge{display:none}
.panel.row{flex-direction:row;align-items:center;gap:${u(36)}}
.kicker{font-size:${u(34)};font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.title{font-size:${u(80)};font-weight:800;line-height:1.05}
.stat{font-size:${u(168)};font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.dim{opacity:.28}
.item{font-size:${u(58)};font-weight:700;line-height:1.1;display:flex;align-items:flex-start;gap:${u(20)}}
.sub{font-size:${u(42)};font-weight:500;opacity:.82;line-height:1.2}
.mono{font-family:'JetBrains Mono',monospace}
.num{flex:none;display:grid;place-items:center;width:${u(64)};height:${u(64)};border-radius:50%;background:var(--accent);color:#0c0e14;font-size:${u(36)};font-weight:800}
.dot{flex:none;margin-top:.4em;width:${u(18)};height:${u(18)};border-radius:50%;background:var(--accent)}
.bar{flex:none;width:${u(8)};align-self:stretch;border-radius:${u(4)};background:var(--accent)}
.strike{text-decoration:line-through;text-decoration-color:var(--warn);text-decoration-thickness:${u(6)};opacity:.6}
.accent{color:var(--accent)}
`;
}
