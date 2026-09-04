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

## Storing chunks in R2

Hand `Streams` an R2 binding and the chunk log leaves the Durable Object:

```ts
readonly streams = new Streams({
  r2: this.env.BUCKET,
  r2Prefix: `streams/${this.ctx.id}/`, // default "streams/"; include the id when objects share a bucket
  r2Checkpoint: { everyChunks: 25, everyMs: 1000 } // the defaults
});
```

Nothing else changes: `open`, `append`, `read`, `status`, `list`, `delete`
behave as above, and `append()` is still synchronous. Stream rows (state,
tag index, metadata, cursor) stay in SQLite, where a point read or tag
lookup costs nothing; chunks go to the bucket.

**Why this exists: cost.** SQLite bills one row per stored chunk and again
to delete it; R2 bills one Class A op per checkpoint, deletes are free, and
storage is about 13 times cheaper with no 10 GB ceiling. One R2 put costs
the same as 4.5 SQLite row writes, so the R2 log is cheaper whenever a
checkpoint covers more than about 4.5 stored rows. For a 400-chunk chat
turn: about $0.0008 per turn on SQLite unpacked, $0.00008 packed ten to a
row, $0.00009 on R2 at the default cadence, $0.00002 at a 5-second one.
Against packed SQLite, R2 only wins once you widen the loss window.

**How it works, and what a Durable Object dying means.** R2 has no append,
rejects bodies of unknown length, and stores nothing from a put that has
not completed. So the log is a write-ahead log of segment objects:

- Appends go into an in-memory line log that live readers tail, exactly
  like the SQLite log's wakeups.
- Every `everyChunks` appends or `everyMs` after the first unflushed one,
  the new lines are put as one immutable segment under `<id>/seg/`. Each
  landed segment is the durability. When the isolate dies, everything up
  to the last landed segment is in R2, and the loss window is the cadence.
- The row's cursor is stamped only after a segment's put resolves, so
  `status()` never reports more than R2 holds.
- `open()` on a stream whose isolate died rebuilds the log from the
  contiguous segment chain, deletes keys the chain does not cover, and
  continues in a new epoch. A resumed producer starts at the durable
  cursor, so the Tasks resume contract holds and no discarded generation
  can be spliced back in.
- `close()` and `error()` settle the row synchronously, then in the
  background put the whole body as one exact-size object at `<id>/body`
  so replay is a single get, and drop the segments. Segments stay readable
  until the body lands, so a death mid-settle loses nothing. `await
  streams.flush(id)` waits for the body when you need the object to exist.
- Replay of a settled stream reads the body once and caches it, bounded
  at 8 MiB per isolate.

**What SQLite still pays.** Appends read and write nothing; each landed
segment writes one row to stamp the cursor; `status()` reads one row, a
tag lookup two, settlement reads two and writes two. Rows read bill at a
thousandth of the write price.

Chat's `ResumableStream` uses the synchronous SQLite aperture and is not
affected by this option; it throws if asked for an R2-backed `Streams`.

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
