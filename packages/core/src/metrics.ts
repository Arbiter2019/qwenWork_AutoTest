import type { Metrics, RunRecord } from './types.ts';
export function metrics(run:RunRecord):Metrics {
  const total=run.samples.length,successful=run.samples.filter(s=>s.status==='succeeded');
  const firstAttemptSucceeded=successful.filter(s=>s.attempts.length===1&&s.attempts[0].status==='succeeded').length;
  const failed=run.samples.filter(s=>s.status==='failed').length;
  return {total,succeeded:successful.length,failed,unfinished:total-successful.length-failed,firstAttemptSucceeded,firstSuccessRate:total?firstAttemptSucceeded/total:null,overallSuccessRate:total?successful.length/total:null,averageDurationMs:successful.length?successful.reduce((n,s)=>n+(s.durationMs??0),0)/successful.length:null,humanWaitMs:run.samples.reduce((n,s)=>n+s.humanWaitMs,0),rateLimitCount:run.samples.reduce((n,s)=>n+s.attempts.filter(a=>a.errorCode==='rate_limit').length,0)};
}
