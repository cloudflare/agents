# Streams

> **Experimental.** Everything exported from `agents/streams` may change
> between releases while the durable output surface stabilizes.

`agents/streams` adds durable incremental output to a [Lifecycle
Object](./lifecycle.md): an ordered, durable chunk log per stream with a
monotonic cursor, replay-then-tail reads, and terminal status. A consumer
that reconnects replays from its cursor; a producer that dies mid-stream
leaves exactly the chunks it durably appended, ready for recovery to
finalize. The capability needs no alarm, so it also works on facets.

## Install and use

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";

export class ReportObject extends DurableObject<Env> {
  readonly streams = new Streams();
  readonly lifecycle = Lifecycle.install(this).use(this.streams);
}
```

On an `Agent`, install it onto the composition root in the constructor —
the pattern for adding any extra capability to an Agent:

```ts
export class ReportAgent extends Agent<Env> {
  readonly streams = new Streams();

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.streams);
  }
}
```

## Producing

```ts
const stream = await this.streams.open("reply:123", { metadata });
stream.append(chunk); // synchronous durable write; wakes live readers
stream.close(); // or stream.error(reason)
```

Chunks are JSON values (1 MiB default ceiling, configurable via
`maxChunkBytes`); each append assigns the next monotonic sequence number —
the stream's **cursor**. `open()` is idempotent on the id: reopening a live
stream returns a writer at its cursor, reopening a settled stream throws
`StreamClosedError`, and settling twice is a no-op so recovery callers stay
idempotent.

## Consuming

```ts
for await (const chunk of this.streams.read("reply:123", { from, signal })) {
  // replays persisted chunks from `from`, then tails live appends,
  // ends when the stream settles
}

const status = await this.streams.status("reply:123");
// { state: "streaming" | "completed" | "errored", cursor, ... } | null
```

Reads are independent of producer liveness. `list()` filters by state, and
`delete()` removes a settled stream and its chunk log (a live stream must be
settled first).

When the consumer pays per write — an SSE flush, an RPC hop, a history
append — read in batches instead of chunk by chunk:

```ts
for await (const batch of this.streams.readBatches("reply:123", {
  from,
  batchSize: 50 // per-array ceiling during replay; default 100
})) {
  flush(batch); // StreamChunk[] — one write per backlog, not per chunk
}
```

`readBatches()` has the same lifecycle as `read()` (replay, then tail, end
on settlement); the difference is granularity: replay yields up to
`batchSize` chunks per array, and a live tail yields everything that
accumulated since the last wakeup as one array.

## Composing with Tasks

The contract [Tasks](./tasks.md) recovery was designed around: the task step
appends to a stream it does not own and checkpoints the cursor; `recover`
reads `status()` as interruption evidence.

```ts
readonly tasks = new Tasks({
  definitions: {
    "generate@v1": {
      run: async (input: GenerateInput, step: TaskStep) => {
        return step.do("stream", async ({ checkpoint }) => {
          const stream = await this.streams.open(input.streamId);
          // Resuming producers start from the stream's own cursor, so a
          // replay never duplicates a chunk.
          for (let i = stream.cursor; i < input.total; i++) {
            stream.append(await this.produce(i));
            checkpoint({ streamId: input.streamId, cursor: stream.cursor });
          }
          stream.close();
        });
      },
      recover: async (interruption) => {
        const { streamId } = interruption.interruptedStep?.checkpoint ?? {};
        const status = await this.streams.status(streamId);
        // reattach the provider at status.cursor, finalize the partial
        // (open + close), or replay — with durable evidence in hand
      }
    }
  }
});
```

Neither capability imports the other. The composition survives a real
process kill: the chunks appended before death are exactly what `status()`
reports afterward (proven by the SIGKILL e2e suite).

## Serving

`read()` is an async iterable; pipe it into your own SSE or WebSocket
handler and pass the request's signal so a disconnecting client aborts the
tail. `examples/next/streams` serves a stream over SSE with cursor-based
reconnects.

## Current limits

Live fanout is in-isolate (sufficient: a Durable Object executes in one
isolate at a time; reconnecting readers replay from their cursor). Retention
is explicit `delete()`; age-based sweeping, producer-generation fencing on
`open()`, and transport helpers extracted from chat's resume protocol are
future work, as is migrating chat's resumable-stream store onto this
capability. The design record is
[`design/rfc-streams.md`](https://github.com/cloudflare/agents/blob/main/design/rfc-streams.md).
