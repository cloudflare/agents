---
"agents": minor
"@cloudflare/ai-chat": patch
---

Expose `WebSocketChatTransport` and its connection types from the framework-neutral `agents/chat/transport` entry point. React peers are now optional for framework-neutral clients and servers.

Existing users of `agents/chat/react` or `@cloudflare/ai-chat/react` must continue to declare compatible `react` and `@ai-sdk/react` dependencies explicitly.
