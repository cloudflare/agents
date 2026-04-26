---
"agents": minor
---

Migrate facet (sub-agent) bootstrap to the documented Cloudflare facet API: pass `id: parentNs.idFromName(name)` to `ctx.facets.get()` so the facet has its own `ctx.id.name`. Drops the `__ps_name` storage write and `setName()` bootstrap from `_cf_initAsFacet`.

**Why this matters.** Facets spawned without an explicit `id` inherit the parent DO's `ctx.id`, so on a facet `ctx.id.name` was the *parent's* name and `this.name` silently misreported as the parent's name. Anything that read `this.name` from inside a sub-agent (including `selfPath`, `parentPath`, and any user code) was getting the wrong value. With the explicit `id` passed at facet creation time, the runtime gives the facet a real `ctx.id.name === name` and PartyServer's existing 0.5.x `name` getter resolves `this.name` correctly without any override mechanism, storage write, or cold-wake hydrate cost. Cold-wake recovery happens for free because `idFromName` is deterministic and the factory re-runs on resume.

This requires `partyserver` ≥ 0.5.3 (bumped in this release); 0.5.3 is byte-identical to 0.5.2 at runtime, only adds documentation and test coverage of the explicit-`id` facet pattern.

Other changes:

- **New error path.** If `subAgent()` is called from a parent class that isn't bound as a Durable Object namespace, the framework now throws a descriptive error pointing at `wrangler.jsonc`. If `this.constructor.name` looks minified (e.g. `_a`), the message includes a bundler-config hint about preserving class names.
- **Defensive runtime check.** `_cf_initAsFacet` now asserts `this.name === name` so any future bug in the parent's id construction surfaces immediately instead of silently mis-identifying the facet.
- **`alarm()` docstring** clarified to reflect the new resolution path (`this.name` from `ctx.id.name`, not from a storage hydrate).
- **MCP test cleanup.** Vestigial `setName("default")` + explicit `onStart()` call pairs in `oauth2-mcp-client`, `wait-connections-e2e`, and `create-oauth-provider` test files have been removed; they were originally needed for partyserver 0.4.x bootstrap but became actual `ctx.id.name` mismatches under partyserver 0.5.x.

Backward-compatible for all public APIs: `subAgent()`, `parentAgent()`, `hasSubAgent()`, `listSubAgents()`, `deleteSubAgent()`, and `abortSubAgent()` keep their signatures and semantics. The change is purely in the facet bootstrap internals; the user-facing effect is that `this.name` inside a sub-agent now correctly reports the sub-agent's own name (was previously the parent's name when run against partyserver 0.5.x).

See cloudflare/partykit#386 for the partyserver-side documentation companion.
