---
"agents": patch
---

Add `agents/fibers`: durable, replayable background execution as a Lifecycle capability (experimental).

One `Fibers` instance per Durable Object owns any number of named Fiber definitions created with `fibers.create(name, run)`. A run survives process loss and deployments by replaying its handler from the top: completed `step.do()` steps return journaled results, `step.sleep()` / `step.sleepUntil()` consult persisted deadlines, and execution continues from the first unfinished step under generation fencing. Steps carry per-attempt retry and timeout policy, stable idempotency keys for external deduplication, and `step.status()` progress with a replay live gate that never re-publishes old progress as new.

Runs are durably accepted (`fiber.run()` returns a receipt; idempotency keys join existing runs), inspectable (`get`, `getByIdempotencyKey`, `list`), cooperatively cancellable, and retained until deleted. The capability follows the Lifecycle alarm-contribution model: it stores run deadlines in its own tables, contributes the earliest through `getNextAlarm()`, and never touches the physical alarm, so it composes with the Scheduler and other capabilities on one shared alarm. Design record: `design/rfc-fibers.md`.
