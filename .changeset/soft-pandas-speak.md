---
"@cloudflare/voice": patch
---

Fix `withVoice` text streaming for AI SDK `textStream` responses so TTS audio is produced when `onTurn()` returns `streamText(...).textStream` directly.
