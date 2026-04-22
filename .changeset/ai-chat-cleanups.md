---
"@cloudflare/ai-chat": minor
"agents": patch
---

Align `AIChatAgent` generics and types with `@cloudflare/think`, plus a reference example for multi-session chat built on the sub-agent routing primitive.

- **New `Props` generic**: `AIChatAgent<Env, State, Props>` extending `Agent<Env, State, Props>`. Subclasses now get properly typed `this.ctx.props`.
- **Shared lifecycle types**: `ChatResponseResult`, `ChatRecoveryContext`, `ChatRecoveryOptions`, `SaveMessagesResult`, and `MessageConcurrency` now live in `agents/chat` and are re-exported by both `@cloudflare/ai-chat` and `@cloudflare/think`. No behavior change; one place to edit when shapes evolve.
- **`UIMessage` everywhere**: `AIChatAgent` now imports and uses `UIMessage` from `"ai"` directly instead of aliasing to `ChatMessage`. The `ChatMessage` type is no longer exported from `@cloudflare/ai-chat`. If you were importing `ChatMessage` from `@cloudflare/ai-chat`, switch to `UIMessage` from `"ai"`.
- **`messages` is now a getter**: `get messages(): UIMessage[]` (no setter), backed by a `protected _messages: UIMessage[]`. Prevents accidental `this.messages = newArray` reassignment from subclasses. The returned array type stays mutable for AI SDK compatibility; in-place mutations should still go through `saveMessages` / `persistMessages`.

The full stance (AIChatAgent stays maintained while Think stabilizes, opportunistic hoisting into `agents/chat`, no feature parity push) is captured in [`design/rfc-ai-chat-maintenance.md`](../design/rfc-ai-chat-maintenance.md).

A new example, `examples/multi-ai-chat`, demonstrates the multi-session pattern end-to-end on top of the sub-agent routing primitive: an `Inbox` Agent owns the chat list + shared memory; each chat is an `AIChatAgent` facet (`this.subAgent(Chat, id)`). The client addresses the active chat via `useAgent({ sub: [{ agent: "Chat", name: chatId }] })` — no separate DO binding, no custom routing on the server. `Inbox.onBeforeSubAgent` gates with `hasSubAgent` as a strict registry, and `Chat` reaches its parent via `this.parentPath[0]`.
