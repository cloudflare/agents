---
"@cloudflare/ai-chat": patch
---

Tighten the `agents` peer dependency floor from `>=0.8.7` to `>=0.11.7` to reflect the current monorepo set we actually test against. Upper bound (`<1.0.0`) is unchanged.

No runtime change in `@cloudflare/ai-chat` itself. The visible effect for consumers: pairing the latest `@cloudflare/ai-chat` with a stale `agents` (`<0.11.7`) now produces a peer warning where it previously did not. That's the intended signal — `agents` versions older than 0.11.7 are no longer tested against this `@cloudflare/ai-chat`.
