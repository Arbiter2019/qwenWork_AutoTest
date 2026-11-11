# Core integration contract

Implementation lives in `src/types.ts`, `csv.ts`, `metrics.ts`, `report.ts`, `scheduler.ts`; SQLite store is `../storage/src/store.ts`.

```ts
import { Scheduler, validateConfig } from './src/scheduler.ts';
import { Store } from '../storage/src/store.ts';
import { parseCsv, CSV_TEMPLATE } from './src/csv.ts';
import { metrics } from './src/metrics.ts';
import { reportCsv, reportJson, reportHtml } from './src/report.ts';
const store = new Store('/absolute/path/data/runs.db');
const scheduler = new Scheduler(store, adapter); // adapter implements src/types.ts AppAdapter
await scheduler.recover(); // once at server startup
const run = await scheduler.start(samples, partialConfig, 'test name');
scheduler.on('change', run => {});
scheduler.pause(run.id);
await scheduler.resume(run.id);
scheduler.stop(run.id);
await scheduler.resolve(run.id, sampleId, 'recheck'); // or failed/cancelled, after human checked original task
store.get(run.id); store.list();
scheduler.dispose(); // stop polling on server shutdown, does not stop App tasks
```

`start` returns immediately after persisting the run and launching the worker. State changes are persisted; use `store.get` for latest. `Scheduler.wait(id)` waits until final completion and is only for tests/CLI.

Adapter uses **inspect polling** rather than observe callbacks:

```ts
health(): Promise<{connected:boolean,mode:'real'|'simulation',message?:string,...}>
submit(input: SampleInput, attemptId:string): Promise<TaskRef>
inspect(ref:TaskRef): Promise<TaskSnapshot>
answer(ref:TaskRef, question:TaskQuestion, indices:number[][]):Promise<void>
stop(ref:TaskRef):Promise<boolean> // true ONLY when confirmed stopped
focus?(ref:TaskRef):Promise<void>
```

Read the exact shared types in `src/types.ts`. `TaskRef.taskId` is required; `chatId/subChatId/sessionId/...` optional. `TaskSnapshot.status` is running/succeeded/failed/stopped/waiting_human/unknown. `retryAfterMs` is a remaining duration. `errorCode:'rate_limit'` activates global submission cooldown. `unknown` becomes manual review and never resubmits. Throwing during submit is also ambiguous and requires review. Throwing during inspect pauses new submission, but polling continues to recover observations.

When emitting a question, options are strings in original order. A choice question with nonempty options automatically answers `[0]` for each subquestion. Permission/text/empty choices wait for human; the platform polls for the App to resume. Stable event IDs and question IDs are required for deduplication.

Core tests: Node 22 `node node_modules/vitest/vitest.mjs run tests/core.test.ts` — 17 tests pass (CSV physical line numbers, 2/2/1 barriers through retry, N+1 independent attempts, capped delay, service cooldown, timeout/uncertain stop, first-option answers, human waiting, pause/stop, lost acknowledgement, recovery, monotonic elapsed time and reports).

Storage currently keeps the complete run, samples, attempts and events in one SQLite JSON snapshot per run (WAL). Writes are atomic, but each update rewrites the snapshot, so very large event volumes may need normalized event storage later. Event payloads must be sanitized at the adapter boundary; the core cannot distinguish an App credential from arbitrary user content safely.

Live elapsed duration uses monotonic clocks. Recovery seeds elapsed duration from persisted UTC timestamps, then resumes monotonic timing. Manual `failed`/`cancelled` resolution is an explicit operator confirmation that the original task is no longer active; no automatic duplicate submission follows an unknown attempt.
