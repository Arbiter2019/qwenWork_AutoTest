# Implementation review — 2026-11-11

Read-only review of the approved spec, scheduler, real App adapter, message projection, sidebar listener and HTTP API. No App tasks were submitted. Two isolated Node reproductions used an in-memory store/projection only.

## Important findings

### P1: Timeout can create a duplicate even if the original task finished successfully during stop

Location: `packages/core/src/scheduler.ts:113–116`, `packages/qwen-adapter/src/index.ts:107–110`.

The adapter returns `true` from stop for succeeded/failed/stopped alike. The explicit user-stop path rechecks after stop, but the timeout path unconditionally records timeout and retries. If completion races with timeout, a successful task is marked failed and a new App task is submitted.

Reproduced with an in-memory adapter: inspect initially returned running, stop changed the task to succeeded and returned true; timeout 1 ms, maxRetries 1 led to two submissions and first attempt recorded as timeout. Fix: re-inspect after confirmed stop, preserve success/explicit failure, and retry only after authoritative stopped state. An ambiguous post-stop state must go to review.

### P1: Message projection retains stale errors across subsequent messages

Location: `packages/qwen-adapter/src/projection.ts:24–34`, `packages/qwen-adapter/src/index.ts:68`.

`err` accumulates from every assistant row, while `terminal` is replaced by the latest row. The error check precedes success. A prior error therefore makes a later explicitly successful turn look failed, causing an unnecessary new task/retry. The adapter loads all messages in the subchat, without scoping to the platform input/turn.

Reproduced: error-429 assistant row followed by a completed/success assistant row returns `failed`. Scope terminal/error interpretation to the active input/turn or latest authoritative result; keep previous errors only as history events.

### P2: Restoring a run resets the active timeout budget for the downtime

Location: `packages/core/src/scheduler.ts:63–76`.

Recovery changes a waiting-human attempt to running, then the first accrue returns before accounting for elapsed time since the last persisted checkpoint. A task with 9 minutes active elapsed before a one-hour platform outage can run another minute after recovery despite already exceeding the agreed 10-minute attempt timeout. Human waiting during the outage is also lost from `humanWaitMs`, even though total duration includes it.

Persist a timing checkpoint and state, account for elapsed UTC downtime according to that state during recovery, then resume monotonic clocks. Do not convert waiting-human to running before reconciliation determines whether it resumed.

### P2: Identical consecutive questions collide in deduplication

Location: `packages/qwen-adapter/src/index.ts:89–92`, `packages/core/src/scheduler.ts:107–110`.

The DOM question ID hashes only inputId + question text + options. Two separate questions in the same task with identical text/options produce the same ID. After answering the first, the second is skipped forever because answeredQuestionIds contains it; eventually it times out instead of choosing the first option. Include stable App request/interaction ID or question panel index/occurrence identity. Re-reading the same still-open panel must retain its ID, while the next actual panel gets a new one.

### P2: Global rate-limit detection is delayed until the entire batch has been submitted

Location: `packages/core/src/scheduler.ts:131,139`.

All queued items in the batch are submitted sequentially before any newly submitted item is inspected. During a 4-task batch, the first can fail with rate-limit while the next UI submission takes several seconds; tasks 3 and 4 are still submitted because `rateLimitUntil` has not been updated. The sidebar listener wakes the sleep but cannot interrupt or inspect this submission loop.

Between each submit, reconcile already-running attempts or use pushed adapter failure events to set the global cooldown immediately. This preserves shared UI serialization while preventing additional submissions after a first failure becomes observable.

## Additional concern

`QwenAdapter.health()` always reports the tested baseline version/capabilities as current instead of detecting the running App version (`index.ts:36`). App upgrades can silently continue with old assumptions. Surface actual version and gate unsupported versions, or explicitly label capability status as version-specific evidence rather than a live probe.

## Positive checks

- Unknown submission/stop states do not blindly retry.
- Explicit user-stop completion race was already handled.
- Fixed batch barrier and N+1 semantics are clear.
- SQLite App access is readonly and platform writes are separate.
- Reports escape HTML/CSV and distinguish partial event collection.
- Sidebar status does not directly turn idle into success.
