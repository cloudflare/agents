---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

A stop of a request whose turn is being recovered now always ends that request for the tabs with `aborted`, also when the stop lands during the recovery's backoff or before the recovered turn streams.
