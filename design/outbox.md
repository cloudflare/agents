# Outbox

The `Outbox` capability (`agents/outbox`) delivers a value to a named sink and keeps retrying until the sink acknowledges it. It exists because Think, `Agent` and `AIChatAgent` each built this by hand: workflow notifications had their own backoff over the queue and the scheduler, recovered messenger replies had storage keys, a cursor and a scheduled retry, and detached agent-tool results had a claim, a lease and a delivered-at column. Each copy had its own idea of when to give up and none could be listed.

## How it works

A delivery is a row in `cf_agents_outbox`, unique on `(sink, key)`. `send(sink, payload, { key })` inserts the row, or replaces the value of an existing one, and pushes one Lifecycle job (`outbox:<id>`) due now. The row is the source of truth. The job only wakes it, and startup re-pushes a job for every pending row.

When the job fires, the Outbox:

1. Counts the attempt in the row and sets the next wake one attempt timeout (default 60 seconds) out, before the sink runs.
2. Runs the sink inside host context.
3. On return, deletes the row if it still holds the value this attempt read (compared by idempotency key).
4. On a throw, sets the next attempt `min(maxDelayMs, baseDelayMs * 2^(attempt-1))` out, or gives up.

A sink still running after five seconds is handed to the alarm's memory-limit breaker with `trackAlarmWork`, and the alarm loop moves on. The wake set in step 1 covers an isolate that dies mid-attempt. Tasks uses the same pattern.

An attempt that outlives its timeout counts as failed and backs off like a throw. The sink is not cancelled, so it may still return: a late return acknowledges the value (it was delivered), and a late throw changes nothing. Every write an attempt makes is guarded on the value's idempotency key and the attempt number, so an old attempt cannot re-time, fail or overwrite the checkpoint of a newer one. A sink that never settles still gives up at `giveUpAfterMs`. Each value also carries a `version` that counts the sends under its key, so a receiver that sees two attempts overlap can keep the newer value.

Giving up sets the row to `failed`, emits `outbox:give_up` and calls the sink's `onGiveUp`. Failed rows stay readable and can be started over with `retry()`. Startup purges failed rows older than seven days.

On a facet (a routed Lifecycle) the rows stay on the facet. Its wake is mirrored into the root's job queue, and the root routes the dispatch back, the same shape as Tasks.

## Key decisions

**One primitive, keyed.** Every copy this replaced was "latest value per key": a notification per (submission, event type), a reply per recovery incident, a terminal per (run, finish or give-up). "Every message" fanout is the same thing with a fresh key per send, which is what `send()` does when no key is given. Two primitives would mean two tables and two sets of rules for one behaviour.

**No order between keys.** Each key backs off on its own. Ordering across keys would mean one failing value blocks every other value behind it, which is the wrong default for notifications. A sink that needs order can carry a sequence in the value, or use one key per target so newer values replace older ones.

**The attempt counts before the sink runs.** A value that takes the isolate down every time would otherwise loop forever, because the failure is never recorded. Counting first means the crash loop runs out of attempts like any other failure. The cost is that an attempt cut short by an unrelated reset also counts.

**Replacing a value starts it over.** The attempt count, the give-up window and the checkpoint reset, and the value gets a new idempotency key. A new value is new intent. An attempt already running finishes with the old value, and its acknowledgement cannot delete the new one.

**Hold.** `send(..., { hold: true })` stores a value without delivering it, and `release()` delivers it. `release` reads and writes in one step, so two racing releases deliver once. Think's messenger recovery needs this. The reply's destination is known before recovery knows what the reply is.

**Checkpoints.** `saveCheckpoint` records progress inside one value. A recovered messenger reply is several posts, and a retry must start after the last post that went out.

**Own table, not Tasks.** Tasks journals steps and returns results. A delivery needs neither, and Tasks has no "replace the value under this key" rule. Riding the job queue directly keeps a delivery to one row and one job.

## Guarantees

| What                                                                                  | Where                        |
| ------------------------------------------------------------------------------------- | ---------------------------- |
| Value, key, version, status, attempts, first attempt, next attempt, error, checkpoint | SQLite                       |
| The wake for each pending delivery                                                    | SQLite (Lifecycle job queue) |
| Which attempts are running in this isolate                                            | Memory                       |

Delivery is at least once. A sink can run again for a value it already handled, after a reset between its side effect and the row delete. Sinks must be idempotent, and `idempotencyKey` is stable across the retries of one value so a receiver can drop repeats.

Values are capped at 1 MB of JSON because SQLite rows stop at 2 MB.

## Tradeoffs

- One job per pending delivery. A burst of thousands of deliveries is thousands of job rows. Every current user sends a handful.
- An attempt that crashes its isolate waits one attempt timeout before the next attempt.
- The attempt timeout does not cancel the sink. Two attempts of one value can overlap, which at-least-once already allows.
- `last_error` is cut at 4,000 characters and checkpoints stop at 256 KB, so a row stays under SQLite's 2 MB limit beside a 1 MB value.
- Failed rows are kept for seven days, then deleted without notice. `onGiveUp` and `outbox:give_up` are the reporting path.

## History

- [rfc-slim-hosts.md](./rfc-slim-hosts.md) (#2934) placed the Outbox among the capabilities the hosts compose and settled one keyed rule instead of separate fanout and latest-value modes.
