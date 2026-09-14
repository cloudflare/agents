# Queue

Durable background work for an Agent or any Lifecycle Object. A queued item
persists a callback name and a payload, runs from the Durable Object's alarm
loop one item at a time in push order, retries when the callback throws, and
survives the object leaving memory.

## Queue Lifecycle capability

> **Experimental.** The `Queue` capability and the `agents/lifecycle` surface
> it builds on may change between releases. Agent's established queue methods
> (`this.queue()` and friends) are stable.

`Queue` is a reusable Lifecycle capability. A plain Lifecycle Object can
install it without extending `Agent`:

```typescript
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Queue, type QueueItem } from "agents/queue";

export class UploadObject extends DurableObject<Env> {
  readonly queue = new Queue({
    callbacks: {
      processUpload: (
        payload: { fileName: string },
        item: QueueItem<{ fileName: string }>
      ) => {
        console.log(item.id, payload.fileName);
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.queue);

  async enqueueUpload(fileName: string): Promise<string> {
    const item = await this.queue.push("processUpload", { fileName });
    return item.id;
  }
}
```

Queue owns no storage of its own. Each item is one job in the Lifecycle job
queue, due immediately; Lifecycle owns the physical Durable Object alarm, the
alarm event loop, retry policy, the deadman pre-arm, and the memory-limit
circuit breaker. See [Durable Object lifecycle](./lifecycle.md#the-job-queue).

Queue's API is small: callbacks are registered by name in the constructor,
`push()` creates items typed against that registration, and `get()`,
`list()`, `cancel()`, and `cancelAll()` manage them. All of these are
asynchronous and work inside routed sub-agents.

Queue Lifecycle hooks run without ambient host context. Registered callbacks
are user code, so they run inside the host invocation context with the
Lifecycle Object available through `getCurrentAgent()`.

### `new Queue(options?)`

| Option      | Description                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `callbacks` | Named callbacks `(payload, item) => unknown`. Register in a field initializer so names re-bind on every wake. |
| `retry`     | Default retry policy: `{ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 3000 }`. See [Retries](./retries.md).  |
| `onError`   | Observes an item's terminal failure after its attempts are exhausted. Runs without host context.              |

### `push(callback, payload?, options?)`

Queues one item and returns the `QueueItem`. The item is durable before the
returned promise resolves, and it runs from the next alarm, so the caller
never waits for the callback.

- `options.retry` overrides the Queue's retry policy for this item.
- `options.id` sets a stable id. A push with an existing id replaces that
  item in place, keeping its position in the queue (and superseding a
  dispatch of it still in flight); use it for idempotent enqueues keyed by
  your own identifier.

Once the Lifecycle has started, the item row is written synchronously before
`push()` returns its promise, so a push made in the same synchronous block as
your own SQL writes commits atomically with them.

### `get(id)`, `list(criteria?)`, `cancel(id)`, `cancelAll(callback?)`

`list()` returns pending items in push order; `{ callback }` filters by
callback name. `cancel()` returns whether an item was removed; `cancelAll()`
returns how many were.

### QueueItem

```typescript
type QueueItem<T = unknown> = {
  id: string; // Unique identifier
  callback: string; // Callback name
  payload: T; // Data passed to the callback
  createdAt: number; // Unix timestamp in seconds
  retry?: RetryOptions; // Resolved retry policy
};
```

## Using the queue through Agent

`Agent` installs a `Queue` and resolves callback names to its own methods, so
`this.queue("methodName", payload)` keeps working with no registration:

```typescript
class MyAgent extends Agent {
  async processEmail(
    payload: { email: string; subject: string },
    item: QueueItem<{ email: string; subject: string }>
  ) {
    console.log(`Processing ${item.id}: ${payload.subject}`);
  }

  async onMessage(message: string) {
    const id = await this.queue("processEmail", {
      email: "user@example.com",
      subject: "Welcome!"
    });
    console.log(`Queued task ${id}`);
  }
}
```

| Method                               | Description                                                         |
| ------------------------------------ | ------------------------------------------------------------------- |
| `queue(callback, payload, options?)` | Queue a method by name. Returns the item id. Accepts `retry`, `id`. |
| `dequeue(id)`                        | Remove a pending item. Resolves to whether one was removed.         |
| `dequeueAll()`                       | Remove every pending item. Resolves to the count.                   |
| `dequeueAllByCallback(callback)`     | Remove every pending item for one callback. Resolves to the count.  |
| `getQueue(id)`                       | Read a pending item.                                                |
| `getQueues(key, value)`              | Pending items whose payload has `key` equal to `value`.             |

## How queue processing works

1. **Validation**: `queue()` checks the callback exists and validates any
   retry options. Invalid input throws immediately.
2. **Durable first**: the item is a row in the `cf_agents_jobs` job queue
   before `queue()` resolves. Items created before this capability existed
   are migrated out of the old `cf_agents_queues` table on the next start.
3. **Alarm-driven**: every push re-arms the Durable Object alarm. The
   Lifecycle event loop runs due items in push order, awaiting each callback
   before starting the next, in a fresh invocation rather than the request
   that queued them.
4. **Retries**: a throwing callback is retried with exponential backoff per
   its retry policy, emitting `queue:retry` on each extra attempt.
5. **Terminal failure**: after the last attempt the item is dropped, a
   `queue:error` event is emitted, and Agent's `onError` (or the Queue's
   `onError` option) observes the error.
6. **Recovery**: an isolate that dies mid-callback wakes again on the
   Lifecycle deadman alarm and resumes the queue, so callbacks should be
   idempotent.

## Use cases

Queue work that must not block the current request or WebSocket message:

```typescript
class DataProcessor extends Agent {
  async processLargeDataset(data: { datasetId: string; userId: string }) {
    const results = await this.heavyComputation(data.datasetId);
    await this.notifyUser(data.userId, results);
  }

  async onDataUpload(uploadData: { id: string; userId: string }) {
    await this.queue("processLargeDataset", {
      datasetId: uploadData.id,
      userId: uploadData.userId
    });
    return { message: "Data upload received, processing started" };
  }
}
```

Split large requests into batches that run one after another:

```typescript
class BatchProcessor extends Agent {
  async processBatch(data: { items: unknown[]; batchId: string }) {
    for (const item of data.items) {
      await this.processItem(item);
    }
  }

  async onLargeRequest(items: unknown[]) {
    const batchSize = 10;
    for (let i = 0; i < items.length; i += batchSize) {
      await this.queue("processBatch", {
        items: items.slice(i, i + batchSize),
        batchId: `batch-${i / batchSize + 1}`
      });
    }
  }
}
```

For work that should run at a specific time or on a schedule, use
[Scheduling](./scheduling.md) instead. Both ride the same Lifecycle job queue.

## Best practices

1. **Keep payloads small**: payloads are JSON-serialized into the job row.
2. **Idempotent callbacks**: an item can run again after an isolate reset.
3. **Bounded callbacks**: the event loop awaits each callback, so a long one
   delays every other job on the object. Detach unbounded work and return.
4. **Stable ids for dedupe**: pass `id` when the same logical task may be
   queued more than once.

## Error handling and retries

```typescript
await this.queue("reliableTask", payload, {
  retry: { maxAttempts: 5, baseDelayMs: 500 }
});
```

See [Retries](./retries.md) for full documentation on retry options, and
[Observability](./observability.md) for the `queue:create`, `queue:retry`,
and `queue:error` events.

## Limitations

- Items run sequentially, not in parallel.
- No priority system (FIFO only).
- Failed items are dropped after all retry attempts (no dead-letter queue).
