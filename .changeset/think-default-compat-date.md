---
"@cloudflare/think": patch
---

Bump the default `compatibility_date` used when generating a Think app's Worker
config (`createThinkWorkerConfig`) from `2026-01-28` to `2026-06-11`. Apps that
set `compatibility_date` in their own `wrangler.jsonc` are unaffected; this only
changes the fallback used when none is specified.
