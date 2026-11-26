import {editSchema,type Edit} from './model';
import type {Transcript} from './transcript-model';
import type {TakePlan,GraphicsPlan} from './planner';
import {digest} from './hash';
export function eligibleWords(edit:Edit,t:Transcript) {
  return t.words.filter(w=>edit.scenes.some(s=>w.start>=s.in-0.001&&w.end<=s.out+0.001));
}
function wordRange(t:Transcript,start:number,end:number,allowed:Set<number>) {
  if(start>end || !t.words[start] || !t.words[end])throw new Error(`Invalid word range ${start}–${end}`);
  const words=t.words.slice(start,end+1);
  if(words.some(w=>!allowed.has(w.id)))throw new Error(`Word range ${start}–${end} includes footage outside the edit`);
  return words;
}
function textRange(t:Transcript,start:number,end:number) {return t.words.slice(start,end+1).map(w=>w.text).join(' ');}
export function validateTakes(edit:Edit,t:Transcript,plan:TakePlan,threshold:number) {
  if(!Number.isFinite(threshold)||threshold<0||threshold>1)throw new Error('Confidence must be between 0 and 1');
  const allowed=new Set(eligibleWords(edit,t).map(w=>w.id));
  const occupied=new Set<number>();
  for(const r of plan.removals) {
    const words=wordRange(t,r.startWord,r.endWord,allowed);
    for(const w of words) {if(occupied.has(w.id))throw new Error('Take removals overlap');occupied.add(w.id);}
    if((r.keptStartWord===null)!==(r.keptEndWord===null))throw new Error('Both kept word IDs must be supplied together');
    if(r.kind!=='setup'&&r.keptStartWord===null)throw new Error('Retakes and false starts require a surviving replacement');
    if(r.keptStartWord!==null)wordRange(t,r.keptStartWord,r.keptEndWord!,allowed);
  }
  const removed=new Set(plan.removals.filter(r=>r.confidence>=threshold).flatMap(r=>t.words.slice(r.startWord,r.endWord+1).map(w=>w.id)));
  for(const r of plan.removals.filter(r=>r.confidence>=threshold)) {
    if(r.keptStartWord!==null && t.words.slice(r.keptStartWord,r.keptEndWord!+1).some(w=>removed.has(w.id)))throw new Error('A selected replacement take would also be removed');
  }
  if(allowed.size>0&&[...allowed].every(id=>removed.has(id)))throw new Error('Plan removes all speech');
  return removed;
}
/**
 * Fix the take-plan mistakes models repeat even after a repair round, so one
 * bad decision costs one cut instead of the whole clip's stumble check:
 * a cut that runs into its own kept take is trimmed to stop before it
 * (145–147 keeping 147–148 becomes 145–146), a cut overlapping an earlier one
 * is dropped, and an applied cut whose replacement another applied cut removes
 * drops below the threshold so it lands in review. Unknown word IDs are left
 * for validateTakes to reject.
 */
export function reconcileTakes(plan:TakePlan,threshold:number):TakePlan {
  const trimmed=plan.removals.flatMap(r=>{
    if(r.keptStartWord===null||r.keptEndWord===null||r.startWord>r.keptEndWord||r.endWord<r.keptStartWord)return [r];
    if(r.keptStartWord>r.startWord)return [{...r,endWord:Math.min(r.endWord,r.keptStartWord-1)}];
    if(r.keptEndWord<r.endWord)return [{...r,startWord:Math.max(r.startWord,r.keptEndWord+1)}];
    return [];
  });
  const occupied=new Set<number>();
  let removals=trimmed.filter(r=>{
    for(let id=r.startWord;id<=r.endWord;id++)if(occupied.has(id))return false;
    for(let id=r.startWord;id<=r.endWord;id++)occupied.add(id);
    return true;
  });
  for(let changed=true;changed;) {
    changed=false;
    const applied=removals.filter(r=>r.confidence>=threshold);
    const removed=new Set(applied.flatMap(r=>Array.from({length:r.endWord-r.startWord+1},(_,i)=>r.startWord+i)));
    const conflict=applied.find(r=>r.keptStartWord!==null&&Array.from({length:r.keptEndWord!-r.keptStartWord+1},(_,i)=>r.keptStartWord!+i).some(id=>removed.has(id)));
    if(!conflict)break;
    const below=threshold-0.01;
    removals=below<0?removals.filter(r=>r!==conflict):removals.map(r=>r===conflict
      ?{...r,confidence:below,reason:`${r.reason} Not applied: another cut removes its replacement.`.slice(0,600)}:r);
    changed=true;
  }
  return {...plan,removals};
}
export function buildTakeEdit(edit:Edit,t:Transcript,plan:TakePlan,threshold=0.85,trimPauses=true) {
  const removed=validateTakes(edit,t,plan,threshold);
  const cuts:Array<{start:number;end:number;reason:string}>=[];
  for(const r of plan.removals.filter(r=>r.confidence>=threshold)) {
    const first=t.words[r.startWord]!,last=t.words[r.endWord]!,prev=t.words[r.startWord-1],next=t.words[r.endWord+1];
    cuts.push({start:prev?Math.min(first.start,Math.max(prev.end,first.start-0.06)):0,
      end:next?Math.max(last.end,Math.min(next.start,last.end+0.06)):t.duration,reason:r.kind});
  }
  if(trimPauses) {
    for(let i=0;i<=t.words.length;i++) {
      const left=i===0?0:t.words[i-1]!.end,right=i===t.words.length?t.duration:t.words[i]!.start;
      if(right-left>1.2)cuts.push({start:i===0?0:left+0.2,end:i===t.words.length?t.duration:right-0.2,reason:'pause'});
    }
  }
  cuts.sort((a,b)=>a.start-b.start);
  const result=structuredClone(edit);
  result.scenes=edit.scenes.flatMap(scene=>{
    const kept:Array<{start:number;end:number}>=[];let cursor=scene.in;
    for(const cut of cuts) {
      const start=Math.max(scene.in,cut.start),end=Math.min(scene.out,cut.end);
      if(end<=start)continue;
      if(start>cursor)kept.push({start:cursor,end:start});
      cursor=Math.max(cursor,end);
    }
    if(cursor<scene.out)kept.push({start:cursor,end:scene.out});
    return kept.filter(r=>Math.round(r.end*edit.fps)>Math.round(r.start*edit.fps)).map((r,i)=>({...scene,id:`${scene.id}-take-${i+1}`,in:r.start,out:r.end,
      ...(scene.broll?{broll:{...scene.broll,in:scene.broll.in+r.start-scene.in}}:{}),
      ...(scene.graphics?{graphics:scene.graphics.map(g=>({...g,in:Math.max(g.in,r.start),out:Math.min(g.out,r.end)})).filter(g=>g.out-g.in>=1/edit.fps)}:{})}));
  });
  const captions:Edit['captions']=[];
  for(const scene of result.scenes) {
    let group:Transcript['words']=[];
    const flush=()=>{if(group.length)captions.push({sceneId:scene.id,start:group[0]!.start,end:group.at(-1)!.end,text:group.map(w=>w.text).join(' ')});group=[];};
    for(const w of t.words) {
      if(removed.has(w.id)||w.start<scene.in-0.001||w.end>scene.out+0.001){flush();continue;}
      if(group.length && (w.start-group.at(-1)!.end>0.5 || group.length>=7 || group.map(x=>x.text).join(' ').length+w.text.length>100))flush();
      group.push(w);if(/[.!?]$/.test(w.text))flush();
    }
    flush();
  }
  result.captions=captions;
  return {edit:editSchema.parse(result),cuts,decisions:plan.removals.map(r=>({...r,applied:r.confidence>=threshold,removedText:textRange(t,r.startWord,r.endWord),keptText:r.keptStartWord===null?null:textRange(t,r.keptStartWord,r.keptEndWord!)}))};
}
export function buildGraphicsEdit(edit:Edit,t:Transcript,plan:GraphicsPlan) {
  const result=structuredClone(edit);
  for(const [i,g] of plan.graphics.entries()) {
    const scene=result.scenes.find(s=>s.id===g.sceneId);if(!scene)throw new Error(`Unknown graphic scene: ${g.sceneId}`);
    if(scene.title)throw new Error('Graphic overlaps an existing manual scene title; remove the title or skip this scene');
    const words=wordRange(t,g.startWord,g.endWord,new Set(t.words.filter(w=>w.start>=scene.in-0.001&&w.end<=scene.out+0.001).map(w=>w.id)));
    const start=words[0]!.start,end=Math.min(scene.out,start+5,Math.max(words.at(-1)!.end,start+2));
    if((scene.graphics??[]).some(g=>g.in<end&&g.out>start))throw new Error('Graphics overlap in a scene');
    if(end-start<0.5)throw new Error('Graphic needs at least half a second in its scene');
    scene.graphics=[...(scene.graphics??[]),{id:`graphic-${digest(plan).slice(0,8)}-${i+1}`,in:start,out:end,text:g.text,style:g.style}];
  }
  return editSchema.parse(result);
}
