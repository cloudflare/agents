# RFC: Streams — a durable incremental-output capability

Status: proposed

## The problem

Durable _execution_ now has one home — the Tasks capability (`agents/tasks`,
[rfc-fibers.md](./rfc-fibers.md)) — but durable _incremental output_ does
not. Three symptoms:

- The chunk-log machinery that makes chat streams resumable (stream metadata
  and chunk persistence, replay-then-tail reads, terminal status) lives in
  `packages/agents/src/chat` with chat vocabulary attached. `AIChatAgent`
  and `Think` both drive it; a plain Durable Object or a non-chat Agent
  cannot have a resumable stream without importing a chat stack.
- The Tasks migration formalized a composition pattern — a task step appends
  chunks to a store it does not own and `checkpoint()`s a cursor, and its
  `recover` callback reads the store's status as interruption evidence —
  but the "store" half of that contract has no first-class API. Every new
  streaming producer (voice, progress feeds, channel delivery) re-invents a
  chunk table.
- A step result is a single JSON value written once at completion (≤ 1 MiB),
  which is the wrong shape for output that must be observable while it is
  produced and must survive the producer's death mid-production.

## The proposal

One `Streams` capability in `agents/streams`, following the same lego rules
as Scheduler and Tasks: standard Lifecycle services only, its own tables,
alarm participation only if retention needs it, no host adapter bags.

```ts
export class ReportObject extends DurableObject<Env> {
  readonly streams = new Streams();
  readonly tasks = new Tasks({
    definitions: {
      /* ... */
    }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.tasks);
}
```

### Producer surface

```ts
const stream = await this.streams.open("reply:123", { metadata });
stream.append(chunk); // durable write + live fanout, ordered
stream.close(); // terminal: completed
stream.error(reason); // terminal: errored
```

`open()` is idempotent on the stream id: reopening a live stream returns a
writer positioned at its cursor; reopening a terminal stream throws. Chunks
are opaque JSON values with a per-chunk size limit; the store assigns each a
monotonic sequence number — the **cursor**.

### Consumer surface

```ts
for await (const chunk of this.streams.read("reply:123", { from: cursor })) {
  // replays persisted chunks from `from`, then tails live appends,
  // ends when the stream closes or errors
}

const { state, cursor } = await this.streams.status("reply:123");
// state: "streaming" | "completed" | "errored" — recovery evidence
```

Reads are independent of producer liveness: a consumer that reconnects
replays from its last cursor and tails; a consumer observing a dead
producer's stream sees exactly the chunks that were durably appended.

### The Tasks composition contract

The pattern Think validated in production shape, named:

```ts
"generate@v1": {
  run: (input, step) =>
    step.do("stream", async ({ checkpoint, signal }) => {
      const stream = await this.streams.open(input.streamId);
      for await (const chunk of model.stream(input, { signal })) {
        stream.append(chunk);
        checkpoint({ streamId: input.streamId, cursor: stream.cursor });
      }
      stream.close();
      return { streamId: input.streamId };
    }),
  recover: async (interruption) => {
    const cp = interruption.interruptedStep?.checkpoint;
    const status = await this.streams.status(cp.streamId);
    // reattach the provider at status.cursor, finalize the partial, or replay
  }
}
```

Tasks never imports Streams and Streams never imports Tasks: the checkpoint
carries the stream id and cursor across the boundary, and `status()` is the
recovery-evidence read. Convenience glue (for example a helper that fails a
stream when its producing run settles failed) can come later as an optional
adapter, not a coupling.

### Serving

A stream must reach clients. Phase 1 keeps this minimal: `read()` is an
async iterable the host can pipe into its own SSE/WebSocket handler. A later
phase can add transport helpers (an SSE `Response` builder, a WebSocket
resume handshake) extracted from chat's existing resume protocol.

### Migration

The store behind `agents/chat`'s resumable streams becomes the capability's
implementation; ai-chat and Think consume it through the capability instead
of the chat-local modules — the same staged playbook as the Tasks
replatform, with the chat suites (887 + 655) as the parity ratchet. Chat's
resume _protocol_ (client handshake, wire format) stays in chat; only the
durable store and cursor semantics move down.

## Alternatives considered

### Fold streams into Tasks (`step.stream()`)

Couples transport to execution: streams have consumers that are not tasks
(a live chat turn streaming to a client is not obligated to be a task) and
tasks that produce no stream pay nothing today. Rejected; a thin helper on
top of both can exist later.

### Keep the store chat-only (status quo)

Blocks plain DOs and non-chat producers from resumable output, and leaves
the Tasks recovery contract pointing at an ad-hoc store. Rejected.

### Build on an external log (Durable Streams / ElectricSQL shapes)

See [durable-streams-comparison.md](./durable-streams-comparison.md). An
external log changes the trust and latency model and adds an infrastructure
dependency; the DO-local SQLite chunk log is already proven by chat at
production scale. Not pursued for the capability itself; an external sink
could be an adapter.

## Open questions

1. Cursor semantics: monotonic sequence (proposed) vs byte offset — sequence
   is provider-agnostic and matches chat's chunk model.
2. Limits and retention: per-chunk size, per-stream chunk count, and a
   retention/delete policy (age-based sweep needs an alarm contribution).
3. Live fanout mechanics: in-isolate subscription only (consumers on the
   same DO) vs a WebSocket bridge in phase 1.
4. Should `open()` accept an expected-producer generation to fence two
   producers racing on one stream id, mirroring Tasks' generation fencing?
5. Does channel delivery (Think messengers) adopt Streams for its reply
   snapshots, or stay on checkpoints alone?

## Decision requested

Approve the direction: one `Streams` capability owning the durable chunk
log, cursor, replay-then-tail reads, and terminal status; composed with
Tasks through checkpointed cursors and `status()` evidence; populated by
extracting chat's resumable-stream store with the chat suites as the parity
ratchet.
