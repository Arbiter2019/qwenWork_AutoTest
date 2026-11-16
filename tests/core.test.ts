import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseCsv, CSV_TEMPLATE } from '../packages/core/src/csv.ts';
import { metrics } from '../packages/core/src/metrics.ts';
import { reportCsv, reportHtml } from '../packages/core/src/report.ts';
import { reportJson } from '../packages/core/src/report.ts';
import { parse } from 'csv-parse/sync';
import { Scheduler, retryDelay } from '../packages/core/src/scheduler.ts';
import { Store } from '../packages/storage/src/store.ts';
import { DEFAULT_CONFIG, type AppAdapter, type RunRecord, type SampleInput, type TaskRef, type TaskSnapshot } from '../packages/core/src/types.ts';

const inputs = (n: number): SampleInput[] => Array.from({length:n},(_,i)=>({id:String(i+1),prompt:`prompt ${i+1}`,expertKitId:'',model:'标准'}));
class ControlledAdapter implements AppAdapter {
  submissions: {id:string; attemptId:string; ref:TaskRef}[]=[];
  snapshots = new Map<string,TaskSnapshot>();
  answers: number[][][]=[]; stops=0; confirmedStop=true;
  async health(){return {connected:true,mode:'simulation' as const};}
  async submit(input:SampleInput,attemptId:string){const ref={taskId:`task-${this.submissions.length}`};this.submissions.push({id:input.id,attemptId,ref});this.snapshots.set(ref.taskId,{status:'running'});return ref;}
  async inspect(ref:TaskRef){return this.snapshots.get(ref.taskId)!;}
  async answer(_ref:TaskRef,_question:unknown,indices:number[][]){this.answers.push(indices);}
  async stop(ref:TaskRef){this.stops++;if(this.confirmedStop)this.snapshots.set(ref.taskId,{status:'stopped'});return this.confirmedStop;}
  complete(index:number,status:'succeeded'|'failed'='succeeded',extra:Partial<TaskSnapshot>={}){this.snapshots.set(this.submissions[index].ref.taskId,{status,...extra});}
}
const config = { ...DEFAULT_CONFIG, pollIntervalMs: 10, batchIntervalMs: 0, retryInitialMs: 10, retryStepMs: 5, retryMaxMs: 60 };
const tick = async (ms=30)=>{await vi.advanceTimersByTimeAsync(ms);};
afterEach(()=>vi.useRealTimers());

describe('CSV',()=>{
  it('round trips template and preserves quoted newlines and leading zero IDs',()=>{
    expect(parseCsv(CSV_TEMPLATE).errors).toEqual([]);
    const result=parseCsv('\uFEFFID,Prompt,专家套件ID,模型类型\r\n001,"a,b\n""c""",,\r\n');
    expect(result.samples).toEqual([{id:'001',prompt:'a,b\n"c"',expertKitId:'',model:'标准'}]);
  });
  it('blocks duplicates and invalid values with physical row numbers',()=>{
    const r=parseCsv('ID,Prompt,专家套件ID,模型类型\n1,hello,,标准\n1,other,,未知\n2,   ,,高级');
    expect(r.errors.map(e=>e.line)).toEqual([3,3,4]);
    expect(r.samples).toEqual([]);
  });
  it('reports physical line numbers after blank lines and quoted newlines',()=>{
    const r=parseCsv('ID,Prompt,专家套件ID,模型类型\n\n1,"a\nb",,标准\n\n2,x,,bad');expect(r.errors[0].line).toBe(6);
  });
});
describe('scheduler',()=>{
  it('preserves a completed result when stopping races with completion',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);const r=await q.start(inputs(1),config);await tick();a.complete(0);q.stop(r.id);await tick();expect(s.get(r.id)?.samples[0].status).toBe('succeeded');expect(a.stops).toBe(0);s.close();
  });
  it('preserves success that races with timeout stop and does not retry',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);a.stop=async()=>{a.complete(0);return true;};const r=await q.start(inputs(1),{...config,timeoutMs:20});await tick(100);expect(a.submissions).toHaveLength(1);expect(s.get(r.id)?.samples[0].status).toBe('succeeded');s.close();
  });
  it('checks an observable rate limit before submitting remaining batch items',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);const submit=a.submit.bind(a);a.submit=async(input,id)=>{const ref=await submit(input,id);if(a.submissions.length===1)a.snapshots.set(ref.taskId,{status:'failed',errorCode:'rate_limit',retryAfterMs:1000});return ref;};await q.start(inputs(4),{...config,concurrency:4});await tick(100);expect(a.submissions).toHaveLength(1);q.dispose();s.close();
  });
  it('rejects a known invalid suite before starting any task',async()=>{
    const a=new ControlledAdapter() as ControlledAdapter&{preflight:(input:SampleInput[])=>Promise<void>};a.preflight=async()=>{throw new Error('套件不可用');};const s=new Store(':memory:'),q=new Scheduler(s,a);await expect(q.start(inputs(2),config)).rejects.toThrow('套件不可用');expect(a.submissions).toHaveLength(0);s.close();
  });
  it('holds the 2/2/1 barrier through retries and creates independent task IDs',async()=>{
    vi.useFakeTimers(); const adapter=new ControlledAdapter(),store=new Store(':memory:');const scheduler=new Scheduler(store,adapter);
    const run=await scheduler.start(inputs(5),config);await tick(); expect(adapter.submissions.map(x=>x.id)).toEqual(['1','2']);
    adapter.complete(0);adapter.complete(1,'failed');await tick();expect(adapter.submissions.map(x=>x.id)).toEqual(['1','2','2']);
    adapter.complete(2);await tick();expect(adapter.submissions.map(x=>x.id)).toEqual(['1','2','2','3','4']);
    adapter.complete(3);adapter.complete(4);await tick();expect(adapter.submissions.map(x=>x.id)).toEqual(['1','2','2','3','4','5']);
    adapter.complete(5);await tick();expect(store.get(run.id)?.status).toBe('completed');store.close();
  });
  it('counts N as additional retries and continues after exhaustion',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);const r=await q.start(inputs(2),{...config,concurrency:1});
    for(let i=0;i<3;i++){await tick();a.complete(i,'failed');await tick();}
    expect(a.submissions.map(x=>x.id)).toEqual(['1','1','1','2']);a.complete(3);await tick();expect(s.get(r.id)?.samples[0].status).toBe('failed');s.close();
  });
  it('uses linear capped retry delay',()=>{expect([1,2,3,11,12,20].map(i=>retryDelay(i,DEFAULT_CONFIG))).toEqual([10000,15000,20000,60000,60000,60000]);});
  it('does not retry an uncertain submission or unconfirmed timeout stop',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter();a.confirmedStop=false;const s=new Store(':memory:'),q=new Scheduler(s,a);const r=await q.start(inputs(1),{...config,timeoutMs:30});await tick(80);
    expect(s.get(r.id)?.status).toBe('needs_review');expect(a.submissions).toHaveLength(1);expect(a.stops).toBe(1);q.dispose();s.close();
  });
  it('answers each question with first choice once even if the event repeats',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);const r=await q.start(inputs(1),config);await tick();
    a.snapshots.set(a.submissions[0].ref.taskId,{status:'waiting_human',question:{id:'question-1',kind:'choice',questions:[{text:'a',options:['x','y']},{text:'b',options:['1','2'],multiple:true}]}});
    await tick(80);expect(a.answers).toEqual([[[0],[0]]]);expect(s.get(r.id)?.samples[0].attempts[0].events.filter(e=>e.type==='question')).toHaveLength(1);a.complete(0);await tick();expect(s.get(r.id)?.status).toBe('completed');s.close();
  });
  it('restores submitting intent as needs_review without resubmitting',async()=>{
    const s=new Store(':memory:'),a=new ControlledAdapter(),q=new Scheduler(s,a);const r:RunRecord={id:'restore',name:'old',mode:'real',status:'running',config,createdAt:new Date().toISOString(),samples:inputs(1).map(input=>({...input,status:'submitting',batch:0,attempts:[{id:'attempt',index:0,status:'submitting',submittedAt:new Date().toISOString(),activeMs:0,humanWaitMs:0,collection:'partial',events:[],answeredQuestionIds:[]}],humanWaitMs:0})),currentBatch:0,paused:false,stopRequested:false};s.save(r);await q.recover();expect(s.get(r.id)?.status).toBe('needs_review');expect(a.submissions).toEqual([]);q.dispose();s.close();
  });
  it('accounts for execution and human waiting downtime during recovery',async()=>{
    vi.useFakeTimers();const now=Date.now(),s=new Store(':memory:'),a=new ControlledAdapter(),q=new Scheduler(s,a);const ref={taskId:'restored'};a.snapshots.set(ref.taskId,{status:'running'});const r:RunRecord={id:'restore-clock',name:'old',mode:'real',status:'running',config:{...config,timeoutMs:1000000},createdAt:new Date(now-10000).toISOString(),samples:inputs(1).map(input=>({...input,status:'waiting_human',batch:0,attempts:[{id:'attempt',index:0,status:'waiting_human',ref,submittedAt:new Date(now-10000).toISOString(),timingAt:new Date(now-5000).toISOString(),activeMs:1000,humanWaitMs:4000,collection:'partial',events:[],answeredQuestionIds:[]}],humanWaitMs:4000,startedAt:new Date(now-10000).toISOString()})),currentBatch:0,paused:false,stopRequested:false};s.save(r);await q.recover();await tick(10);expect(s.get(r.id)?.samples[0].humanWaitMs).toBeGreaterThanOrEqual(9000);expect(s.get(r.id)?.samples[0].attempts[0].activeMs).toBeLessThan(1100);q.dispose();s.close();
  });
  it('honours a longer server cooldown before any next submission',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);const r=await q.start(inputs(2),{...config,concurrency:1});await tick();a.complete(0,'failed',{errorCode:'rate_limit',retryAfterMs:100});await tick(50);expect(a.submissions).toHaveLength(1);await tick(70);expect(a.submissions).toHaveLength(2);a.complete(1);await tick();expect(a.submissions[2].id).toBe('2');a.complete(2);await tick();expect(s.get(r.id)?.status).toBe('completed');s.close();
  });
  it('pauses new batches while observations of existing tasks continue',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);const r=await q.start(inputs(2),{...config,concurrency:1});await tick();q.pause(r.id);a.complete(0);await tick();expect(a.submissions).toHaveLength(1);expect(s.get(r.id)?.samples[0].status).toBe('succeeded');await q.resume(r.id);await tick();expect(a.submissions).toHaveLength(2);a.complete(1);await tick();s.close();
  });
  it('suspends attempt timeout for human waiting but includes total waiting time',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);const r=await q.start(inputs(1),{...config,timeoutMs:100});await tick(10);
    a.snapshots.set(a.submissions[0].ref.taskId,{status:'waiting_human',question:{id:'free',kind:'text',questions:[{text:'provide details',options:[]}]}});await tick(200);expect(a.stops).toBe(0);expect(s.get(r.id)?.samples[0].humanWaitMs).toBeGreaterThan(150);a.complete(0);await tick();expect(s.get(r.id)?.samples[0].durationMs).toBeGreaterThan(200);s.close();
  });
  it('marks stopped run and cancels queued items only after active stop confirmation',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);const r=await q.start(inputs(2),{...config,concurrency:1});await tick();q.stop(r.id);await tick();expect(s.get(r.id)?.status).toBe('stopped');expect(s.get(r.id)?.samples.map(x=>x.status)).toEqual(['cancelled','cancelled']);expect(a.submissions).toHaveLength(1);s.close();
  });
  it('does not create another task when submission acknowledgement is lost',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:');a.submit=async()=>{throw new Error('connection lost after click');};const q=new Scheduler(s,a),r=await q.start(inputs(1),config);await tick(100);expect(s.get(r.id)?.status).toBe('needs_review');expect(s.get(r.id)?.samples[0].attempts).toHaveLength(1);q.dispose();s.close();
  });
  it('keeps elapsed duration monotonic when the wall clock changes',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);const r=await q.start(inputs(1),config);await tick(20);vi.setSystemTime(Date.now()+3600000);a.complete(0);await tick(20);expect(s.get(r.id)?.samples[0].durationMs).toBeLessThan(100);s.close();
  });
  it('enforces timeout while an already answered question remains visible',async()=>{
    vi.useFakeTimers();const a=new ControlledAdapter(),s=new Store(':memory:'),q=new Scheduler(s,a);const r=await q.start(inputs(1),{...config,maxRetries:0,timeoutMs:50});await tick(10);
    a.snapshots.set(a.submissions[0].ref.taskId,{status:'waiting_human',question:{id:'choice',kind:'choice',questions:[{text:'pick',options:['a','b']}]}});await tick(100);expect(a.stops).toBe(1);expect(s.get(r.id)?.samples[0].status).toBe('failed');s.close();
  });
});
describe('reports',()=>{
  it('uses imported denominator and successful sample total durations',()=>{
    const r:RunRecord={id:'r',name:'report',mode:'simulation',status:'completed',config,createdAt:'2026-01-01',currentBatch:0,paused:false,stopRequested:false,samples:inputs(4).map((input,i)=>({...input,status:i===3?'failed':'succeeded',batch:0,attempts:Array.from({length:i===2?2:1},(_,j)=>({id:`${i}-${j}`,index:j,status:i===3||i===2&&j===0?'failed':'succeeded',submittedAt:'2026-01-01',activeMs:0,humanWaitMs:0,collection:'partial',events:[],answeredQuestionIds:[]})),durationMs:(i+1)*100,humanWaitMs:0}))};
    expect(metrics(r)).toMatchObject({firstSuccessRate:.5,overallSuccessRate:.75,averageDurationMs:200});
    r.samples[0].attempts[0].ref={taskId:'mwe7g3izkl6r7h7h',chatId:'mwe7g3izkl6r7h7h',subChatId:'mwe7g3iz3wrhy8n4',sessionId:'effe7bfa-d07a-4ff6-b5fd-e542137181a8',inputId:'4c563f5e-b3d2-4aef-8c7f-b55488dc0fc4',messageId:'4c563f5e-b3d2-4aef-8c7f-b55488dc0fc4'};
    r.samples[2].attempts[0].ref={taskId:'first',inputId:'input-first'};r.samples[2].attempts[1].ref={taskId:'retry',inputId:'input-retry'};
    const rows=parse(reportCsv(r),{columns:true,bom:true}) as Record<string,string>[];
    expect(JSON.parse(rows[0]['关联信息'])).toEqual(r.samples[0].attempts[0].ref);
    expect(rows.filter((row:Record<string,string>)=>row['样本ID']==='3').map((row:Record<string,string>)=>JSON.parse(row['关联信息']).taskId)).toEqual(['first','retry']);
    expect(rows[1]['关联信息']).toBe('{}');expect(JSON.parse(reportJson(r)).samples[0].attempts[0].ref).toEqual(r.samples[0].attempts[0].ref);
    r.samples[0].prompt='<script>alert(1)</script>';r.samples[1].prompt='=1+1';expect(reportHtml(r)).not.toContain('<script>');expect(reportCsv(r)).toContain("'=1+1");expect(reportCsv(r)).toContain('关联信息');expect(reportCsv(r)).toContain('mwe7g3izkl6r7h7h');expect(reportHtml(r)).toContain('关联信息');
  });
});
