// Runs inside the locked container. /job holds graphic.tsx + input.json;
// writes /job/out/{graphic.webm, graphic.mov?, still-<frame>.jpg, report.json}.
import {bundle} from '@remotion/bundler';
import {renderMedia, renderStill, selectComposition} from '@remotion/renderer';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const job = process.env.JOB_DIR ?? '/job', work = '/tmp/work', out = join(job, 'out');
await mkdir(work, {recursive: true}); await mkdir(out, {recursive: true});
for (const f of ['root.tsx', 'kit.tsx']) await copyFile(join(process.env.KIT_DIR ?? '/app', f), join(work, f));
await copyFile(join(job, 'graphic.tsx'), join(work, 'graphic.tsx'));
const input = JSON.parse(await readFile(join(job, 'input.json'), 'utf8'));
const t0 = Date.now(); const report = {stage: 'bundle'};
try {
  const serveUrl = await bundle({entryPoint: join(work, 'root.tsx'), outDir: join(work, 'bundle'), enableCaching: false,
    webpackOverride: c => ({...c, cache: false, resolve: {...c.resolve, modules: [process.env.NODE_MODULES ?? '/app/node_modules', 'node_modules']}})});
  report.bundleSeconds = (Date.now() - t0) / 1000; report.stage = 'props';
  const chromiumOptions = {gl: 'swangle'};
  const composition = await selectComposition({serveUrl, id: 'Graphic', inputProps: input, chromiumOptions, timeoutInMilliseconds: 20000});
  const resolved = composition.props?.resolved ?? {};
  report.props = resolved.props ?? null; report.defaultProps = resolved.defaultProps ?? null; report.jsonSchema = resolved.jsonSchema ?? null;
  const inputProps = {...input, props: report.props ?? input.props};
  report.stage = 'stills';
  for (const frame of input.stills ?? []) await renderStill({serveUrl, composition, inputProps: {...inputProps, checker: true}, frame, output: join(out, `still-${frame}.jpg`), imageFormat: 'jpeg', jpegQuality: 85, chromiumOptions, timeoutInMilliseconds: 20000});
  if (!input.stillsOnly) {
    report.stage = 'video'; const t1 = Date.now();
    await renderMedia({serveUrl, composition, inputProps, codec: 'vp9', pixelFormat: 'yuva420p', imageFormat: 'png', outputLocation: join(out, 'graphic.webm'), concurrency: Number(process.env.CONCURRENCY ?? 2), chromiumOptions, timeoutInMilliseconds: 20000});
    report.videoSeconds = (Date.now() - t1) / 1000;
    if (input.prores) await renderMedia({serveUrl, composition, inputProps, codec: 'prores', proResProfile: '4444', pixelFormat: 'yuva444p10le', imageFormat: 'png', outputLocation: join(out, 'graphic.mov'), concurrency: Number(process.env.CONCURRENCY ?? 2), chromiumOptions});
  }
  report.stage = 'done'; report.ok = true;
} catch (e) { report.ok = false; report.error = String(e?.stack ?? e).slice(0, 4000); }
report.totalSeconds = (Date.now() - t0) / 1000;
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ok: report.ok, stage: report.stage, totalSeconds: report.totalSeconds}));
process.exit(report.ok ? 0 : 1);
