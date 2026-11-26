// Renders one agent graphic with Remotion to a transparent VP9 WebM.
// Same steps on this machine (agent/remotion.ts) and in the sandbox image.
//   node render.mjs '<json>'  json: {in, work, out, width, height, seconds, gsap, fonts?, browser?}
// Two kinds of job. in/index.html: the agent's HyperFrames-format composition,
// played in an iframe (entry.jsx). in/scene.json ({scene, props}): a native
// scene (scenes/root.tsx), a built-in or the agent's own in/scene.tsx.
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
const browser = o.browser ? {browserExecutable: o.browser} : {};
const common = {codec: 'vp9', imageFormat: 'png', pixelFormat: 'yuva420p', outputLocation: o.out, concurrency: 2, overwrite: true, logLevel: 'warn', ...browser};
const sceneJob = join(pub, 'scene.json');
if (existsSync(sceneJob)) {
  // The image root is read-only: bundle a copy of the scenes, with the agent's file as custom.tsx.
  const src = join(o.work, 'scenes');
  cpSync(join(here, 'scenes'), src, {recursive: true});
  if (existsSync(join(pub, 'scene.tsx'))) cpSync(join(pub, 'scene.tsx'), join(src, 'custom.tsx'));
  const {scene, props} = JSON.parse(readFileSync(sceneJob, 'utf8'));
  const fonts = readdirSync(join(pub, 'fonts')).filter(f => /\.(ttf|otf|woff2?)$/i.test(f));
  const inputProps = {scene, props: props ?? {}, seconds: o.seconds, width: o.width, height: o.height, fonts};
  const serveUrl = await bundle({entryPoint: join(src, 'root.tsx'), publicDir: pub, outDir: join(o.work, 'bundle'), enableCaching: false,
    webpackOverride: c => ({...c, resolve: {...c.resolve, modules: [join(here, 'node_modules'), 'node_modules']}})});
  // WebGL (papercraft, three.js) needs a GL backend in headless Chrome.
  const chromiumOptions = {gl: 'swangle'};
  const composition = await selectComposition({serveUrl, id: 'scene', inputProps, chromiumOptions, ...browser});
  await renderMedia({...common, composition, serveUrl, inputProps, chromiumOptions, scale: o.width / composition.width});
  console.log(`rendered scene ${scene}: ${composition.durationInFrames} frames at ${o.width}x${o.height}`);
} else {
  // HyperFrames' runtime gives the page window.__timelines and the canvas size; here we do.
  const page = join(pub, 'index.html');
  const shim = `<script>window.__timelines=window.__timelines||{}</script><style>html,body{width:${o.width}px;height:${o.height}px;overflow:hidden}</style>`;
  writeFileSync(page, readFileSync(page, 'utf8').replace(/<head>/i, m => m + shim));
  const inputProps = {width: o.width, height: o.height, seconds: o.seconds};
  const serveUrl = await bundle({entryPoint: join(here, 'entry.jsx'), publicDir: pub, outDir: join(o.work, 'bundle'), enableCaching: false});
  const composition = await selectComposition({serveUrl, id: 'main', inputProps, ...browser});
  await renderMedia({...common, composition, serveUrl, inputProps});
  console.log(`rendered ${composition.durationInFrames} frames at ${composition.width}x${composition.height}`);
}
