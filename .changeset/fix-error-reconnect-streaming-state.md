---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Reconcile stale `useAgentChat` server-streaming state after an errored client reconnects.

Reconnect probes now include correlation IDs, and `STREAM_RESUME_NONE` distinguishes globally idle agents from active continuations owned by another connection. The hook clears fallback streaming state only for a correlated idle response. Reconnect opens are retained while a prior resume or status transition settles, in-flight handshakes are retransmitted on replacement sockets, and all AI SDK resume entry points share one serialization gate.
