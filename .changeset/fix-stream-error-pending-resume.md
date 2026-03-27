---
"@cloudflare/ai-chat": patch
---

Fix `_pendingResumeConnections` not being cleared on stream error, which caused connections in the resume handshake to be permanently excluded from broadcasts when a continuation stream errored.
