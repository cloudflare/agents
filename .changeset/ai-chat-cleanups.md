---
"@cloudflare/ai-chat": minor
"agents": patch
---

Align `AIChatAgent` generics and types with `@cloudflare/think`, plus a reference example for multi-session chat built on the sub-agent routing primitive.

- **New `Props` generic**: `AIChatAgent<Env, State, Props>` extending `Agent<Env, State, Props>`. Subclasses now get properly typed `this.ctx.props`.
- **Shared lifecycle types**: `ChatResponseResult`, `ChatRecoveryContext`, `ChatRecoveryOptions`, `SaveMessagesResult`, and `MessageConcurrency` now live in `agents/chat` and are re-exported by both `@cloudflare/ai-chat` and `@cloudflare/think`. No behavior change; one place to edit when shapes evolve.
- **`UIMessage` internally, `ChatMessage` still exported**: `AIChatAgent` now uses `UIMessage` from `"ai"` throughout the implementation, but `export type ChatMessage = UIMessage` remains for backwards compatibility.
- **`messages` stays a public field**: still `messages: UIMessage[]` for compatibility with existing subclasses that assign or mutate it directly.

The full stance (AIChatAgent is first-class, production-ready, and continuing to get features; shared infrastructure should land in `agents/chat` where both classes benefit) is captured in [`design/rfc-ai-chat-maintenance.md`](../design/rfc-ai-chat-maintenance.md).

A new example, `examples/multi-ai-chat`, demonstrates the multi-session pattern end-to-end on top of the sub-agent routing primitive: an `Inbox` Agent owns the chat list + shared memory; each chat is an `AIChatAgent` facet (`this.subAgent(Chat, id)`). The client addresses the active chat via `useAgent({ sub: [{ agent: "Chat", name: chatId }] })` — no separate DO binding, no custom routing on the server. `Inbox.onBeforeSubAgent` gates with `hasSubAgent` as a strict registry, and `Chat` reaches its parent via `this.parentAgent(Inbox)`.
