---
"@cloudflare/ai-chat": patch
"agents": patch
---

Fix chat recovery and resume races: stop now ends a running recovery, recovery yields to a newer question, and a stale resume ACK keeps the tab waiting for the active stream's replay.
