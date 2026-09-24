---
"@cloudflare/think": minor
---

Expose the running turn's identity to hooks and tools. `TurnContext` now carries `requestId`, `trigger` and `abortSignal`, and `ToolCallContext` carries `requestId`, so `beforePersist`, `beforeTurn`, `beforeToolCall`, `onChatResponse` and `onChatError` can all be matched to the same turn. A new `activeTurn` getter returns `{ requestId, trigger, continuation, channel? }` from anywhere inside a turn, such as a tool's `execute`. `TurnTrigger` and `ActiveTurn` are exported, and extension `beforeTurn` snapshots include `requestId` and `trigger`.

Also fix concurrent messenger turns reading each other's thread. `chatWithMessengerContext` stored the context on the agent before the turn waited in the queue, so a second messenger turn admitted meanwhile replaced it, and the first turn's cleanup could clear it for the second. The context now travels with the turn, and `beforeTurn` receives it as `ctx.messenger`.
