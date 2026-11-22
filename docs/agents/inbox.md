# Inbox

> **Experimental.** The `Inbox` capability may change between releases.
>
> For how it works and why, see the [design record](https://github.com/cloudflare/agents/blob/main/design/inbox.md).

`Inbox` keeps a durable record of every request a Durable Object has accepted and not finished, runs them one at a time per lane in arrival order, and keeps each result until you delete it. Install it on any Lifecycle Object.

```typescript
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Inbox, type InboxRun } from "agents/inbox";

export class ReportObject extends DurableObject<Env> {
  readonly inbox = new Inbox({
    handlers: {
      render: async (payload: { month: string }, run: InboxRun) => {
        const report = await renderReport(payload.month, run.signal);
        return { url: report.url };
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.inbox);

  async requestReport(month: string): Promise<string> {
    const { request } = await this.inbox.submit(
      "render",
      { month },
      { idempotencyKey: `report:${month}` }
    );
    return request.id;
  }

  async reportStatus(id: string) {
    return this.inbox.get(id);
  }
}
```

`submit()` returns once the record is stored, before the handler runs. The handler runs from the object's alarm. If the object restarts while a handler runs, the handler runs again with `run.attempt` set to 2, so write handlers that can run more than once.

## What is durable

| Durable                                          | In memory                                      |
| ------------------------------------------------ | ---------------------------------------------- |
| The request record, payload, result and progress | Running handlers and their abort signals       |
| The order of requests and their policies         | Debounce timers                                |
| The alarm that wakes the object to run them      | `wait()` promises (call again after a restart) |

## `new Inbox(options)`

| Option        | Description                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handlers`    | One handler per kind, `(payload, run) => result`. Register in a field initializer.                                                                                                                             |
| `onStatus`    | Called on every status change, `pending` included, in the object's context. A lane waits for it, and `wait()` resolves after it. The call for a finished status is repeated after a restart that cut it short. |
| `maxAttempts` | Runs a request gets when restarts interrupt it, before it ends `error`. Default 3.                                                                                                                             |

A handler returns the result (status `completed`) or throws (status `error`). To end a request another way, return `Inbox.aborted(reason)`, `Inbox.skipped(reason)` or `Inbox.failed(error)`. `Inbox.detached()` leaves the request `running` and lets the lane move on; end it later with `settle()`.

The `run` argument has `id`, `kind`, `lane`, `attempt`, `signal` (aborted by `cancel()` and `clear()`), `metadata`, `progress` (what an earlier attempt saved with `checkpoint()`) and `merged` (the requests this one superseded).

## `submit(kind, payload, options?)`

Stores a request and returns `{ request, accepted }`. Once the object has started, the row is written before `submit()` first awaits, so it commits together with SQL writes you make in the same synchronous block.

| Option           | Description                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`             | A stable id. Generated when absent.                                                                            |
| `idempotencyKey` | A second stable key.                                                                                           |
| `lane`           | Requests in one lane run one at a time, in order. Defaults to the kind.                                        |
| `policy`         | What the request does when its lane is busy: `queue` (default), `latest`, `merge`, `drop` or `{ debounceMs }`. |
| `metadata`       | A JSON object stored with the request.                                                                         |
| `start`          | `alarm` (default) runs it from an alarm; `now` starts an idle lane in the calling invocation.                  |

A submit with the id or idempotency key of an existing request returns that request with `accepted: false` when the kind and payload match, and throws when they do not.

Policies apply only when the lane is busy:

- `queue` waits its turn.
- `drop` ends `skipped` straight away.
- `latest` waits its turn, and ends `skipped` when a later `latest`, `merge` or debounced request is behind it.
- `merge` is `latest`, and the request that runs gets the superseded ids in `run.merged`.
- `{ debounceMs }` is `latest`, and also waits until `debounceMs` after it arrived before it runs.

## Reading and managing requests

| Method                        | Description                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `get(id)`                     | The record, without its payload.                                                                                                  |
| `payload(id)`                 | The stored payload.                                                                                                               |
| `list(options?)`              | Records filtered by `lane`, `kind`, `status`, `idempotencyKey`, `before`, newest first (`order: "oldest"` reverses). At most 500. |
| `wait(id, options?)`          | Resolves with the record once it is terminal. `timeoutMs` resolves with the record as it is then; `signal` rejects.               |
| `cancel(id, reason?)`         | A pending request ends `aborted`. A running one ends `aborted` and its handler's signal aborts.                                   |
| `clear(lane, reason?)`        | Every open request of the lane ends `skipped`.                                                                                    |
| `settle(id, outcome)`         | End a running request from outside its handler, with `Inbox.completed(result)`, `Inbox.failed(error)` and so on.                  |
| `checkpoint(id, progress)`    | Save notes a later attempt reads as `run.progress`.                                                                               |
| `delete(id)`                  | Delete a finished request.                                                                                                        |
| `purgeBefore(time, options?)` | Delete finished requests that ended before `time`, optionally by `lane` and `status`.                                             |

Statuses are `pending`, `running`, `completed`, `error`, `aborted` and `skipped`. Once a request has a finished status it keeps it.

## Events

The Inbox emits `inbox:submit`, `inbox:status` (every status change), `inbox:retry` (a request runs again after a restart) and `inbox:error`. See [Observability](./observability.md).
