# Forever Chat — Durable AI Streaming

> **WARNING: EXPERIMENTAL.** This example uses APIs from `agents/experimental/forever` and `@cloudflare/ai-chat/experimental/forever` that are under active development and **will break** between releases. Do not use in production. Pin your package versions and expect to rewrite your code when upgrading.

AI chat using `withDurableChat(AIChatAgent)` — the mixin adds keepAlive during streaming and recovery hooks for interrupted streams.

See [forever.md](../forever.md) for the full design doc.

## What it shows

- `withDurableChat` mixin from `@cloudflare/ai-chat/experimental/forever`
- keepAlive during streaming — DO stays alive for long LLM responses
- `onStreamInterrupted` — detects when a stream was interrupted by eviction and persists the partial response
- `continueLastTurn()` — seamlessly continues the interrupted assistant message inline (no synthetic user message)
- Same features as the `ai-chat` example (tools, approval, pruning)

## Run it

```bash
npm install
cd experimental/forever-chat
npm start
```

Requires Workers AI (uses the `AI` binding — works automatically in `wrangler dev`).
