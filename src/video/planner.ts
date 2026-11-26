import {z} from 'zod';
const index=z.number().int().nonnegative();
export const takePlanSchema=z.object({removals:z.array(z.object({startWord:index,endWord:index,
  kind:z.enum(['retake','false-start','setup']),keptStartWord:index.nullable(),keptEndWord:index.nullable(),
  confidence:z.number().min(0).max(1),reason:z.string().min(1).max(600)}).strict()).max(500),summary:z.string().max(2000)}).strict();
export type TakePlan=z.infer<typeof takePlanSchema>;
export const graphicsPlanSchema=z.object({graphics:z.array(z.object({sceneId:z.string(),startWord:index,endWord:index,
  style:z.enum(['lower-third','callout','chapter']),text:z.string().trim().min(1).max(90),reason:z.string().min(1).max(500)}).strict()).max(100)}).strict();
export type GraphicsPlan=z.infer<typeof graphicsPlanSchema>;
const integer={type:'integer'},str={type:'string'};
const schema=(properties:object,required:string[])=>({type:'object',properties,required,additionalProperties:false});
export const TAKE_JSON=schema({removals:{type:'array',items:schema({startWord:integer,endWord:integer,kind:{type:'string',enum:['retake','false-start','setup']},keptStartWord:{type:['integer','null']},keptEndWord:{type:['integer','null']},confidence:{type:'number'},reason:str},['startWord','endWord','kind','keptStartWord','keptEndWord','confidence','reason'])},summary:str},['removals','summary']);
export const GRAPHICS_JSON=schema({graphics:{type:'array',items:schema({sceneId:str,startWord:integer,endWord:integer,style:{type:'string',enum:['lower-third','callout','chapter']},text:str,reason:str},['sceneId','startWord','endWord','style','text','reason'])}},['graphics']);
export {TAKE_PROMPT_ID,GRAPHICS_PROMPT_ID,AUDIT_PROMPT_ID} from './prompts';
