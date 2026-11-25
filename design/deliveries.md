# Deliveries

Status: internal (`agents/internal`, `@internal`). Not exported to apps.

A delivery is a value sent somewhere outside the object (a workflow, a messaging platform, another agent), tried again with backoff until the receiver acknowledges it. It is a Tasks run. The module (`packages/agents/src/internal/delivery.ts`) owns no table, key or job: the run's row, two keys in its checkpoint and Tasks' wake job are the only state.

## Shape

```ts
registerDeliverySink(tasks, "think-workflow-notification", {
  deliver(payload) {
    /* return = acknowledged; throw = retry */
  },
  giveUpError(payload, id, attempts, cause) {
    return new Error("…");
  },
  onGiveUp(error, payload) {
    /* told once; not awaited */
  }
});
await sendDelivery(tasks, "think-workflow-notification", id, payload);
```

- A sink is a framework definition `__cf_delivery:<name>`, registered from the host's constructor like any other, so a delivery sent before a reset finds it again.
- `sendDelivery` is `tasks.run(definition, payload, { runId: id, retain: false, start: "now" })`. The first attempt runs at once, so its claim arms the run's only wake job. The id is the key: a second send under an id that is still open joins it (one delivery per key). Acknowledged, the run is deleted in one write.
- The sink sees its payload and the run's `checkpoint`, for progress inside one delivery (a reply posted in parts); a write after the attempt timed out throws. A sink may set its own `attemptTimeoutMs`. What a later sink needs (an attempt's idempotency key, its own backoff) comes with the call site that uses it.

## Retry and give-up

A failed attempt returns `TaskSettlement.retry(next)`: the run waits `pending` (wait reason `retry`) with its wake job at `next`, and holds nothing in memory. `next` is `backoffDelay(attempt, { baseMs, maxMs })`, the one backoff function (equal jitter): 2 s doubling, 10 minutes at most. An attempt that fails 12 hours or more after the run was accepted gives up instead: the sink's `onGiveUp` is told (not awaited, so a hook that never returns cannot hold the run; Think passes it to `onError`) and the handler returns `TaskSettlement.failed(error)`, so the run ends `error` (deleted, as `retain: false`). Returned, not thrown: Tasks reads some thrown messages, such as a lost connection, as a platform failure and would keep the run open.

An attempt still running after 60 s fails like a throw. The sink is not stopped; its late return changes nothing (the next attempt delivers again: at least once).

A code-update or memory-limit reset thrown by the sink is rethrown, so the run stays `running` for the next isolate. A cancel aborts the attempt and ends the run `aborted`.

## Guarantees

- **At least once.** An attempt that failed may still have arrived; the receiver must tolerate a repeat (a workflow event for a step that already resumed is ignored).
- **The attempt is durable before the sink runs, and a lost one backs off.** Sinks are registered with `maxAttempts` (200), so Tasks commits each attempt with `storage.sync()` before the handler. An attempt that ends (the sink threw, timed out, or held the delivery) records its number in the checkpoint (`__delivery:ended`, with `__delivery:lost` for losses in a row). An attempt that starts and finds an earlier counted attempt that never ended (the object reset while the sink ran) does not run the sink: it backs off like a failure, and after three such attempts in a row the delivery gives up. Without this, a sink that resets its object before its first I/O would run again on every start, about every 5 s (measured on a deployment). The handler also gives up three attempts before the cap, so Tasks never ends a delivery without its `onGiveUp`.
- **The alarm is not held.** Tasks' dispatch budget hands a long attempt to `trackAlarmWork`; a waiting retry holds only its wake job.
- **Facets.** A delivery in a facet is woken through its root by the one facet wake, like any Tasks run.
- **Held deliveries.** A sink may return `"hold"`: the run parks (`pending`, wait reason `park`, no deadline) until `releaseDelivery(tasks, id, progress)` writes `progress` to its checkpoint and makes it due now (Tasks `settle` with `TaskSettlement.retry(now)`). Its give-up window starts at the release, not while it waited. Two releases that race run it once; a release of a delivery that is not held does nothing, so it cannot rewrite the progress of one already under way. A recovered messenger reply is held from the interruption until recovery knows what to post.
- **Memory.** Nothing beyond Tasks' own state for a live attempt (one timer per running attempt).

## Carrying a delivery from an earlier version

`sendDelivery(tasks, sink, id, payload, { sentAt, attempts })` imports a delivery that an earlier version already tried (Tasks `importRun`): the give-up window counts from `sentAt`, the backoff from `attempts`, and it runs from the alarm. Think uses it for workflow notifications a 0.24 queue item or scheduled retry carries.

## Call sites

| Sink                          | Key                                                | Replaces                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `think-workflow-notification` | `workflow-notification:<submissionId>:<eventType>` | Think's queue push with in-process retry off, the scheduled-retry backoff, the `attempts` / `firstFailedAt` payload fields                                                                                                                                                                  |
| `think-messenger-recovery`    | `messenger-recovery:<incidentId>`                  | Think's `cf_think_messenger_recovery:*` KV records, the per-key promise chain, the eight scheduled retries. Held from the interruption; released with `{ outcome, text }` when recovery settles; `posted` in the checkpoint is the cursor over the reply's posts (5-minute attempt timeout) |

## For Channels

A Channel's `deliver()` returns `delivered`, `failed` (retryable or not) or `uncertain`. A Channel sink maps them when that call site lands: `delivered` returns; retryable `failed` throws (or waits the provider's `retryAfter`); non-retryable `failed` gives up at once; `uncertain` records what was sent in the checkpoint, and the next attempt continues that message or gives up with its reference. None of these is built before its call site.

## What was not built

- Replacing a delivery's value while it is open (latest value per key): no call site replaces; each key is sent once.
- Keeping failed deliveries for inspection: the released code kept none.
