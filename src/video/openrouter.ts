export async function askPlanner(system:string,input:unknown,jsonSchema:object,model=process.env.VIDEO_EDIT_MODEL??'anthropic/claude-sonnet-4.6',request:(url:string,init?:RequestInit)=>Promise<Response>=fetch) {
  const key=process.env.OPENROUTER_API_KEY;if(!key)throw new Error('Set OPENROUTER_API_KEY for take selection and graphics planning');
  const response=await request('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
    signal:AbortSignal.timeout(180000),body:JSON.stringify({model,temperature:0,max_tokens:12000,provider:{require_parameters:true},messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(input)}],response_format:{type:'json_schema',json_schema:{name:'video_edit_plan',strict:true,schema:jsonSchema}}})});
  if(!response.ok)throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0,600)}`);
  const result=await response.json() as any;
  if(result.error)throw new Error(`OpenRouter: ${JSON.stringify(result.error)}`);
  const choice=result.choices?.[0];
  if(choice?.finish_reason==='length')throw new Error('Planner output was truncated; use a shorter recording');
  if(typeof choice?.message?.content!=='string')throw new Error('Planner returned no JSON content');
  return {plan:JSON.parse(choice.message.content),model:result.model??model,usage:result.usage??null};
}
/** Vision call for the footage index: stills as data URLs, JSON object out. */
export async function askVision(system:string,parts:import('./footage-index').VisionPart[],model=process.env.VIDEO_INDEX_MODEL??'google/gemini-3.8-flash',request:(url:string,init?:RequestInit)=>Promise<Response>=fetch) {
  const key=process.env.OPENROUTER_API_KEY;if(!key)throw new Error('Set OPENROUTER_API_KEY for footage indexing');
  const content=parts.map(p=>p.type==='text'?{type:'text',text:p.text}:{type:'image_url',image_url:{url:`data:image/jpeg;base64,${Buffer.from(p.jpeg).toString('base64')}`}});
  const response=await request('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
    signal:AbortSignal.timeout(240000),body:JSON.stringify({model,temperature:0.2,max_tokens:32000,usage:{include:true},response_format:{type:'json_object'},
      messages:[{role:'system',content:system},{role:'user',content}]})});
  if(!response.ok)throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0,600)}`);
  const result=await response.json() as any;
  if(result.error)throw new Error(`OpenRouter: ${JSON.stringify(result.error)}`);
  const choice=result.choices?.[0];
  if(choice?.finish_reason==='length')throw new Error('Index output was truncated; use smaller batches');
  const text=typeof choice?.message?.content==='string'?choice.message.content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g,''):'';
  if(!text)throw new Error('Index model returned no content');
  return {json:JSON.parse(text),model:result.model??model,costUsd:typeof result.usage?.cost==='number'?result.usage.cost:undefined};
}
/** Free-text chat call for the graphic writer (returns a TSX module, not JSON). */
export async function askWriter(messages:{role:'system'|'user'|'assistant';content:string}[],model=process.env.VIDEO_GRAPHIC_MODEL??'anthropic/claude-opus-5.5',request:(url:string,init?:RequestInit)=>Promise<Response>=fetch) {
  const key=process.env.OPENROUTER_API_KEY;if(!key)throw new Error('Set OPENROUTER_API_KEY for graphics');
  const response=await request('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
    signal:AbortSignal.timeout(240000),body:JSON.stringify({model,max_tokens:8000,usage:{include:true},messages})});
  if(!response.ok)throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0,600)}`);
  const result=await response.json() as any;
  if(result.error)throw new Error(`OpenRouter: ${JSON.stringify(result.error)}`);
  const choice=result.choices?.[0];
  if(choice?.finish_reason==='length')throw new Error('Graphic code was truncated');
  if(typeof choice?.message?.content!=='string'||!choice.message.content)throw new Error('Graphic writer returned no content');
  return {text:choice.message.content as string,model:result.model??model,costUsd:typeof result.usage?.cost==='number'?result.usage.cost:undefined};
}
/** Video call (Gemini reads the clip itself): one MP4 as a data URL plus text, JSON object out. */
export async function askVideo(system:string,text:string,mp4:Uint8Array,model=process.env.VIDEO_MOMENTS_MODEL??'google/gemini-3.8-flash',request:(url:string,init?:RequestInit)=>Promise<Response>=fetch) {
  const key=process.env.OPENROUTER_API_KEY;if(!key)throw new Error('Set OPENROUTER_API_KEY for video understanding');
  const response=await request('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
    signal:AbortSignal.timeout(300000),body:JSON.stringify({model,temperature:0.2,max_tokens:32000,usage:{include:true},response_format:{type:'json_object'},
      messages:[{role:'system',content:system},{role:'user',content:[{type:'video_url',video_url:{url:`data:video/mp4;base64,${Buffer.from(mp4).toString('base64')}`}},{type:'text',text}]}]})});
  if(!response.ok)throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0,600)}`);
  const result=await response.json() as any;
  if(result.error)throw new Error(`OpenRouter: ${JSON.stringify(result.error)}`);
  const choice=result.choices?.[0];
  if(choice?.finish_reason==='length')throw new Error('Video output was truncated; use shorter chunks');
  const out=typeof choice?.message?.content==='string'?choice.message.content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g,''):'';
  if(!out)throw new Error('Video model returned no content');
  return {json:JSON.parse(out),model:result.model??model,costUsd:typeof result.usage?.cost==='number'?result.usage.cost:undefined};
}
