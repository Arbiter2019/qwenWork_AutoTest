import { describe, expect, it } from 'vitest';
import { snapshotFromMessages, parseQuestion, modelName, inputMatches, redactEvent } from '../packages/qwen-adapter/src/projection.ts';

const row=(id:string,parts:unknown[],metadata:unknown={},role='assistant')=>({id,role,parts:JSON.stringify(parts),metadata:JSON.stringify(metadata),created_at:1794386605,updated_at:1794386606});
describe('App message projection',()=>{
 it('requires explicit terminal success, never quiet text',()=>{
  expect(snapshotFromMessages([row('a',[{type:'text',text:'hello'}])],'flash').status).toBe('running');
  const s=snapshotFromMessages([row('u',[{type:'text',text:'prompt'}],{},'user'),row('a',[{type:'text',text:'done'}],{status:'completed',taskStatus:'completed',resultSubtype:'success'})],'flash');
  expect(s).toMatchObject({status:'succeeded',output:'done',actualInput:'prompt',actualModel:'标准',collection:'partial'});
 });
 it('keeps quota errors distinct from rate limiting',()=>{
  const quota=snapshotFromMessages([row('a',[{type:'error',text:'Provider request failed',errorCode:402,failureKind:'credit-exhausted',stableCode:'balance_insufficient'}],{taskStatus:'failed'})],'pro');
  expect(quota).toMatchObject({status:'failed',errorCode:'credit_exhausted',actualModel:'高级'});
  const rate=snapshotFromMessages([row('a',[{type:'error',text:'Too many requests',errorCode:429,retryAfterMs:80000}],{taskStatus:'failed'})],'flash');
  expect(rate).toMatchObject({status:'failed',errorCode:'rate_limit',retryAfterMs:80000});
 });
 it('preserves changing tool projections and never calls stopped success',()=>{
  const a=snapshotFromMessages([row('a',[{type:'tool-Test',toolCallId:'x',state:'input-available',input:{query:'a'}}])],'flash');
  const b=snapshotFromMessages([row('a',[{type:'tool-Test',toolCallId:'x',state:'output-available',output:{answer:1}}],{taskStatus:'stopped'})],'flash');
  expect(a.events?.[0].id).not.toBe(b.events?.[0].id);expect(b.status).toBe('stopped');
 });
 it('recognizes multi question choices and free text',()=>{
  const q=parseQuestion({type:'tool-AskUserQuestion',toolCallId:'q1',state:'input-available',input:{questions:[{question:'A?',options:[{label:'first'},'second'],multiSelect:true},{question:'B?',options:['yes','no']}]}});
  expect(q).toMatchObject({id:'q1',kind:'choice',questions:[{text:'A?',options:['first','second'],multiple:true},{text:'B?',options:['yes','no']}]});
  expect(parseQuestion({type:'tool-AskUserQuestion',toolCallId:'q2',state:'input-available',input:{question:'Why?'}})?.kind).toBe('text');
  expect(parseQuestion({type:'tool-AskUserQuestion',toolCallId:'q2',state:'output-available',input:{question:'Why?'}})).toBeUndefined();
 });
 it('does not assume unknown model is standard',()=>{expect(modelName('other')).toBeUndefined();});
 it('correlates a long prompt from persisted message parts even when preview is truncated',()=>{const prompt='很长的输入'.repeat(500);expect(inputMatches({prompt_preview:prompt.slice(0,100),content:'{}'},prompt,[{type:'text',text:'@[plugin:kit:套件] '+prompt}])).toBe(true);expect(inputMatches({prompt_preview:'prefix',content:'{}'},'different',[])).toBe(false);});
 it('redacts credential fields in observable events',()=>{expect(redactEvent({headers:{Authorization:'Bearer secret','x-api-key':'secret'},text:'normal',nested:{access_token:'secret'}})).toEqual({headers:{Authorization:'[已隐藏]','x-api-key':'[已隐藏]'},text:'normal',nested:{access_token:'[已隐藏]'}});});
 it('uses the latest authoritative result instead of stale errors',()=>{expect(snapshotFromMessages([row('old',[{type:'error',errorCode:429,text:'Too many requests'}],{taskStatus:'failed'}),row('new',[{type:'text',text:'done'}],{status:'completed',taskStatus:'completed',resultSubtype:'success'})],'flash').status).toBe('succeeded');});
});
