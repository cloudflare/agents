# Deliveries

Status: internal (`agents/internal`, `@internal`). Not exported to apps.

A delivery is a value sent somewhere outside the object (a workflow, a messaging platform, another agent), tried again with backoff until the receiver acknowledges it. It is a Tasks run. The module (`packages/agents/src/internal/delivery.ts`) owns no table, key or job: the run's row, its checkpoint and Tasks' wake job are the only state.

## Shape

```ts
registerDeliverySink(tasks, "think-workflow-notification", {
  deliver(payload, attempt) {
    /* return = acknowledged; throw = retry */
  },
  retry: { baseDelayMs, maxDelayMs, giveUpAfterMs, attemptTimeoutMs },
  giveUpError(payload, id, attempts, cause) {
    return new Error("…");
  }
});
await sendDelivery(tasks, "think-workflow-notification", id, payload);
```

- A sink is a framework definition `__cf_delivery:<name>`, registered from the host's constructor like any other, so a delivery sent before a reset finds it again.
- `sendDelivery` is `tasks.run(definition, payload, { runId: id, retain: false })`. The id is the key: a second send under an id that is still open joins it (one delivery per key). Acknowledged, the run is deleted in one write.
- `attempt` gives the sink its `id`, `attempt` (1-based), an `idempotencyKey` that is the same on every attempt, a `signal` (cancel, attempt timeout) and the run's `checkpoint` for progress inside one delivery.

## Retry and give-up

A failed attempt returns `TaskSettlement.retry(next)`: the run waits `pending` (wait reason `retry`) with its wake job at `next`, and holds nothing in memory. `next` is `backoffDelay(attempt, { baseMs, maxMs })`, the one backoff function (equal jitter). Defaults: 2 s doubling, 10 minutes at most. An attempt that fails `giveUpAfterMs` (12 hours) or more after the run was accepted gives up instead: the sink's `onGiveUp` gets the give-up error (Think passes it to `onError`) and the handler returns `TaskSettlement.failed(error)`, so the run ends `error` (deleted, as `retain: false`). Returned, not thrown: Tasks reads some thrown messages, such as a lost connection, as a platform failure and would keep the run open.

An attempt still running after `attemptTimeoutMs` (60 s) fails like a throw: its signal aborts and its later checkpoint writes throw. The sink is not stopped; a late return changes nothing (the next attempt delivers again: at least once).

A code-update or memory-limit reset thrown by the sink is rethrown, so the run stays `running` for the next isolate. A cancel aborts the attempt and ends the run `aborted`.

## Guarantees

- **At least once.** An attempt that failed may still have arrived. Receivers dedupe on `idempotencyKey`.
- **The attempt is durable before the sink runs.** Sinks are registered with `maxAttempts` (200, above the ~80 attempts 12 hours of the default backoff allows), and Tasks commits a capped definition's attempt with `storage.sync()` before the handler. Without it, a sink that resets the object before its first I/O would roll its own attempt back and run again at once, forever (measured on a deployment in the Outbox round, #2936).
- **The alarm is not held.** Tasks' dispatch budget hands a long attempt to `trackAlarmWork`; a waiting retry holds only its wake job.
- **Facets.** A delivery in a facet is woken through its root by the one facet wake, like any Tasks run.
- **Memory.** Nothing beyond Tasks' own state for a live attempt (one timer per running attempt).

## Carrying a delivery from an earlier version

`sendDelivery(tasks, sink, id, payload, { sentAt, attempts })` imports a delivery that an earlier version already tried (Tasks `importRun`): the give-up window counts from `sentAt`, the backoff from `attempts`, and it runs from the alarm. Think uses it for workflow notifications a 0.24 queue item or scheduled retry carries.

## Call sites

| Sink                          | Key                                                | Replaces                                                                                                                   |
| ----------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `think-workflow-notification` | `workflow-notification:<submissionId>:<eventType>` | Think's queue push with in-process retry off, the scheduled-retry backoff, the `attempts` / `firstFailedAt` payload fields |

## For Channels

A Channel's `deliver()` returns `delivered`, `failed` (retryable or not) or `uncertain`. A Channel sink maps them when that call site lands: `delivered` returns; retryable `failed` throws (or waits the provider's `retryAfter`); non-retryable `failed` gives up at once; `uncertain` records what was sent in the checkpoint, and the next attempt continues that message or gives up with its reference. None of these is built before its call site.

## What was not built

- Replacing a delivery's value while it is open (latest value per key): no call site replaces; each key is sent once.
- A held delivery released later: a parked run settled with `retry(now)` and a checkpoint does it (`design/tasks.md`), with no verb of its own.
- Keeping failed deliveries for inspection: the released code kept none.
