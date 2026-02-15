---
"@cloudflare/ai-chat": patch
---

Add structural message validation and fix message metadata on broadcast/resume path.

**Structural message validation:**

Messages loaded from SQLite are now validated for required structure (non-empty `id` string, valid `role`, `parts` is an array). Malformed rows — from corruption, manual tampering, or schema drift — are logged with a warning and silently skipped instead of crashing the agent. This is intentionally lenient: empty `parts` arrays are allowed (streams that errored mid-flight), and no tool/data schema validation is performed at load time (that remains a userland concern via `safeValidateUIMessages` from the AI SDK).

**Message metadata on broadcast/resume path:**

The server already captures `messageMetadata` from `start`, `finish`, and `message-metadata` stream chunks and persists it on `message.metadata`. However, the client-side broadcast path (multi-tab sync) and stream resume path (reconnection) did not propagate metadata — the `activeStreamRef` only tracked `parts`. Now it also tracks `metadata`, and `flushActiveStreamToMessages` includes it in the partial message flushed to React state. This means cross-tab clients and reconnecting clients see metadata (model info, token usage, timestamps) during streaming, not just after the final `CF_AGENT_CHAT_MESSAGES` broadcast.
