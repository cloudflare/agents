---
"agents": minor
---

Introduce the Layer-0 host capability seam (`src/core/host.ts`) from the modular-architecture RFC. `Agent` now implements the `AgentHost` interface — the narrow, platform-shaped contract (durable fibers, named timers, key-value storage, migrations, events, diagnostics) that higher layers build on, specified so SQL-backed implementations are polyfills the Durable Object platform could absorb later.

New public APIs on `Agent`:

- `registerMigrations(namespace, migrations)` — namespaced, run-once schema migrations recorded in a `cf_agents_host_migrations` ledger.
- `kv` — a `KvHost` (`get`/`put`/`delete`/`list`) over Durable Object storage.
- `setTimer(key, at, payload?)` / `cancelTimer(key)` / `onTimer(prefix, handler)` — named durable timers multiplexed onto the single DO alarm, with longest-prefix handler routing. Handler re-arms of their own key survive the post-fire delete; unhandled due timers are dropped with a warning.
- `onRecovery(namespace, handler)` — a namespaced fiber-recovery registry consulted before the `onFiberRecovered` fallback, so independent modules can each own recovery for their fiber namespace without monkey-patching a single hook. Longest-prefix match wins; duplicate namespace registration throws.
- `emitEvent(event)` — structured host event emission into the observability stream.
- `registerInspector(key, fn)` / `diagnostics(options?)` — per-object forensics: a `DiagnosticBundle` aggregating host views (timers, fibers) and registered inspectors, scrubbed of payloads by default.
- `InterruptionReason` — structured classification of fiber interruptions, replacing string-matching of platform error messages. Fiber types (`FiberContext`, `FiberStatus`, `FiberRecoveryContext`, etc.) move to `core/host.ts` and are re-exported from `agents` unchanged.

Behavior change: fiber recovery dispatch now checks the `onRecovery` registry first, then internal handlers, then `onFiberRecovered`. Agents that do not call `onRecovery` are unaffected.

Internally, `Agent`'s subsystems (queue, email, workflows, scheduler, MCP server glue, synced state, agent tools, fibers, sub-agents/facets) are extracted from the single 11.6k-line `index.ts` into capability modules under `src/capabilities/`, each depending only on a narrow host slice; `Agent` keeps its exact public API via thin delegators. Pure code motion — no behavior or SQL changes.
