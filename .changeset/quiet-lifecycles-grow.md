---
"agents": minor
---

Vendor the required PartyServer runtime into `agents/lifecycle` and add a reusable Durable Object lifecycle for startup, request interception, alarms, and WebSockets. `Agent` now directly extends Cloudflare's `DurableObject` and composes the same lifecycle used by standalone objects; standalone hosts use the explicit `Lifecycle.install(this)` factory (or the expanded `new ...` plus `installHandlers()` form).

Lifecycle WebSockets always use Cloudflare's Hibernation API; the `static options.hibernate` switch and in-memory connection mode are removed. Named Durable Objects use native `ctx.id.name`, while a read-only `__ps_name` fallback migrates objects created by older releases without writing new compatibility state.
