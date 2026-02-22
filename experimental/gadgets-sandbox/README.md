# Sandbox — Dynamic Code Execution with Worker Loader

An AI agent that writes JavaScript code and runs it in a **sandboxed dynamic Worker isolate**. The isolate has no internet access — its only connection to the outside world is a database binding that goes through a facet.

This is the same pattern used in the [Gadgets architecture](../gadgets.md) for running user-written Gadget code.

## How It Works

```
  SandboxAgent (parent DO)
    │
    ├── executeCode tool
    │     │
    │     └── env.LOADER.get(id, () => ({
    │           mainModule: "harness.js",
    │           modules: { "harness.js": ..., "user-code.js": agentCode },
    │           env: { db: DatabaseLoopback },    ← only binding
    │           globalOutbound: null,              ← no fetch()
    │           tails: [TailLoopback]              ← capture console.log
    │         }))
    │
    ├── DatabaseLoopback (WorkerEntrypoint)
    │     └── proxies env.db calls back to the facet
    │
    ├── TailLoopback (WorkerEntrypoint)
    │     └── captures console output, delivers to parent
    │
    └── CustomerDatabase (facet — own isolated SQLite)
          └── query() / execute() / getAllCustomers()
```

Three layers of isolation:

1. **Dynamic isolate** — the code runs in a Worker with `globalOutbound: null`. No `fetch()`, no `connect()`.
2. **Restricted env** — the only binding is `env.db`, a DatabaseLoopback that proxies to the facet.
3. **Facet storage** — the database is a child DO whose SQLite the parent can't access directly.

## Interesting Files

### `src/server.ts`

- **`CustomerDatabase`** — plain DurableObject facet. Same as the gatekeeper example.
- **`DatabaseLoopback`** — WorkerEntrypoint with `ctx.props` containing the parent's ID. When the isolate calls `env.db.query(sql)`, it goes: isolate → DatabaseLoopback → SandboxAgent.proxyDbQuery() → facet. This indirection exists because dynamic isolates can hold ServiceStubs but not facet stubs directly.
- **`TailLoopback`** — receives Tail events (console.log output) from the dynamic isolate and delivers them to the parent via `deliverTrace()`.
- **`CODE_HARNESS`** — the wrapper module that imports the agent-written code and exposes `verify()` + `run()` entrypoints.
- **`_executeCode()`** — the core method. Builds the dynamic isolate via `env.LOADER.get()`, wires up the loopbacks, runs the code, waits for trace events.
- **`proxyDbQuery()` / `proxyDbExecute()` / `proxyDbGetAll()`** — methods on the agent that DatabaseLoopback calls. These forward to the facet.

### `wrangler.jsonc`

- `"worker_loaders": [{ "binding": "LOADER" }]` — the Worker Loader binding
- `"experimental"` compat flag — enables facets, exports, and worker loaders
- Only `SandboxAgent` in DO bindings — CustomerDatabase, DatabaseLoopback, and TailLoopback are internal

## Quick Start

```bash
npm start
```

## Try It

1. "Count customers by tier" → agent writes code, runs in sandbox, shows output
2. "Find customers with emails containing 'example'" → agent queries via env.db
3. "Add a new customer named Zara" → agent calls env.db.execute() from sandbox
4. Check the **Executions** tab to see code + captured output
5. Check the **Customers** tab to see the database state

## Pattern

This follows the Gadgets code execution pattern (see [gadgets.md](../gadgets.md)):

- `env.LOADER.get()` with modules, restricted env, null globalOutbound
- `WorkerEntrypoint` harness with `verify()` + `run()`
- `DatabaseLoopback` for proxying RPC from the isolate back to the facet
- `TailLoopback` for capturing console output via Tail API
