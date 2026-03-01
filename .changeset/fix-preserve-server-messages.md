---
"@cloudflare/ai-chat": patch
---

fix(ai-chat): preserve server-generated assistant messages when client appends new messages

The `_deleteStaleRows` reconciliation in `persistMessages` now only deletes DB rows when the incoming message set is a subset of the server state (e.g. regenerate trims the conversation). When the client sends new message IDs not yet known to the server, stale deletion is skipped to avoid destroying assistant messages the client hasn't seen.
