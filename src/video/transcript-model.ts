import {z} from 'zod';
export const wordSchema=z.object({id:z.number().int().nonnegative(),text:z.string().min(1),start:z.number().finite().nonnegative(),end:z.number().finite().nonnegative(),confidence:z.number().min(0).max(1)}).strict();
export const transcriptSchema=z.object({version:z.literal(1),provider:z.literal('assemblyai'),providerId:z.string().min(1),source:z.string(),sourceHash:z.string(),duration:z.number().positive(),model:z.string(),words:z.array(wordSchema).min(1)}).strict().superRefine((t,ctx)=>{
  t.words.forEach((w,i)=>{if(w.id!==i || w.end<=w.start || w.end>t.duration+0.15 || (i>0&&w.start<t.words[i-1]!.start))ctx.addIssue({code:'custom',path:['words',i],message:'Invalid word ID or timestamp'});});
});
export type Transcript=z.infer<typeof transcriptSchema>;
export function normalizeTranscript(raw:any,source:string,sourceHash:string,duration:number):Transcript {
  return transcriptSchema.parse({version:1,provider:'assemblyai',providerId:raw.id,source,sourceHash,duration,model:raw.speech_model_used??'unknown',
    // A file cut mid-word gets a last word that ends past the file: end it at the file's end.
    words:(raw.words??[]).filter((w:any)=>w.start/1000<duration).map((w:any,id:number)=>({id,text:w.text,start:w.start/1000,end:Math.min(w.end/1000,duration),confidence:w.confidence??0}))});
}
