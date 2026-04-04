---
"agents": minor
"@cloudflare/ai-chat": minor
"@cloudflare/think": minor
---

Add durable fiber execution to the Agent base class.

`runFiber(name, fn)` registers work in SQLite, holds a `keepAlive` ref, and enables recovery via `onFiberRecovered` after DO eviction. `ctx.stash()` and `this.stash()` checkpoint progress that survives eviction.

`AIChatAgent` gains `durableStreaming` — when enabled, each chat turn is wrapped in a fiber. `onChatRecovery` provides provider-specific recovery (Workers AI continuation, OpenAI response retrieval, Anthropic synthetic message). `continueLastTurn()` appends to the interrupted assistant message seamlessly.

`Think` now extends `Agent` directly (no mixin). Fiber support is inherited from the base class.

**Breaking (experimental APIs only):**

- Removed `withFibers` mixin (`agents/experimental/forever`)
- Removed `withDurableChat` mixin (`@cloudflare/ai-chat/experimental/forever`)
- Removed `./experimental/forever` export from both packages
- Think no longer has a `fibers` flag — recovery is automatic via alarm housekeeping
