# 11 — Submissions ledger (durable turn acceptance)

Original: `submitMessages()` + `_drainThinkSubmissions()` + inspect/list/
cancel/delete APIs on Think. Purpose: webhook/RPC callers need fast durable
acceptance of a turn with idempotent retry, cancellation, and later status
inspection — because a caller that times out on `saveMessages()` cannot know
whether the turn ran.

## Statuses
`pending` (accepted, waiting) → `running` (claimed, executing) →
`completed | aborted | skipped | error`
- `skipped`: turn state was reset (chat cleared) before the submission ran.
- `aborted`: cancelled before/while running.

## Behaviors to preserve

1. `submit(messages, opts)` durably records
   `{ submissionId, idempotencyKey?, metadata?, messages, status: "pending", acceptedAt }`
   and returns `{ ...inspection, accepted: true }` **before** any inference.
   Messages must be ≥1, JSON-serializable (no closures).
2. **Idempotency**: same `idempotencyKey` → return existing record with
   `accepted: false`; nothing inserted. If both `submissionId` and
   `idempotencyKey` are provided and identify *different* existing rows →
   throw ConflictError.
3. **FIFO isolation**: submitted messages are NOT appended to the session at
   accept time. They are appended only when the submission's own turn starts
   (drain claims it → status `running` → append → run turn). Later-accepted
   submissions are invisible to earlier turns.
4. **Drain loop**: after accept (and on startup for leftover rows), a drain
   pass claims the oldest `pending` row and runs it through the normal turn
   queue (`admission: "queue"`, trigger `"submission"`), one at a time,
   continuing until no pending rows remain. Drain must be re-entrant-safe
   (a second drain call while one is active is a no-op).
5. **Cancellation**: `cancel(submissionId, reason?)`:
   - pending → `aborted`; its messages are never appended;
   - running → abort the in-flight turn (via TurnQueue.cancel), status
     `aborted`; messages appended before the turn stay (turn partials follow
     normal partial-persistence rules);
   - settled → no-op, returns false.
6. **Reset interaction**: when the chat is cleared, all pending submissions
   flip to `skipped` (they reference a conversation that no longer exists).
7. Records are retained until `deleteSubmissions({ status?, completedBefore? })`
   (defaults: settled statuses only). `inspect(id)`, `list({ status?, limit? })`.
8. Turn outcome mapping: completed → `completed`; error → `error` with message;
   aborted → `aborted`.
9. Events piggyback on the chat events; a dedicated `submission:*` channel is
   NOT required (keep parity with original, which exposes status via API).

## Proposed interface

```ts
export type SubmissionStatus = "pending" | "running" | "completed" | "aborted" | "skipped" | "error";
export interface SubmissionRecord {
  submissionId: string; status: SubmissionStatus;
  idempotencyKey?: string; metadata?: Record<string, unknown>;
  acceptedAt: number; startedAt?: number; settledAt?: number; error?: string;
  messageCount: number;
}
export interface SubmissionService {
  submit(messages: ChatMessage[], options?: {
    submissionId?: string; idempotencyKey?: string; metadata?: Record<string, unknown>;
  }): Promise<SubmissionRecord & { accepted: boolean }>;
  inspect(submissionId: string): SubmissionRecord | null;
  list(options?: { status?: SubmissionStatus[]; limit?: number }): SubmissionRecord[];
  cancel(submissionId: string, reason?: string): Promise<boolean>;
  deleteSubmissions(options?: { status?: SubmissionStatus[]; completedBefore?: number }): number;
  markAllPendingSkipped(): number;             // chat-clear hook
  drain(): Promise<void>;                      // re-entrant-safe
}
export function createSubmissionService(deps: {
  store: KeyValueStore;                        // prefix "subm:"
  clock: Clock; ids: IdSource; bus: EventBus;
  /** Runs one submission as a turn; resolves with the outcome. Provided by Think. */
  runSubmission: (record: { submissionId: string; messages: ChatMessage[] },
                  signal: AbortSignal) => Promise<{ kind: "completed" | "aborted" | "error"; error?: string }>;
}): SubmissionService;
```

## Tests (TDD list)
- accept returns before runSubmission resolves; FIFO execution order across 3
  submissions; idempotent retry (same id, accepted:false); submissionId+key
  conflict throws; cancel pending (messages never run); cancel running aborts
  signal; markAllPendingSkipped; delete defaults exclude pending/running;
  startup drain picks up leftover pending rows (new service over same KV);
  error outcome recorded with message; drain reentrancy (parallel drain calls
  run each submission exactly once).
