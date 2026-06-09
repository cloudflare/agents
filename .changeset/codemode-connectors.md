---
"@cloudflare/codemode": minor
---

Add the connector model and a durable runtime for codemode.

**Connectors** — class-based integrations that bridge external services into the sandbox. A connector is three things: `name()`, optional `instructions()`, and `tools()` — one record, one entry per tool, with each tool carrying its own description, schema, `requiresApproval`, `execute`, and optional `revert`:

- `CodemodeConnector` — abstract base; author `tools()` directly (AI SDK toolsets are shape-compatible and can be returned as-is)
- `McpConnector` — derives `tools()` from an MCP connection (`createConnection()`); decorate derived tools via the `tool(name, t)` hook
- `OpenApiConnector` — two tools, `spec()` + `request()`; the model reads the spec and writes its own lookup

**Runtime** — `CodemodeRuntime`, a DurableObject facet that wraps an `Executor` and makes execution durable via abort-and-replay:

- Every tool call and `codemode.step(name, fn)` is recorded in a durable log
- Reads and steps execute and record their result
- Approval-required actions pause the run (abort)
- `runtime.pending()` lists actions awaiting approval, for approval UIs; `runtime.executions()` lists all runs (the audit trail)
- `runtime.approve()` replays the log and runs the approved action; `runtime.reject({ seq })` ends the execution
- `runtime.rollback()` reverts applied actions via `revertAction`
- `codemode.step(name, fn)` is the explicit side-effect boundary — wrap any nondeterministic or side-effectful work so it runs once and replays thereafter
- The runtime facet's identity is **derived from the connector set** — changing connectors yields a fresh runtime, so stored snippets and paused executions are always bound to the connectors that can run them

**Snippets** — durable, addressable saved scripts that replace the old static skills. The model writes and runs scripts; the developer promotes the good ones with `runtime.saveSnippet(name, { executionId?, description })` and the model re-runs them with `codemode.run(name, input)`. Snippets live on the runtime, surface in `codemode.search`/`describe`, and are structurally bound to the connector set (no per-snippet dependency tracking).

**Runtime-facing tool** — `createCodemodeRuntime({ ctx, executor, connectors }).tool()` returns one `{ code }` tool. Inside the sandbox: `codemode.search/describe/step/run` plus `<connector>.<method>(...)` globals — a deliberately minimal surface: discover, learn, do-once, reuse.

`ResolvedProvider` gains an optional `prelude` — sandbox-side JS that can define real in-sandbox functions on a namespace (used to implement `codemode.step`, which wraps a local closure that can't cross the RPC boundary).

**Vite plugin** — `@cloudflare/codemode/vite` discovers `*.codemode.ts` files and auto-exports connector classes for `ctx.exports` access.

Executor-style ranked search with normalized tokenization and scoring.
