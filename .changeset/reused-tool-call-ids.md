---
"agents": patch
---

Avoid corrupting persisted chat history when a model provider reuses `toolCallId` values across turns. Tool output merging and assistant ID reconciliation now only reuse an existing assistant row when the matching tool call belongs to a compatible message, preserving the existing stale-client snapshot deduplication behavior without overwriting later assistant responses.
