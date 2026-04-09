---
"@cloudflare/think": patch
"agents": patch
---

Think now owns the inference loop with lifecycle hooks at every stage.

**Breaking:** `onChatMessage()`, `assembleContext()`, and `getMaxSteps()` are removed. Use lifecycle hooks and the `maxSteps` property instead. If you need full custom inference, extend `Agent` directly.

**New lifecycle hooks:** `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChunk` — fire on every turn from all entry paths (WebSocket, `chat()`, `saveMessages`, auto-continuation).

**`beforeTurn(ctx)`** receives the assembled system prompt, messages, tools, and model. Return a `TurnConfig` to override any part — model, system prompt, messages, tools, activeTools, toolChoice, maxSteps, providerOptions.

**`maxSteps`** is now a property (default 10) instead of a method. Override per-turn via `TurnConfig.maxSteps`.

**MCP tools auto-merged** — no need to manually merge `this.mcp.getAITools()` in `getTools()`.

**Dynamic context blocks:** `Session.addContext()` and `Session.removeContext()` allow adding/removing context blocks after session initialization (e.g., from extensions).

**Extension manifest expanded** with `context` (namespaced context block declarations) and `hooks` fields.
