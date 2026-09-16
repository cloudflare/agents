---
"@cloudflare/think": patch
---

Preserve running durable submissions during startup when either a retry or continuation chat-recovery callback is still pending. This applies to both current Tasks recovery attempts and legacy scheduled callbacks, allowing interrupted empty streams to retry and complete after a restart instead of being marked as errors.
