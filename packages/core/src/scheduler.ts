import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DEFAULT_CONFIG, type AppAdapter, type Attempt, type RunConfig, type RunRecord, type RunStore, type SampleInput, type SampleRecord, type TaskSnapshot } from './types.ts';

export function retryDelay(retryNumber:number,config:RunConfig){return Math.min(config.retryInitialMs+Math.max(0,retryNumber-1)*config.retryStepMs,config.retryMaxMs);}
export function validateConfig(value:Partial<RunConfig>={}):RunConfig {
  const c={...DEFAULT_CONFIG,...value};
  for(const [key,v] of Object.entries(c))if(!Number.isSafeInteger(v)||v<0)throw new Error(`${key} 必须为非负整数`);
  if(c.concurrency<1||c.concurrency>32)throw new Error('并发数量必须在 1–32 之间');
  if(c.timeoutMs<1||c.pollIntervalMs<1)throw new Error('超时及轮询间隔必须大于 0');
  if(c.maxRetries>100)throw new Error('额外重试次数不能大于 100');
  return c;
}
const terminalSample=(s:SampleRecord)=>['succeeded','failed','cancelled'].includes(s.status);
const terminalAttempt=(a:Attempt)=>['succeeded','failed','stopped'].includes(a.status);
const iso=(time=Date.now())=>new Date(time).toISOString();
const time=(value?:string)=>value?Date.parse(value):0;

export class Scheduler extends EventEmitter {
  private active?:RunRecord;
  private worker?:Promise<void>;
  private disposed=false;
  private stamps=new Map<string,number>();
  private sampleClocks=new WeakMap<SampleRecord,{started:number;base:number}>();
  private attemptClocks=new WeakMap<Attempt,{started:number;base:number}>();
  private wake?:()=>void;
  private unsubscribe?:()=>void;
  constructor(private store:RunStore,private adapter:AppAdapter){super();this.unsubscribe=adapter.subscribe?.(()=>this.wake?.());}
  private persist(run:RunRecord){this.store.save(run);this.emit('change',structuredClone(run));}
  private async sleep(ms:number){await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);this.wake=undefined;resolve();};const timer=setTimeout(done,ms);this.wake=done;});}
  async start(inputs:SampleInput[],config:Partial<RunConfig>={},name='测试运行'):Promise<RunRecord>{
    if(this.active&&!['completed','stopped'].includes(this.active.status))throw new Error('已有测试运行占用执行器');
    if(!inputs.length)throw new Error('至少需要一个有效样本');
    if(new Set(inputs.map(i=>i.id)).size!==inputs.length||inputs.some(i=>!i.id.trim()||!i.prompt.trim()||!['标准','高级'].includes(i.model)))throw new Error('样本数据无效或 ID 重复');
    const settings=validateConfig(config),health=await this.adapter.health();if(!health.connected)throw new Error(health.message??'App 未连接');
    await this.adapter.preflight?.(inputs);
    const run:RunRecord={id:randomUUID(),name,mode:health.mode,status:'running',config:settings,createdAt:iso(),samples:inputs.map((s,i)=>({...s,status:'queued',batch:Math.floor(i/settings.concurrency),attempts:[],humanWaitMs:0})),currentBatch:0,paused:false,stopRequested:false};
    this.persist(run);this.launch(run);return structuredClone(run);
  }
  private launch(run:RunRecord){this.active=run;this.disposed=false;this.worker=this.loop(run).catch(error=>{run.status='needs_review';run.error=String(error);this.persist(run);});}
  async wait(id:string){if(this.active?.id===id)await this.worker;return this.store.get(id);}
  private current(id:string){if(this.active?.id!==id)throw new Error('该运行当前不在执行中');return this.active;}
  pause(id:string){const run=this.current(id);run.paused=true;run.status='paused';this.persist(run);}
  async resume(id:string){const run=this.current(id);const health=await this.adapter.health();if(!health.connected)throw new Error('App 未连接');if(run.samples.some(s=>s.status==='needs_review'))throw new Error('请先处理待人工核对任务');run.paused=false;run.error=undefined;run.status='running';this.persist(run);}
  stop(id:string){const run=this.current(id);run.stopRequested=true;run.paused=false;run.status='stopping';this.persist(run);}
  async resolve(id:string,sampleId:string,action:'recheck'|'failed'|'cancelled'){
    const run=this.current(id),sample=run.samples.find(s=>s.id===sampleId);if(!sample)throw new Error('样本不存在');
    if(!['needs_review','waiting_human'].includes(sample.status))throw new Error('样本当前不需要人工处理');
    const attempt=sample.attempts.at(-1);
    if(action==='recheck'){
      if(!attempt?.ref)throw new Error('没有已确认 App 任务ID，无法自动核对；请确认原任务已结束后标记失败或取消');
      sample.status='running';attempt.status='running';
    }else {
      if(attempt&&!terminalAttempt(attempt)){attempt.status=action==='failed'?'failed':'stopped';attempt.endedAt=iso();attempt.durationMs=Date.now()-time(attempt.submittedAt);}
      this.finishSample(sample,action==='failed'?'failed':'cancelled');
    }
    if(!run.samples.some(s=>s.status==='needs_review')){run.error=undefined;run.status=run.paused?'paused':'running';}
    this.persist(run);
  }
  async recover(){
    const runs=this.store.list().filter(r=>!['completed','stopped'].includes(r.status));if(!runs.length)return;
    const run=runs[0];run.paused=true;
    for(const sample of run.samples){const a=sample.attempts.at(-1);if(terminalSample(sample))continue;if(a&&!terminalAttempt(a)){
      const gap=Math.max(0,Date.now()-time(a.timingAt??a.submittedAt));
      if(a.status==='waiting_human'){a.humanWaitMs+=gap;sample.humanWaitMs+=gap;}else if(a.status==='running')a.activeMs+=gap;
      a.timingAt=iso();
      if(!a.ref){sample.status='needs_review';a.status='needs_review';a.error='平台中断时提交尚未确认，请人工核对原 App 任务';}
      else if(sample.status!=='needs_review'&&sample.status!=='waiting_human'){sample.status='running';a.status='running';}
    }}
    run.status=run.samples.some(s=>s.status==='needs_review')?'needs_review':'paused';run.error='已恢复运行记录；核对原任务后可继续';this.persist(run);this.launch(run);
  }
  dispose(){this.disposed=true;this.unsubscribe?.();this.wake?.();}
  private accrue(sample:SampleRecord,attempt:Attempt){
    const now=performance.now(),previous=this.stamps.get(attempt.id);this.stamps.set(attempt.id,now);attempt.timingAt=iso();
    if(!this.sampleClocks.has(sample)&&sample.startedAt)this.sampleClocks.set(sample,{started:now,base:Math.max(0,Date.now()-time(sample.startedAt))});
    if(!this.attemptClocks.has(attempt))this.attemptClocks.set(attempt,{started:now,base:Math.max(0,Date.now()-time(attempt.submittedAt))});
    if(previous===undefined)return;
    const delta=Math.max(0,now-previous);
    if(attempt.status==='waiting_human'){attempt.humanWaitMs+=delta;sample.humanWaitMs+=delta;}else if(attempt.status!=='needs_review')attempt.activeMs+=delta;
  }
  private attemptDuration(attempt:Attempt){const clock=this.attemptClocks.get(attempt);return Math.max(0,clock?clock.base+performance.now()-clock.started:Date.now()-time(attempt.submittedAt));}
  private finishSample(sample:SampleRecord,status:'succeeded'|'failed'|'cancelled'){
    const clock=this.sampleClocks.get(sample);sample.status=status;sample.endedAt=iso();sample.durationMs=sample.startedAt?Math.max(0,clock?clock.base+performance.now()-clock.started:Date.now()-time(sample.startedAt)):undefined;
    sample.retryAt=undefined;
  }
  private review(run:RunRecord,sample:SampleRecord,attempt:Attempt,message:string){sample.status='needs_review';attempt.status='needs_review';attempt.error=message;sample.lastError=message;run.status='needs_review';run.error=message;}
  private failAttempt(run:RunRecord,sample:SampleRecord,attempt:Attempt,snapshot:TaskSnapshot){
    attempt.status='failed';attempt.endedAt=iso();attempt.durationMs=this.attemptDuration(attempt);attempt.error=snapshot.error??'App 任务失败';attempt.errorCode=snapshot.errorCode;sample.lastError=attempt.error;
    if(snapshot.errorCode==='rate_limit'||snapshot.retryAfterMs){
      attempt.errorCode='rate_limit';const until=Date.now()+Math.max(snapshot.retryAfterMs??0,retryDelay(attempt.index+1,run.config));run.rateLimitUntil=iso(Math.max(until,time(run.rateLimitUntil)));
    }
    if(attempt.index>=run.config.maxRetries||run.stopRequested)this.finishSample(sample,run.stopRequested?'cancelled':'failed');
    else{sample.status='waiting_retry';sample.retryAt=iso(Date.now()+retryDelay(attempt.index+1,run.config));}
  }
  private appendEvents(attempt:Attempt,snapshot:TaskSnapshot){const ids=new Set(attempt.events.map(e=>`${e.source}:${e.id}`));for(const e of snapshot.events??[]){const id=`${e.source}:${e.id}`;if(!ids.has(id)){attempt.events.push({...e,at:e.at??iso()});ids.add(id);}}}
  private async inspect(run:RunRecord,sample:SampleRecord){
    const a=sample.attempts.at(-1);if(!a||terminalAttempt(a)||!a.ref||sample.status==='needs_review')return;
    this.accrue(sample,a);
    let snapshot:TaskSnapshot;
    try{snapshot=await this.adapter.inspect(a.ref);}catch(error){run.paused=true;run.error='App 连接中断：'+String(error);return;}
    this.appendEvents(a,snapshot);a.actualInput=snapshot.actualInput??a.actualInput;a.actualModel=snapshot.actualModel??a.actualModel;a.output=snapshot.output??a.output;a.collection=snapshot.collection??a.collection;a.collectionReason=snapshot.collectionReason??a.collectionReason;
    if(snapshot.status==='unknown'){this.review(run,sample,a,snapshot.error??'无法确认 App 任务状态，请人工核对');return;}
    if(snapshot.status==='succeeded'){a.status='succeeded';a.endedAt=iso();a.durationMs=this.attemptDuration(a);this.finishSample(sample,'succeeded');return;}
    if(snapshot.status==='failed'||snapshot.status==='stopped'){this.failAttempt(run,sample,a,{...snapshot,error:snapshot.error??(snapshot.status==='stopped'?'App 任务已停止':'App 任务失败')});return;}
    if(run.stopRequested){let stopped=false;try{stopped=await this.adapter.stop(a.ref);}catch{}if(stopped){const last=await this.adapter.inspect(a.ref).catch(()=>undefined);if(last?.status==='succeeded'){this.appendEvents(a,last);a.status='succeeded';a.output=last.output??a.output;a.endedAt=iso();a.durationMs=this.attemptDuration(a);this.finishSample(sample,'succeeded');}else{a.status='stopped';a.endedAt=iso();a.durationMs=this.attemptDuration(a);this.finishSample(sample,'cancelled');}}else this.review(run,sample,a,'停止请求未获确认，请在 App 中核对');return;}
    if(snapshot.status==='waiting_human'){
      const q=snapshot.question;
      if(q&&!a.events.some(e=>e.source==='platform'&&e.id===`question:${q.id}`))a.events.push({id:`question:${q.id}`,source:'platform',type:'question',at:iso(),payload:q});
      if(q?.kind==='choice'&&q.questions.length&&q.questions.every(item=>item.options.length)){
        if(!a.answeredQuestionIds.includes(q.id)){
          try{await this.adapter.answer(a.ref,q,q.questions.map(()=>[0]));a.answeredQuestionIds.push(q.id);a.events.push({id:`answer:${q.id}`,source:'platform',type:'question_answer',at:iso(),payload:{question:q,indices:q.questions.map(()=>[0])}});}catch(error){a.status='waiting_human';sample.status='waiting_human';a.error='自动回答未确认：'+String(error);return;}
        }
        a.status='running';sample.status='running';
      }else{a.status='waiting_human';sample.status='waiting_human';a.humanSince??=iso();return;}
    }else{a.status='running';sample.status='running';a.humanSince=undefined;}
    if(a.activeMs>=run.config.timeoutMs){
      let stopped=false;try{stopped=await this.adapter.stop(a.ref);}catch{}
      if(!stopped){this.review(run,sample,a,'任务超时且停止未确认，请在 App 中核对');return;}
      const final=await this.adapter.inspect(a.ref).catch(()=>undefined);
      if(final?.status==='succeeded'){this.appendEvents(a,final);a.status='succeeded';a.output=final.output??a.output;a.endedAt=iso();a.durationMs=this.attemptDuration(a);this.finishSample(sample,'succeeded');return;}
      if(final?.status==='failed'){this.failAttempt(run,sample,a,final);return;}
      if(final?.status!=='stopped'){this.review(run,sample,a,'超时停止后未确认终态，请核对');return;}
      this.failAttempt(run,sample,a,{status:'failed',error:'单次尝试执行超时，原任务已确认停止',errorCode:'timeout'});
    }
  }
  private async submit(run:RunRecord,sample:SampleRecord){
    if(run.paused||run.stopRequested||run.samples.some(s=>s.status==='needs_review')||time(run.rateLimitUntil)>Date.now())return;
    let health;try{health=await this.adapter.health();}catch(error){run.paused=true;run.error=String(error);return;}
    if(!health.connected){run.paused=true;run.error=health.message??'App 未连接';return;}
    const attempt:Attempt={id:randomUUID(),index:sample.attempts.length,status:'submitting',submittedAt:iso(),activeMs:0,humanWaitMs:0,collection:'partial',collectionReason:'等待事件采集',events:[],answeredQuestionIds:[]};
    sample.attempts.push(attempt);sample.status='submitting';sample.startedAt??=attempt.submittedAt;const now=performance.now();this.stamps.set(attempt.id,now);this.attemptClocks.set(attempt,{started:now,base:0});if(!this.sampleClocks.has(sample))this.sampleClocks.set(sample,{started:now,base:sample.attempts.length===1?0:Math.max(0,Date.now()-time(sample.startedAt))});this.persist(run);
    try{attempt.ref=await this.adapter.submit({id:sample.id,prompt:sample.prompt,expertKitId:sample.expertKitId,model:sample.model},attempt.id);if(!attempt.ref.taskId)throw new Error('App 未返回可关联任务ID');attempt.status='running';sample.status='running';}
    catch(error){this.review(run,sample,attempt,'提交结果不确定：'+String(error));}
    this.persist(run);
  }
  private async loop(run:RunRecord){
    while(!this.disposed){
      for(const sample of run.samples)if(!terminalSample(sample))await this.inspect(run,sample);
      if(run.stopRequested)for(const sample of run.samples)if(['queued','waiting_retry'].includes(sample.status))this.finishSample(sample,'cancelled');
      if(run.samples.every(terminalSample)){run.status=run.stopRequested?'stopped':'completed';run.endedAt=iso();this.persist(run);return;}
      const batch=run.samples.filter(s=>s.batch===run.currentBatch);
      if(batch.every(terminalSample)){
        if(!run.batchReadyAt)run.batchReadyAt=iso(Date.now()+run.config.batchIntervalMs);
        if(time(run.batchReadyAt)<=Date.now()){run.currentBatch++;run.batchReadyAt=undefined;}
      }
      if(!run.stopRequested)for(const sample of run.samples.filter(s=>s.batch===run.currentBatch))if(sample.status==='queued'||sample.status==='waiting_retry'&&time(sample.retryAt)<=Date.now()){
        for(const running of run.samples)if(running.status==='running')await this.inspect(run,running);
        await this.submit(run,sample);
      }
      run.status=run.samples.some(s=>s.status==='needs_review')?'needs_review':run.stopRequested?'stopping':run.paused?'paused':run.samples.some(s=>s.status==='waiting_human')?'waiting_human':'running';
      this.persist(run);await this.sleep(run.config.pollIntervalMs);
    }
  }
}
