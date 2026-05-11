---
"@cloudflare/think": patch
---

Avoid throwing when chat stream resume negotiation/replay races with a closed WebSocket connection. Resume protocol sends and the `_handleStreamResumeAck` fallback now go through `sendIfOpen` helpers that swallow the `TypeError: WebSocket send() after close` race instead of letting it propagate up through `onMessage`.
