# tanstack-recovery

An internal **genericity harness** for the shared chat-recovery engine in
[`agents/chat`](../../packages/agents/src/chat). It drives a
[TanStack AI](https://www.npmjs.com/package/@tanstack/ai) client over a
WebSocket bridge through the same `ChatRecoveryEngine` + resume handshake that
`@cloudflare/ai-chat` and `@cloudflare/think` use — but over a **foreign tool
vocabulary** (AG-UI `EventType`s), not AI-SDK `UIMessage` parts.

This is the "second harness" alongside [`pi-recovery`](../pi-recovery): where pi
proves a non-AI-SDK _agent_, this proves a non-AI-SDK _client transport + tool
protocol_. See `design/rfc-chat-recovery-foundation.md` (Phase 5).

## What it proves

[`TanStackRecoveryCodec`](./src/tanstack-codec.ts) decodes AG-UI
`TEXT_MESSAGE_*` / `TOOL_CALL_*` chunks into the engine's `RecoveryPartial`, and
reconstructs tool parts in its OWN AG-UI-native shape — deciding
`hasSettledToolResults` itself. The shared engine consumes only that boolean
(never an AI-SDK part shape), which is how the `{ persist: false }` gate
preserves a foreign tool's completed work.

The e2e (`e2e/recovery.test.ts`) covers four scenarios over a real `wrangler
dev` + SIGKILL:

1. **ResumeHandshake** mid-stream — client reconnect sees `STREAM_RESUMING` →
   ACK → buffered replay → live tail.
2. **ChatRecoveryEngine** SIGKILL continuation with exact prefix/suffix math.
3. **Settled-tool persist gate** — AG-UI tool parts keep the partial under
   `{ persist: false }`.
4. Text-only partial under `{ persist: false }` is dropped → `recoveredVia:
"retry"`.

## Faux vs. real Workers AI

The default model (`src/faux-model.ts`) is deterministic and makes no `AI.run()`
call, so the suite is fully offline. An OPTIONAL leg
(`e2e/workers-ai.test.ts`) drives the same codec + engine against real **Workers
AI** to prove the codec axis with a non-deterministic provider; it is gated
behind `RUN_WORKERS_AI_E2E=1` (needs network + a Cloudflare account) and skipped
otherwise.

## Run

```bash
cd experimental/tanstack-recovery

# Pure codec unit tests (plain node, no Workers runtime)
pnpm test

# Real `wrangler dev` + SIGKILL e2e (faux model, offline)
pnpm test:e2e

# Optional real-Workers-AI leg (needs network + CF account)
RUN_WORKERS_AI_E2E=1 pnpm test:e2e
```

The faux e2e + unit tests run nightly via the `e2e-engine-genericity` job in
`.github/workflows/nightly.yml`.

> Experimental test harness — not a product example.
