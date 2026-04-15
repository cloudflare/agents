---
"@cloudflare/ai-chat": patch
"hono-agents": patch
"@cloudflare/voice": patch
---

Fix peer dependency ranges for `agents` — published packages incorrectly had tight `^0.10.x` ranges instead of the intended `>=0.8.7 <1.0.0` / `>=0.9.0 <1.0.0`, causing install warnings with `agents@0.11.0`. Also changed `updateInternalDependencies` from `"patch"` to `"minor"` in changesets config to prevent the ranges from being overwritten on future releases.
