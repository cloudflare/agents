# Next: queue

An early-access, server-only example showing `Queue` from `agents/queue`
installed on a plain Cloudflare `DurableObject`. It does not extend `Agent` or
another SDK base class.

```ts
export class UploadObject extends DurableObject<Env> {
  readonly queue = new Queue({
    callbacks: {
      processUpload: (
        payload: { fileName: string; bytes: number },
        item: QueueItem<{ fileName: string; bytes: number }>
      ) => {
        // Runs from the alarm loop, one item at a time in push order, even
        // when the alarm wakes a fresh instance. Typed where it is declared
        // and where it is pushed.
      }
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.queue);

  async onRequest() {
    const item = await this.queue.push("processUpload", {
      fileName: "report.pdf",
      bytes: 1024
    });
    return Response.json({ queued: item }, { status: 202 });
  }
}
```

The Queue takes no wiring: storage, alarm coordination, the host invocation
boundary, and events all come from the Lifecycle it is installed on. Each
pushed item is one job in Lifecycle's shared job queue, due immediately, so
it composes with other capabilities that also need wake-ups. Items survive
the Durable Object leaving memory; a throwing callback is retried with
exponential backoff and dropped with a `queue:error` event once its attempts
are exhausted.

`push()` types both the callback name and the payload against the registered
callbacks map. `get()`, `list()`, `cancel()`, and `cancelAll()` manage pending
items. Processed uploads are recorded in the host's own SQL table, so both
pending and completed work survive the Durable Object leaving memory.

## Run

```sh
pnpm install
pnpm run dev
```

Exercise the named object `demo`:

```sh
# Queue an upload for background processing.
curl -X POST http://localhost:8787/agents/upload-object/demo/uploads \
  -H "content-type: application/json" \
  -d '{"fileName": "report.pdf", "bytes": 1024}'

# Pending items and processed uploads.
curl http://localhost:8787/agents/upload-object/demo

# Cancel a pending item by id (it usually runs before you can).
curl -X DELETE http://localhost:8787/agents/upload-object/demo/uploads/<id>
```

Fetch the object again a moment after queueing: the item is gone from
`pending` and the upload appears under `processed`, stamped by the callback.
