---
"@cloudflare/think": minor
---

`Think` can now write server-authored metadata onto the assistant message a turn persists. Previously `Think` wrapped the AI SDK stream and forwarded only `{ sendReasoning, onError }` through `toUIMessageStream`, dropping the `messageMetadata` callback that base `AIChatAgent` + `streamText` accept — so a turn could stamp metadata on user messages but not assistant ones (issue #1873).

Set the instance-level `messageMetadata` property for turn-independent metadata (e.g. a `createdAt` timestamp on every assistant message), or return `messageMetadata` from `beforeTurn` (`TurnConfig.messageMetadata`) to override it for one turn. The callback runs per stream part; return JSON-serializable metadata from the `start` and/or `finish` part (start/finish results are shallow-merged) — its return value is broadcast to clients and persisted. The new `MessageMetadataCallback<Metadata>` type carries a defaulted generic so a future typed-metadata story (issue #1676) can narrow the return type without a breaking change.
