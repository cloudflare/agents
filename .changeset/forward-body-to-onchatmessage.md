---
"@cloudflare/ai-chat": patch
---

Forward custom body fields from client requests to `onChatMessage` options

Custom data sent via `prepareSendMessagesRequest` or the AI SDK's `body` option in `sendMessage` is now available in the `onChatMessage` handler through `options.body`. This allows passing dynamic context (e.g., model selection, temperature, custom metadata) from the client to the server without workarounds.
