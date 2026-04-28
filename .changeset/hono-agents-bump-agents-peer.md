---
"hono-agents": patch
---

Tighten the `agents` peer dependency floor from `>=0.9.0` to `>=0.11.7` to reflect the current monorepo set we actually test against. Upper bound (`<1.0.0`) is unchanged. The corresponding `agents` devDependency is also bumped from `^0.11.0` to `^0.11.7` so dev and peer floors line up.

No runtime change in `hono-agents` itself. The visible effect for consumers: pairing the latest `hono-agents` with a stale `agents` (`<0.11.7`) now produces a peer warning where it previously did not. That's the intended signal — `agents` versions older than 0.11.7 are no longer tested against this `hono-agents`.
