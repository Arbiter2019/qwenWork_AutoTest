import { createHash } from 'node:crypto';
import type { AppEvent, ModelType, TaskQuestion, TaskSnapshot } from '../../core/src/types.ts';

export interface MessageRow {id:string; role:string; parts:string; metadata:string|null; created_at:number; updated_at:number}
export const json=(value:string|null|undefined,fallback:any={})=>{try{return JSON.parse(value??'');}catch{return fallback;}};
export function inputMatches(row:{prompt_preview?:string;content?:string},prompt:string,parts:any[]=[]):boolean {
 return String(row.prompt_preview??'').includes(prompt)||String(row.content??'').includes(prompt)||parts.some(p=>p.type==='text'&&String(p.text??'').includes(prompt));
}
export function redactEvent(value:any):any {
 if(Array.isArray(value))return value.map(redactEvent);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)$/i.test(k)?'[已隐藏]':redactEvent(v)]));
 if(typeof value==='string')return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [已隐藏]');
 return value;
}
export function modelName(value:string):ModelType|undefined{return value==='flash'?'标准':value==='pro'?'高级':undefined;}
export function parseQuestion(part:any):TaskQuestion|undefined {
 if(!/AskUserQuestion|userAskQuestion/i.test(part.toolName??part.type??'')||!['input-available','approval-requested'].includes(part.state))return;
 const input=part.input??{};
 const questions=(Array.isArray(input.questions)?input.questions:[input]).map((q:any)=>({text:String(q.question??q.text??''),options:(q.options??[]).map((o:any)=>String(typeof o==='string'?o:o.label??o.text??o.value??'')),multiple:!!(q.multiSelect??q.multiple)}));
 return {id:String(part.toolCallId??part.id),kind:questions.length&&questions.every((q:any)=>q.options.length)?'choice':'text',questions};
}
const text=(parts:any[])=>parts.filter(p=>p.type==='text').map(p=>p.text??'').join('\n');
export function snapshotFromMessages(rows:MessageRow[],model:string):TaskSnapshot {
 const events:AppEvent[]=[];let actualInput:string|undefined,output='',question:TaskQuestion|undefined;let terminal:any,err:any;
 for(const row of rows){const parts=json(row.parts,[]);const metadata=json(row.metadata);if(!Array.isArray(parts))continue;
  if(row.role==='user')actualInput=text(parts);
  if(row.role==='assistant'){output=text(parts)||output;terminal=metadata;err=undefined;question=undefined;for(const part of parts){question=parseQuestion(part)??question;if(part.type==='error')err=part;}}
  for(let i=0;i<parts.length;i++){const part=parts[i];const digest=createHash('sha256').update(JSON.stringify(part)).digest('hex').slice(0,16);events.push({id:`${row.id}:${i}:${digest}`,source:'app-message-projection',type:part.type??'unknown',at:new Date(row.updated_at*1000).toISOString(),payload:redactEvent({role:row.role,part})});}
  if(metadata.taskStatus||metadata.status)events.push({id:`${row.id}:status:${metadata.taskStatus??metadata.status}`,source:'app-message-projection',type:'task_status',at:new Date(row.updated_at*1000).toISOString(),payload:{status:metadata.status,taskStatus:metadata.taskStatus,resultSubtype:metadata.resultSubtype,durationMs:metadata.durationMs}});
 }
 let status:TaskSnapshot['status']='running';
 if(['stopped','cancelled','canceled','aborted'].includes(terminal?.taskStatus)||['stopped','cancelled','canceled','aborted'].includes(terminal?.status)||/cancel|abort|interrupt/.test(terminal?.resultSubtype??''))status='stopped';
 else if(err||terminal?.taskStatus==='failed'||terminal?.status==='failed'||terminal?.resultSubtype==='error')status='failed';
 else if(terminal?.taskStatus==='completed'&&terminal?.status==='completed'&&terminal?.resultSubtype==='success')status='succeeded';
 else if(question)status='waiting_human';
 const quota=err?.failureKind==='credit-exhausted'||err?.stableCode==='balance_insufficient'||err?.errorCode===402;
 const limited=!quota&&(err?.errorCode===429||/rate.limit|too many requests|限频|请求过于频繁/i.test(err?.text??''));
 return {status,events,actualInput,actualModel:modelName(model),output,question:status==='waiting_human'?question:undefined,error:err?`${err.text??'App 任务失败'}${err.stableCode?' ('+err.stableCode+')':''}`:undefined,errorCode:quota?'credit_exhausted':limited?'rate_limit':err?.stableCode??(err?'app_error':undefined),retryAfterMs:limited?Number(err.retryAfterMs??(err.retryAfter?err.retryAfter*1000:0))||undefined:undefined,collection:'partial',collectionReason:'当前版本以 App 消息投影采集回复、工具片段及终止状态；不保证捕获两次轮询之间的全部瞬时事件。'};
}
