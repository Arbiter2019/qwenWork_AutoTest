# Core / storage verification

2026-11-11. Implemented `packages/core`, `packages/storage` and `tests/core.test.ts`.

## Delivered interfaces

See `packages/core/INTEGRATION.md` and exact shared types `packages/core/src/types.ts`.

17 core tests pass with Node 22:

```sh
node node_modules/vitest/vitest.mjs run tests/core.test.ts
```

22 tests pass when combined with server API tests:

```sh
node node_modules/vitest/vitest.mjs run tests/core.test.ts tests/api.test.ts
```

Coverage includes CSV template/BOM/quoted newlines/leading zeros/error physical lines; fixed batches 2/2/1 through retries; N+1 total attempts; linear capped delay; global server cooldown; unknown submission/stop manual review; timeout; first-choice answers/question deduplication; manual waiting suspends timeout; pause/stop; recovery of ambiguous intent; monotonic live duration; denominator/average formulas; export escaping.

## Implementation decisions / limits

- SQLite uses a single atomic JSON snapshot per run with WAL, containing samples, attempts and deduplicated events. It provides recoverable state but rewrites the run on each update; high-volume event streams may need normalized event storage.
- Live duration uses monotonic performance timestamps. Post-crash recovery uses persisted UTC timestamps as the baseline, then resumes monotonic time. Thus a host clock correction across a crash affects the recovered baseline.
- Adapter must remove authentication data before emitting event payloads. Core cannot reliably identify every secret inside arbitrary model/tool output.
- `resolve(failed|cancelled)` means explicit operator confirmation of the original task ending; unknown task intent does not auto-resubmit.
- A later adapter/server should keep stable event/question IDs, and indicate `unknown` for task association loss rather than falsely emitting failure/success.
- `Scheduler.dispose()` ends polling; it does not cancel App work. Runtime shutdown must preserve the DB for recovery.

No Git commits made by this module worker, no App interactions, no modifications outside core/storage/tests and this report.
