---
"@cloudflare/voice": patch
---

Fix Workers AI STT session edge cases for Flux and Nova 3.

Flux now preserves the latest non-empty interim transcript for the active turn so an `EndOfTurn` event with an empty `transcript` can still emit the completed utterance. Nova 3 now defensively normalizes finalized segment state before reading it to avoid stale teardown messages throwing during abnormal close paths.
