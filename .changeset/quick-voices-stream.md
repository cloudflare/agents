---
"@cloudflare/voice": patch
---

Fix `withVoice` handling for AI SDK `streamText().textStream` responses by preferring their explicit async-iterator text deltas before generic `ReadableStream` parsing.
