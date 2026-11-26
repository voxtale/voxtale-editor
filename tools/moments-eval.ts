// Scores clip-moment providers against a hand-labelled truth
// (data/video-eval/<name>/truth.json): does each provider find the changes,
// and does what it says at the moment the speaker points at it match?
//   bun tools/moments-eval.ts data/video-eval/devs-quitting-software --provider dense
//   bun tools/moments-eval.ts data/video-eval/devs-quitting-software --score   (re-score saved runs)
// Runs spend OpenRouter credits; --score does not.
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {localFrames} from '@voxtale/frames';
import {askVision} from '../src/video/openrouter';
import {clipMomentsSchema,denseMoments,type ClipMoments,type MomentWord} from '../src/video/moments';
import {geminiVideoMoments} from '../src/video/moments-gemini';

interface Truth {
  clips:Record<string,{file:string;hash:string;duration:number;audio:boolean}>;
  source:string;
  sync:{clip:string;with:string;offset:number};
  changes:{t:number;what:string}[];
  states:{start:number;end:number;what:string;find:string[][]}[];
  queries:{said:number;words:string;find:string[];expect:[number,number]}[];
}

const ENGINE=join(homedir(),'Library/Application Support/VoxTale Local/voxtale/engine/blobs/users/local/video/clips');
const text=(m:ClipMoments['moments'][number])=>[m.description,m.changed,...m.onScreenText,...m.subjects].join(' ').toLowerCase();

export function score(truth:Truth,run:ClipMoments) {
  const ms=run.moments;
  const near=truth.changes.map(c=>{
    const d=Math.min(...ms.map(m=>Math.abs(m.start-c.t)));
    return {...c,error:d,found:d<=3};
  });
  const states=truth.states.flatMap(s=>s.find.map(group=>{
    const hit=ms.some(m=>m.end>s.start&&m.start<s.end&&group.some(g=>text(m).includes(g)));
    return {what:s.what,find:group.join('|'),hit};
  }));
  const queries=truth.queries.map(q=>{
    const t=Math.min(q.expect[1],Math.max(q.expect[0],q.said+2));
    const m=ms.find(x=>x.start<=t&&x.end>t);
    return {words:q.words,at:t,moment:m?.id??null,hit:!!m&&q.find.some(f=>text(m).includes(f))};
  });
  const share=(xs:{found?:boolean;hit?:boolean}[])=>+(xs.filter(x=>x.found??x.hit).length/xs.length).toFixed(2);
  return {provider:run.provider,model:run.model,moments:ms.length,costUsd:run.costUsd,seconds:+(run.ms/1000).toFixed(1),
    changeRecall:share(near),changeErrorS:+(near.filter(x=>x.found).reduce((n,x)=>n+x.error,0)/Math.max(1,near.filter(x=>x.found).length)).toFixed(2),
    stateRecall:share(states),queryHit:share(queries),
    missed:{changes:near.filter(x=>!x.found).map(x=>`${x.t}s ${x.what}`),states:states.filter(x=>!x.hit).map(x=>`${x.what}: ${x.find}`),
      queries:queries.filter(x=>!x.hit).map(x=>`${x.words} @${x.at}s → ${x.moment}`)}};
}

async function main() {
  const dir=process.argv[2];
  if(!dir)throw new Error('usage: bun tools/moments-eval.ts <eval dir> [--provider dense|gemini-video] [--score]');
  const truth=JSON.parse(await readFile(join(dir,'truth.json'),'utf8')) as Truth;
  const flag=(name:string)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:undefined;};
  if(!process.argv.includes('--score')) {
    const provider=flag('--provider')??'dense';
    const src=truth.source.replace(/^~/,homedir());
    const clip=truth.clips[truth.sync.clip]!,voice=truth.clips[truth.sync.with]!;
    const transcript=JSON.parse(await readFile(join(ENGINE,voice.hash,'transcript.json'),'utf8')) as {words:MomentWord[]};
    const words=transcript.words.map(w=>({text:w.text,start:w.start+truth.sync.offset,end:w.end+truth.sync.offset}));
    const frames=localFrames({sources:{[clip.hash]:join(src,clip.file)},dir:await mkdtemp(join(tmpdir(),'moments-eval-'))});
    const progress=(m:string)=>console.error(m);
    const input={hash:clip.hash,duration:clip.duration,words,frames};
    const run=provider==='dense'?await denseMoments(input,askVision,{progress})
      :provider==='gemini-video'?await geminiVideoMoments({...input,file:join(src,clip.file)},{progress})
      :(()=>{throw new Error(`unknown provider ${provider}`);})();
    await writeFile(join(dir,`${provider}.json`),JSON.stringify(run,null,1));
  }
  const runs=(await readdir(dir)).filter(f=>f.endsWith('.json')&&f!=='truth.json'&&f!=='scores.json');
  const scores=[];
  for(const f of runs)scores.push(score(truth,clipMomentsSchema.parse(JSON.parse(await readFile(join(dir,f),'utf8')))));
  await writeFile(join(dir,'scores.json'),JSON.stringify(scores,null,1));
  console.log(JSON.stringify(scores,null,1));
}

if(import.meta.main)await main();
