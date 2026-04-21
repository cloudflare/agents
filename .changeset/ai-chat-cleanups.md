---
"@cloudflare/ai-chat": minor
"agents": patch
---

Align `AIChatAgent` generics and types with `@cloudflare/think`.

- **New `Props` generic**: `AIChatAgent<Env, State, Props>` extending `Agent<Env, State, Props>`. Subclasses now get properly typed `this.ctx.props`.
- **Shared lifecycle types**: `ChatResponseResult`, `ChatRecoveryContext`, `ChatRecoveryOptions`, `SaveMessagesResult`, and `MessageConcurrency` now live in `agents/chat` and are re-exported by both `@cloudflare/ai-chat` and `@cloudflare/think`. No behavior change; one place to edit when shapes evolve.
- **`UIMessage` everywhere**: `AIChatAgent` now imports and uses `UIMessage` from `"ai"` directly instead of aliasing to `ChatMessage`. The `ChatMessage` type is no longer exported from `@cloudflare/ai-chat`. If you were importing `ChatMessage` from `@cloudflare/ai-chat`, switch to `UIMessage` from `"ai"`.
- **`messages` is now a getter**: `get messages(): UIMessage[]` (no setter), backed by a `protected _messages: UIMessage[]`. Prevents accidental `this.messages = newArray` reassignment from subclasses. The returned array type stays mutable for AI SDK compatibility; in-place mutations should still go through `saveMessages` / `persistMessages`.

The full stance (AIChatAgent stays maintained while Think stabilizes, opportunistic hoisting into `agents/chat`, no feature parity push) is captured in [`design/rfc-ai-chat-maintenance.md`](../design/rfc-ai-chat-maintenance.md). A reference example demonstrating the multi-session pattern with `AIChatAgent` children ships as `examples/multi-ai-chat`.
