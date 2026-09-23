---
"@cloudflare/think": minor
---

`Think` can now write server-authored metadata onto the assistant message a turn persists. Previously `Think` wrapped the AI SDK stream and forwarded only `{ sendReasoning, onError }` through `toUIMessageStream`, dropping the `messageMetadata` callback that base `AIChatAgent` + `streamText` accept — so a turn could stamp metadata on user messages but not assistant ones (#1873).

Set the instance-level `messageMetadata` property for metadata that applies to every turn (for example, a `createdAt` timestamp), or return `messageMetadata` from `beforeTurn` (`TurnConfig.messageMetadata`) to override it for one turn. The callback receives each AI SDK stream part; each non-`undefined` return is shallow-merged into the assistant message's metadata, streamed to clients, and persisted. It works on both the WebSocket chat path and the sub-agent `chat()` RPC path. The new `MessageMetadataCallback<Metadata>` type is exported.
