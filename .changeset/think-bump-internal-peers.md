---
"@cloudflare/think": patch
---

Tighten internal peer dependency floors to reflect the current monorepo set we actually test against: `agents` (`>=0.8.7` → `>=0.11.7`), `@cloudflare/codemode` (`>=0.0.7` → `>=0.3.4`), and `@cloudflare/shell` (`>=0.2.0` → `>=0.3.4`). Upper bounds (`<1.0.0`) are unchanged.

No runtime change in `@cloudflare/think` itself. The visible effect for consumers: pairing the latest `@cloudflare/think` with a stale `agents` (`<0.11.7`), `@cloudflare/codemode` (`<0.3.4`), or `@cloudflare/shell` (`<0.3.4`) now produces a peer warning where it previously did not. That's the intended signal — those older combinations are no longer tested in the monorepo.
