---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Raise the `agents` peer dependency floor to `>=0.25.0`.

Both packages now import helpers from `agents/chat` that first ship in `agents@0.25.0` — `isDurableObjectResetError`, `retryAfterSeconds`, and `isLateToolInputChunk`. The previous peer floors (`@cloudflare/think` at `>=0.24.0`, `@cloudflare/ai-chat` at `>=0.23.0`) allowed installing these releases against an `agents` version that does not export those helpers, which fails at runtime. Requiring `>=0.25.0` keeps the published package combinations compatible.
