# 13 — Declared scheduled tasks (Think)

Original: `getScheduledTasks()` returns a code-declared map of recurring
prompts or handlers; Think reconciles declarations against durable rows at
startup, arms one-shot schedules for the next occurrence, and re-arms after
each run. Built on: schedule DSL (doc 05), Scheduler (doc 05), Submissions
(doc 11).

## Declaration shape

```ts
export type DeclaredTask = {
  schedule: string;                       // DSL string (doc 05)
  timezone?: string;                      // for wall-clock schedules
  metadata?: Record<string, unknown>;
  retry?: { maxAttempts?: number; baseDelayMs?: number };
} & (
  | { prompt: string | (() => string | Promise<string>) }
  | { handler: (ctx: ScheduledTaskContext) => void | Promise<void> }
);
export type DeclaredTasks = Record<string, DeclaredTask>;   // key = taskId
export interface ScheduledTaskContext {
  taskId: string;
  scheduledFor: number; scheduledForDate: Date;
  occurrenceKey: string;                  // `${taskId}:${scheduledFor}`
  idempotencyKey: string;                 // stable per occurrence
  schedule: string; scheduleKind: "interval" | "wall-clock";
  timezone?: string; metadata?: Record<string, unknown>;
}
```
Exactly one of `prompt` | `handler` — validate at reconcile time (runtime
validation matters because task maps may be built dynamically).

## Behaviors to preserve

1. **Reconciliation** (`reconcile(tasks)`, run at startup and on demand via
   the public `reconcileScheduledTasks()`):
   - Parse + validate every declaration (DSL, timezone resolution using the
     agent default timezone; unresolved wall-clock timezone → throw).
   - Compute `scheduleHash` (hash of parsed schedule + timezone) and
     `taskHash` (schedule hash + prompt/handler identity is NOT hashable —
     hash schedule + metadata + kind only).
   - Diff against stored task rows (`task:<taskId>`):
     - new task → insert row, then create a `once` Scheduler entry for
       `nextOccurrence`; store `scheduleId` on the row.
     - changed schedule (hash differs) → cancel old schedule, arm new.
     - removed from declarations → cancel schedule, delete row.
     - unchanged → verify the schedule row still exists; **repair pending
       rows**: a row recorded without a `scheduleId` (crash between row write
       and schedule create — the row is written first by design) gets its
       schedule created now.
2. **Execution** (scheduler dispatches callback `$internal:declared-task` with
   `{ taskId, scheduledFor }`):
   - Late alarms: run the intended occurrence once; then arm the **next
     future** occurrence (never backfill missed ones).
   - Build `ScheduledTaskContext`; `idempotencyKey = "task:" + occurrenceKey`.
   - Prompt task → `submissions.submit([userMessage(resolvedPrompt)], { idempotencyKey, metadata })`
     (duplicate occurrence → deduped by the ledger). Trigger "schedule".
   - Handler task → invoke with context.
   - `retry` policy wraps the prompt-submit / handler call; after success OR
     retry exhaustion, the next occurrence is still armed (failed occurrences
     never block future runs; the failure is emitted as `schedule:error`).
   - Delivery is at-least-once by design.
3. Declarations can reference product data that changes while live —
   `reconcile()` must be safe to call repeatedly (idempotent).

## Proposed interface

```ts
export interface ScheduledTaskService {
  reconcile(tasks: DeclaredTasks): Promise<void>;
  /** Wire into the scheduler dispatch table. */
  runOccurrence(payload: { taskId: string; scheduledFor: number }): Promise<void>;
  listTasks(): Array<{ taskId: string; schedule: string; nextRunAt: number | null }>;
}
export function createScheduledTaskService(deps: {
  store: KeyValueStore;                 // prefix "task:"
  scheduler: Scheduler; submissions: SubmissionService;
  clock: Clock; bus: EventBus;
  defaultTimezone?: () => string | undefined;
  /** Live declarations — needed at dispatch time to find prompt/handler fns. */
  declarations: () => DeclaredTasks | Promise<DeclaredTasks>;
}): ScheduledTaskService;
```

## Tests
- reconcile inserts + arms; re-reconcile idempotent; schedule change re-arms;
  removal cancels; pending-row repair (row without scheduleId gets one).
- validation: both prompt and handler → throw; neither → throw; wall-clock
  without timezone → throw; bad DSL → throw with task id in message.
- occurrence run: prompt creates submission with occurrence idempotency key
  (duplicate run deduped); handler receives full context; next occurrence
  armed after success and after retry exhaustion; late run does not backfill
  (advance clock past 3 occurrences → exactly one run, next armed in future).
- retry policy: handler fails twice then succeeds (attempts respected).
