---
"@cloudflare/think": patch
"agents": patch
---

`Think` replies, `chat()` over RPC included: a provider's replay of a settled tool call is not sent to tabs, an in-band error frame waits for the stored reply, `onChatError` sees every stream error, and a reply whose store fails runs `onChatResponse` with `error`. See [the decisions](https://github.com/cloudflare/agents/blob/main/design/chat-turn-core.md).
