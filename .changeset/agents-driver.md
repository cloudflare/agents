---
"agents": minor
---

Add experimental `agents/driver`, a durable submission queue and wake loop for agent harnesses.

Install one `Driver` on a Lifecycle Object and pass it to each harness. A harness registers itself with `driver.register(id, runtime)`, implements `inspect`, `admit`, `drive` and `cancel` over its own durable state, and uses the returned handle to `submit`, `wake`, `cancel` and list work. Submissions in one scope run in order, one at a time; scopes and runtimes run independently. A drive or inspection that returns `waiting` without `notBefore` parks the scope with no job until `wake()`, for waits such as a human approval. `DurableToolRuns` tracks tool work that outlives one drive and wakes its owner when it settles.
