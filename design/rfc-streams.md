# Design record: Streams — durable incremental output

Status: shipped as `agents/streams` (this document records the shipped
design and how it evolved during implementation).

## The problem

Durable _execution_ has one home — the Tasks capability
([rfc-fibers.md](./rfc-fibers.md)) — but durable _incremental output_ had
none. The chunk-log machinery that makes chat streams resumable lived in
`packages/agents/src/chat` with chat vocabulary attached, so a plain
Durable Object could not have a resumable stream without importing a chat
stack; every new streaming producer re-invented a chunk table; and a task
step's single JSON result is the wrong shape for output that must be
observable while it is produced and must survive the producer's death
mid-production.

## The shipped design

One `Streams` capability per Lifecycle Object owns an ordered, durable
chunk log per stream with a monotonic cursor, in its own tables
(`cf_agents_streams`, `cf_agents_stream_chunks`):

```ts
readonly streams = new Streams();
readonly lifecycle = Lifecycle.install(this).use(this.streams);

const stream = await this.streams.open("reply:123", { tag: requestId });
stream.append(chunk); // synchronous durable write; wakes live readers
stream.close(); // or stream.error(reason)

for await (const batch of this.streams.readBatches("reply:123", {
  from,
  onUpToDate
})) {
  /* replay from the cursor, then live-tail */
}
const status = await this.streams.status("reply:123");
// { state, cursor, tag?, ... } — the evidence a replayed producer resumes from
```

- **Cursors are monotonic sequence numbers** (0-based; `from` is
  inclusive; `status().cursor` is the next to be assigned). The append
  fence — a count-bump UPDATE that succeeds only while the stream is live —
  assigns them and rejects writes to settled streams.
- **`open()` is idempotent on the id**: reopening a live stream returns a
  writer at its cursor; reopening a settled stream throws; settling twice
  is a no-op so recovery callers stay idempotent.
- **Reads are independent of producer liveness**: replay from any cursor,
  then tail live appends, ending at settlement. `readBatches` yields one
  array per replay slice and per live-tail wakeup (`onUpToDate` fires once
  at the tail — caught-up is distinct from ended). `read` is the per-chunk
  form over the same core.
- **Tags are the lookup side of the id**: `open(id, { tag })` stamps an
  indexed, deliberately non-unique application key, fixed at creation; an
  operation whose retries produce successive streams finds the latest with
  `list({ tag, limit: 1 })`.
- **No time-based behavior, therefore no jobs and no alarm.** Appends
  happen inside the producer's invocation; in-isolate readers are woken by
  the append itself; external readers hold a connection or replay on
  reconnect. This is also why the capability works on facets. In the
  composed architecture, the job queue wakes the _producer_ (a Task's
  mirror job); the task's step appends; the append wakes readers.
- **Serving**: `sseResponse(streams, id, { request })` serves the whole
  lifecycle over SSE — each chunk's seq rides the SSE `id:` field so a
  reconnecting `EventSource` resumes via `Last-Event-ID` with zero client
  code, with `up-to-date`/`done`/`error` control events and heartbeat
  comments. `read()`/`readBatches()` remain the raw iterables for other
  transports.
- **Live fanout is in-isolate only** — sufficient because a Durable Object
  executes in one isolate at a time; reconnecting readers replay from
  their cursor.

### The Tasks composition contract

A task step appends to a stream it does not own and starts its producer
loop at the stream's own durable cursor, so a replay after interruption is
a resume — the stream **is** the interruption evidence:

```ts
"generate@v1": async (input, step) =>
  step.do("stream", async () => {
    const stream = await this.streams.open(input.streamId);
    for (let i = stream.cursor; i < input.total; i++) {
      stream.append(await produce(i));
    }
    stream.close();
  });
```

Neither capability imports the other. The contract is proven across a real
SIGKILL: the chunks appended before death are exactly what `status()`
reports afterward, and the resumed producer finishes with a gapless,
duplicate-free sequence.

### The chat replatform

`ResumableStream` — the store behind resumable chat streaming in
`AIChatAgent` and `Think` — is a thin adapter over this capability:
producer-side coalescing (~10 wire chunks packed per stored segment, for
storage-op economy), the chat wire protocol and replay handshake, and
retention policy (10-minute completed grace, 1-hour abandoned window keyed
off the stream row's `updated_at`, swept on chat's own schedule). Chat
streams carry their request id as the indexed `tag`; legacy
`cf_ai_chat_stream_*` tables migrate wholesale on first construction —
an in-flight stream survives the upgrade — then are dropped. The adapter
runs on a fully typed internal sync aperture
(`Streams.__DO_NOT_USE_WILL_BREAK__sync()`), because its surface is
synchronous and constructed before the Lifecycle starts; the
invariant-bearing writes go through the same private methods as the
public API, so live readers and diagnostics observe chat streams like any
other stream.

Storage-op accounting (benchmarked in-suite on real DO SQLite): the packed
adapter writes within 2× of the legacy pattern (the fence per segment,
buying settled-write rejection, the cursor, and `updated_at`), ~9× under
naive per-chunk appends, and retention sweeps read only stream rows —
down ~6× and no longer proportional to stored chunks.

## How the design evolved

1. **The composition contract simplified from checkpoints to cursors.**
   The original contract had the producing step `checkpoint({ streamId,
cursor })` and a `recover` callback read `status()` as evidence. When
   Tasks' custom recovery was removed (see rfc-fibers.md), the contract
   collapsed to what the producer loop already implied: resume from
   `stream.cursor`, no checkpoint hop, no callback.
2. **Tags, `onUpToDate`, and `sseResponse` were added from use.** Chat's
   replay-by-request lookups motivated the indexed tag; the caught-up
   signal and one-call SSE serving replaced hand-rolled `ReadableStream`
   plumbing in the example. The SSE resume design deliberately rides the
   protocol's own `Last-Event-ID` rather than inventing an offset header.
3. **The chat replatform landed in the same PR** rather than as a
   follow-up, with the chat suites as the parity ratchet.

## Alternatives considered

- **Fold streams into Tasks (`step.stream()`).** Couples transport to
  execution: streams have consumers that are not tasks, and tasks that
  produce no stream pay nothing today. Rejected.
- **Keep the store chat-only.** Blocks plain DOs and non-chat producers,
  and leaves the Tasks replay contract pointing at an ad-hoc store.
  Rejected.
- **Build on an external log** (see
  [durable-streams-comparison.md](./durable-streams-comparison.md)).
  Changes the trust and latency model and adds an infrastructure
  dependency; the DO-local SQLite chunk log is proven by chat at
  production scale. An external sink could be an adapter later.

## Deliberately deferred

- Age-based retention sweeping in the capability itself (one queue job
  when built; chat sweeps its own rows meanwhile).
- Producer-generation fencing on `open()` (terminal-state fences on every
  append cover the realistic races today).
- Transport helpers beyond SSE, extracted from chat's resume protocol.

## Verification stance

Real Durable Objects only: standalone (`StreamHarnessObject`, Streams as
the sole capability) and composed (`TaskStreamComposeObject`) fixtures over
a real Lifecycle and real SQLite; a SIGKILL e2e killing a producer
mid-stream; an in-suite storage-ops benchmark that asserts the cost model
so regressions fail CI; and the chat suites as the replatform ratchet.
