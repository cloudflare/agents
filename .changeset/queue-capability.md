---
"agents": minor
"@cloudflare/think": minor
---

Add the `Queue` Lifecycle capability (`agents/queue`) for durable background work. Each pushed item is a job in the Lifecycle job queue, due immediately, run from the alarm loop one at a time in push order with Lifecycle's retry, deadman, and memory-limit policy. Callbacks are registered in the constructor and typed at declaration and push; `push()` accepts a stable `id` (upsert) and per-item `retry`.

`Agent.queue()` and friends now delegate to the capability. The `cf_agents_queues` table and the in-isolate drain are gone; legacy rows migrate into the job queue on the next start. `queue()` accepts `options.id`; `dequeue`, `dequeueAll`, `dequeueAllByCallback`, `getQueue`, and `getQueues` are now asynchronous; and `QueueItem.created_at` is renamed `createdAt`. `LifecycleServices.starting()` is replaced by `status()`, which returns `"zero" | "starting" | "started"`.

Think's workflow-notification outbox and submission drain now run as queue items; the `cf_think_workflow_notifications` table migrates and is dropped on start. Workflow-notification delivery is retried 5 times in-process, then dropped with a `queue:error` event, instead of retrying indefinitely with backoff.
