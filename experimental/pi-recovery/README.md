# pi-recovery

An internal **genericity harness** for the shared chat-recovery engine in
[`agents/chat`](../../packages/agents/src/chat). It drives a **non–AI-SDK**
agent — the [pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
`Agent`, whose stream is `AgentEvent`s, not AI-SDK `UIMessage` parts — through
the same `ChatRecoveryEngine` that `@cloudflare/ai-chat` and `@cloudflare/think`
use, proving the engine is not coupled to the AI SDK.

See `design/rfc-chat-recovery-foundation.md` (Phase 5, "second harness" /
genericity proof).

## What it proves

The engine reconstructs an interrupted turn's partial by replaying a durable
stream buffer through a **codec**. The AI-SDK adapter decodes SSE chunks with
`applyChunkToParts`; pi decodes its OWN `message_update` / `message_end` event
vocabulary with [`PiRecoveryCodec`](./src/pi-codec.ts). Both feed the engine the
identical `RecoveryPartial` (`{ text, parts, hasSettledToolResults }`), so the
engine never sees the wire vocabulary — the **codec**, not the engine, owns the
chunk-shape differences.

`PiAgent` doesn't just inspect the partial: it persists it
(`persistOrphanedStream`) and the recovered turn **continues** from it — the
model regenerates only the remaining suffix, which merges onto the survived
prefix (`stream_continuation`, mirroring the AI-SDK adapter).

## Why a faux model

`src/pi-model.ts` registers pi-ai's `registerFauxProvider`, so a turn streams
through pi's REAL stream path with NO network and NO LLM. `tokensPerSecond` is
low so a turn streams over several seconds — long enough for a `wrangler dev`
SIGKILL to interrupt it mid-stream and exercise fiber recovery deterministically.

## Run

```bash
cd experimental/pi-recovery

# Pure codec unit tests (plain node, no Workers runtime)
pnpm test

# Real `wrangler dev` + mid-stream SIGKILL continuation e2e
pnpm test:e2e
```

The e2e starts `wrangler dev` running the `PiAgent` Durable Object, begins a
turn, confirms it is in-flight (orphaned fiber row, no committed assistant),
SIGKILLs the process mid-stream, restarts against the same `--persist-to` state,
and asserts the turn recovers via `continue` with byte-exact prefix+suffix math.

Both suites run nightly via the `e2e-engine-genericity` job in
`.github/workflows/nightly.yml`.

> Experimental test harness — not a product example.
