---
"@cloudflare/think": patch
---

Expose stable AI SDK `streamText` call settings on Think `TurnConfig`, including `timeout` and `maxRetries`, so `beforeTurn` can tune generation behavior per turn.
