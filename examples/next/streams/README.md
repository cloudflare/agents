# Next: streams

An early-access, server-only example composing `Streams` from
`agents/streams` with `Tasks` from `agents/tasks` on a plain Cloudflare
`DurableObject`: a durable task produces chunks into a durable stream,
clients read the stream over SSE independent of the producer's liveness, and
an interrupted producer is finalized from the stream's own durable cursor.

```ts
export class GenerateObject extends DurableObject<Env> {
  readonly streams = new Streams();
  readonly tasks = new Tasks({
    definitions: {
      "generate@v1": {
        run: async (input: GenerateInput, step: TaskStep) => {
          return step.do("stream", async ({ checkpoint }) => {
            const stream = await this.streams.open(input.streamId);
            for (let i = stream.cursor; i < input.total; i++) {
              stream.append({ i });
              checkpoint({ streamId: input.streamId, cursor: stream.cursor });
            }
            stream.close();
          });
        },
        recover: async (interruption) => {
          // Finalize from the stream's durable status — exactly the chunks
          // that survived the interruption.
        }
      }
    }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.tasks);
}
```

Neither capability imports the other: the task's step checkpoints
`{ streamId, cursor }`, and its `recover` callback reads
`streams.status(id)` as interruption evidence. Consumers replay from any
cursor and tail live appends.

## Run

```sh
pnpm install
pnpm run dev
```

Exercise the named object `demo`:

```sh
# Start a durable producer: 10 chunks, 500ms apart.
curl -X POST http://localhost:8787/agents/generate-object/demo/generate \
  -H "content-type: application/json" \
  -d '{"id": "report", "total": 10}'

# Watch the stream over SSE — replays persisted chunks, then tails live
# appends until the producer settles.
curl -N http://localhost:8787/agents/generate-object/demo/streams/report

# Reconnect mid-stream from a cursor (the SSE ids are the cursor).
curl -N "http://localhost:8787/agents/generate-object/demo/streams/report?from=4"

# Runs and streams at a glance.
curl http://localhost:8787/agents/generate-object/demo
```

The interesting part: start a longer run (`"total": 60`), stop
`wrangler dev` mid-production, and start it again. The chunks appended
before the kill survived in the stream's durable log; the task's `recover`
callback reads the stream's cursor and finalizes it, and a fresh SSE read
serves exactly the surviving chunks.
