---
"agents": patch
---

Add `agents/fibers`: durable, replayable background execution as a Lifecycle capability (experimental).

One `Fibers` instance per Durable Object owns any number of named Fiber definitions declared in its constructor (`new Fibers({ definitions: {...} })`, mirroring the Scheduler's callbacks map), so the registry is rebuilt on every wake and recovery of in-flight runs is correct by construction. Runs start with the typed `fibers.run(name, input, options)`, and `fibers.handle(name)` gives a typed lens scoped to one definition. A run survives process loss and deployments by replaying its handler from the top: completed `step.do()` steps return journaled results, `step.sleep()` / `step.sleepUntil()` consult persisted deadlines, and execution continues from the first unfinished step under generation fencing. Steps carry per-attempt retry and timeout policy, stable idempotency keys for external deduplication, and `step.status()` progress with a replay live gate that never re-publishes old progress as new.

A definition may pair its handler with a `recover` callback (`{ run, recover }` in the map) that owns unclean interruptions instead of automatic replay: it receives the run input and the interrupted step — including its stable idempotency key and the last `checkpoint()` the lost attempt wrote — and decides `replay` (now or later), `complete`, `fail`, or `cancel`, with a bounded backoff budget when recovery itself throws. Clean step failures never invoke recovery; the retry policy owns them.

Runs are durably accepted (`fibers.run()` returns a receipt; idempotency keys join existing runs), inspectable (`get`, `getByIdempotencyKey`, `list`), cooperatively cancellable, and retained until deleted. The capability follows the Lifecycle alarm-contribution model: it stores run deadlines in its own tables, contributes the earliest through `getNextAlarm()`, and never touches the physical alarm, so it composes with the Scheduler and other capabilities on one shared alarm. Design record: `design/rfc-fibers.md`.
