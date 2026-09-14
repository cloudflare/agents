---
"agents": minor
"@cloudflare/think": minor
---

Add the `Queue` Lifecycle capability (`agents/queue`) for durable background work. Each pushed item is a job in the Lifecycle job queue, due immediately, run from the alarm loop one at a time in push order with Lifecycle's retry, deadman, and memory-limit policy. Callbacks are registered in the constructor and typed at declaration and push; `push()` accepts a stable `id` (upsert) and per-item `retry`.

`Agent.queue()` and friends now delegate to the capability. Queued callbacks run from the alarm loop in a fresh invocation, so they no longer see the enqueuing request's `connection` or `request` through `getCurrentAgent()` (the agent itself is still available). The `cf_agents_queues` table and the in-isolate drain are gone; legacy rows migrate into the job queue on the next start. `queue()` accepts `options.id`; `dequeue`, `dequeueAll`, `dequeueAllByCallback`, `getQueue`, and `getQueues` are now asynchronous; and `QueueItem.created_at` is renamed `createdAt`. `LifecycleServices.starting()` is replaced by `status()`, which returns `"zero" | "starting" | "started"`.

Think's workflow-notification outbox and submission drain now run as queue items; the `cf_think_workflow_notifications` table migrates and is dropped on start.

Both one-shot migrations (`cf_agents_queues` in Queue, `cf_think_workflow_notifications` in Think) are temporary upgrade paths and will be removed in the next minor release, by which point every started object has migrated. Deployments skipping this release should upgrade through it. Workflow-notification delivery retries with backoff capped at ten minutes (previously five) and gives up after twelve hours of continuous failure (previously never), reporting the failure through `onError`.
