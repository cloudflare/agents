---
"agents": minor
---

Add experimental `agents/driver`: durable queues of operations and a loop that steps each one until it is done, for agent harnesses.

Install one `Driver` on a Lifecycle Object and pass it to each harness. A harness registers a runtime with `driver.register(id, { step, stop? }, { onFail? })` and keeps the returned handle to `submit`, `wake`, `stop` and list operations. `step(operation, signal)` does one bounded piece of work and answers `continue`, `sleep` until a time, `park` until `wake()`, or `done`. Operations in one scope run in order, one at a time; scopes and runtimes run independently, and a step that is cut off by an eviction runs again. `DurableToolRuns` tracks tool work that outlives one step and wakes its owner when it settles.
