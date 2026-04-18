---
"agents": patch
"@cloudflare/think": patch
---

Fix `subAgent()` cross-DO I/O errors on first use and drop the `"experimental"` compatibility flag requirement.

### `subAgent()` cross-DO I/O fix

Three issues in the facet initialization path caused `"Cannot perform I/O on behalf of a different Durable Object"` errors when spawning sub-agents in production:

- `subAgent()` constructed a `Request` in the parent DO and passed it to the child via `stub.fetch()`. The `Request` carried native I/O tied to the parent isolate, which the child rejected.
- The facet flag was set _after_ the first `onStart()` ran, so `broadcastMcpServers()` fired with `_isFacet === false` on the initial boot.
- `_broadcastProtocol()`, the inherited `broadcast()`, and `_workflow_broadcast()` iterated the connection registry without an `_isFacet` guard, letting broadcasts reach into the parent DO's WebSocket registry from a child isolate.

Replaces the fetch-based handshake with a new `_cf_initAsFacet(name)` RPC that runs entirely in the child isolate, sets `_isFacet` before init, and seeds partyserver's `__ps_name` key directly. Adds `_isFacet` guards to `_broadcastProtocol()` and overrides `broadcast()` to no-op on facets so downstream callers (chat-streaming paths, workflow broadcasts, user `this.broadcast(...)`) are covered. `_cf_markAsFacet()` is kept for back-compat and now marked `@deprecated`.

### `"experimental"` compatibility flag no longer required

`ctx.facets`, `ctx.exports`, and `env.LOADER` (Worker Loader) have graduated out of the `"experimental"` compatibility flag in workerd. `agents` and `@cloudflare/think` no longer require it:

- `subAgent()` / `abortSubAgent()` / `deleteSubAgent()` — the `@experimental` JSDoc tag and runtime error messages no longer reference the flag. The runtime guards on `ctx.facets` / `ctx.exports` stay in place and now nudge users toward updating `compatibility_date` instead.
- `Think` — the `@experimental` JSDoc tag no longer references the flag.

No code change is required; remove `"experimental"` from your `compatibility_flags` in `wrangler.jsonc` if it was only there for these features.
