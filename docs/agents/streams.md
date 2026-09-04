# Streams

> **Experimental.** Everything exported from `agents/streams` may change
> between releases while the durable output surface stabilizes.

`agents/streams` adds durable incremental output to a [Lifecycle
Object](./lifecycle.md): an ordered, durable chunk log per stream with a
monotonic cursor, replay-then-tail reads, and terminal status. A consumer
that reconnects replays from its cursor; a producer that dies mid-stream
leaves exactly the chunks it durably appended, ready for a replayed
producer to resume from. The capability needs no alarm, so it also works
on facets.

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

Reads are independent of producer liveness. `list()` filters by state and
by `tag`, and `delete()` removes a settled stream and its chunk log (a live
stream must be settled first).

**Tags** are the lookup side of the id: `open(id, { tag })` stamps a stream
with an indexed application key — a request id, a session — that is
deliberately _not_ unique. An operation that produces successive streams (a
retried turn, a regenerated reply) tags each one, and
`list({ tag, limit: 1 })` finds the latest (results are newest-first). The
tag is fixed at creation; reopening a live stream with a different tag
throws. Use the id alone until one operation can own more than one stream —
that's the moment tags exist for.

`readBatches` also accepts `onUpToDate`, invoked once when the reader first
reaches the durable tail. Caught-up is distinct from ended: a live stream is
up to date while tailing — use it to flush replayed UI or flip on a "live"
indicator.

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

The contract [Tasks](./tasks.md) replay was designed around: a task step
appends to a stream it does not own, and because the producer starts its
loop at the stream's own durable cursor, a replay after interruption is a
resume — the stream is the recovery evidence.

```ts
readonly tasks = new Tasks({
  definitions: {
    "generate@v1": async (input: GenerateInput, step: TaskStep) => {
      return step.do("stream", async () => {
        const stream = await this.streams.open(input.streamId);
        // Resuming producers start from the stream's own cursor, so a
        // replay after interruption never duplicates a chunk.
        for (let i = stream.cursor; i < input.total; i++) {
          stream.append(await this.produce(i));
        }
        stream.close();
      });
    }
  }
});
```

Neither capability imports the other. The composition survives a real
process kill: the chunks appended before death are exactly what `status()`
reports afterward (proven by the SIGKILL e2e suite).

## Serving

For SSE, one call serves the whole lifecycle:

```ts
import { sseResponse } from "agents/streams";

async onRequest(request: Request) {
  return sseResponse(this.streams, "reply:123", { request });
}
```

Each chunk's sequence number rides the SSE `id:` field, so resume is native
to the protocol: a reconnecting `EventSource` sends `Last-Event-ID`
automatically and the helper continues from the next chunk — cursor
persistence with zero client code (`?from=` works too). The response
replays, emits an `up-to-date` control event at the tail, tails live
appends (with periodic heartbeat comments to survive idle proxies), and
finishes with `done` or `error` (carrying the recorded reason). The
request's signal aborts the tail when the client disconnects.
`examples/next/streams` is the end-to-end demo. For other transports,
`read()`/`readBatches()` remain the raw async iterables to pipe yourself.

## Storage: blocks, and the cutover to a message

Chunks are stored as **rollover blocks**: one row per stream holds chunks
until it reaches 256 KB, then the next append opens a new row. An append
is one billed row either way (an UPDATE that grows the block, or the INSERT
of the next one), the same as a row-per-chunk log, but a stream of
thousands of chunks is a handful of rows, so deleting it is a handful of
writes instead of thousands. Replay parses one block at a time.

A stream is temporary: once its content has become something else (a
session message, a report), its rows are dead weight. The **cutover** ends
the stream, runs your own synchronous writes, and deletes its rows in one
SQLite transaction:

```ts
stream.close({
  commit: () => sessionSync.upsert(message), // synchronous writes only
  discard: true // delete the stream's rows in the same transaction
});
```

Either the message exists and the stream is gone, or `commit` threw, the
settle rolled back and the stream is still live. Nothing is left for a
retention sweep. `error(reason, { commit, discard })` is the same for a
failed producer. `commit` must not await; a Session handle's
`__DO_NOT_USE_WILL_BREAK__sync().upsert()` is the matching synchronous
message write, and returns a `notify()` to dispatch the change feed after
the transaction commits.

Measured on a real Durable Object (400-chunk chat turn, 10 chunks per
write): the old log paid 42 rows to write and another 42 to sweep; blocks
pay 42 to write and 3 to cut over.

## Chat runs on this

`AIChatAgent` and `Think` store their in-flight turn output here:
`ResumableStream` (from `agents/chat`) is a thin adapter over Streams that
packs ~10 wire chunks into one stored segment for write economy, maps
completion/error onto stream settlement, and decides retention in two
phases: a coarse cutoff on the stream row's own timestamp, verified
against the newest chunk so an actively appending stream is never swept.
Existing `cf_ai_chat_stream_*` tables migrate onto the
capability automatically. The packing pattern is worth copying for any
high-frequency producer: buffer what you already hold synchronously, append
one packed chunk, and unpack on read — durability is unchanged (nothing is
held across an await at settlement) and rows written drop by ~an order of
magnitude versus per-token appends.

## Current limits

Live fanout is in-isolate (sufficient: a Durable Object executes in one
isolate at a time; reconnecting readers replay from their cursor). Retention
is explicit `delete()` (chat sweeps its own rows on an alarm); age-based
sweeping in the capability itself, producer-generation fencing on `open()`,
and transport helpers extracted from chat's resume protocol are future work.
The design record is
[`design/rfc-streams.md`](https://github.com/cloudflare/agents/blob/main/design/rfc-streams.md).
