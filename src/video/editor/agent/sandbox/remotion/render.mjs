// Renders one agent graphic with Remotion to a transparent VP9 WebM.
// Same steps on this machine (agent/remotion.ts) and in the sandbox image.
//   node render.mjs '<json>'  json: {in, work, out, width, height, seconds, gsap, fonts?, browser?}
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const o = JSON.parse(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
const pub = join(o.work, 'public');
rmSync(o.work, {recursive: true, force: true});
mkdirSync(join(pub, 'fonts'), {recursive: true});
cpSync(o.in, pub, {recursive: true});
cpSync(o.gsap, join(pub, 'gsap.min.js'));
if (o.fonts && existsSync(o.fonts)) for (const f of readdirSync(o.fonts)) if (/\.(ttf|otf|woff2?)$/i.test(f)) cpSync(join(o.fonts, f), join(pub, 'fonts', f));
// HyperFrames' runtime gives the page window.__timelines and the canvas size; here we do.
const page = join(pub, 'index.html');
const shim = `<script>window.__timelines=window.__timelines||{}</script><style>html,body{width:${o.width}px;height:${o.height}px;overflow:hidden}</style>`;
writeFileSync(page, readFileSync(page, 'utf8').replace(/<head>/i, m => m + shim));

const browser = o.browser ? {browserExecutable: o.browser} : {};
const inputProps = {width: o.width, height: o.height, seconds: o.seconds};
const serveUrl = await bundle({entryPoint: join(here, 'entry.jsx'), publicDir: pub, outDir: join(o.work, 'bundle'), enableCaching: false});
const composition = await selectComposition({serveUrl, id: 'main', inputProps, ...browser});
await renderMedia({composition, serveUrl, inputProps, codec: 'vp9', imageFormat: 'png', pixelFormat: 'yuva420p',
  outputLocation: o.out, concurrency: 2, overwrite: true, logLevel: 'warn', ...browser});
console.log(`rendered ${composition.durationInFrames} frames at ${composition.width}x${composition.height}`);
