---
"@cloudflare/think": patch
---

Avoid throwing when the chat stream resume ACK fallback races with a closed WebSocket connection. The `_handleStreamResumeAck` fallback that fires when `ResumableStream.replayCompletedChunksByRequestId` returns `false` now goes through a `sendIfOpen` helper that swallows the `TypeError: WebSocket send() after close` race instead of letting it propagate up through `onMessage`.
