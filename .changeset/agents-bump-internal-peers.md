---
"agents": patch
---

Tighten internal peer dependency floors to reflect the current monorepo set we actually test against: `@cloudflare/ai-chat` (`>=0.0.8` → `>=0.5.2`) and `@cloudflare/codemode` (`>=0.0.7` → `>=0.3.4`). Upper bound (`<1.0.0`) is unchanged.

No runtime change in `agents` itself. The visible effect for consumers: pairing the latest `agents` with a stale `@cloudflare/ai-chat` (`<0.5.2`) or `@cloudflare/codemode` (`<0.3.4`) now produces a peer warning where it previously did not. That's the intended signal — those older combinations are no longer tested in the monorepo.
