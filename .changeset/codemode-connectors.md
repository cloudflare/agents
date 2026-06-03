---
"@cloudflare/codemode": minor
---

Add the connector model and a durable runtime for codemode.

**Connectors** — class-based integrations that bridge external services into the sandbox:

- `CodemodeConnector` — abstract base (`name()`, `instructions()`, `annotations()`, `loadDescriptors()`, `executeTool()`, optional `revertAction()`)
- `McpConnector` — MCP-backed, `createConnection()`
- `OpenApiConnector` — OpenAPI spec, `spec()` + `request()`
- `ToolsetConnector` — wraps AI SDK toolsets

**Runtime** — `CodemodeRuntime`, a DurableObject facet that wraps an `Executor` and makes execution durable via abort-and-replay:

- Every tool call and `codemode.step(name, fn)` is recorded in a durable log
- Observations and steps execute and record their result
- Approval-required actions pause the run (abort)
- `resumeCodemode()` replays the log and runs the approved action
- `rollbackCodemode()` reverts applied actions via `revertAction`
- `forkCodemode()` snapshots an execution into an independent branch (checkpoint / hand-off)
- `codemode.step(name, fn)` is the explicit side-effect boundary — wrap any nondeterministic or side-effectful work so it runs once and replays thereafter
- `codemode.get/set` persist per-execution scratchpad state across runs
- The runtime facet's identity is **derived from the connector set** — changing connectors yields a fresh runtime, so stored snippets and paused executions are always bound to the connectors that can run them

**Snippets** — durable, addressable saved scripts that replace the old static skills. The model writes a script, then promotes it with `codemode.save(name, { description })` and re-runs it with `codemode.run(name, input)`. Snippets live on the runtime, surface in `codemode.search`/`describe`/`snippets()`, and are structurally bound to the connector set (no per-snippet dependency tracking).

**Model-facing tool** — `createProxyTool({ ctx, executor, connectors })` returns one `{ code }` tool. Inside the sandbox: `codemode.search/describe/connectors/pending/run/save/snippets/step/fork/get/set` plus `<connector>.<method>(...)` globals.

`ResolvedProvider` gains an optional `prelude` — sandbox-side JS that can define real in-sandbox functions on a namespace (used to implement `codemode.step`, which wraps a local closure that can't cross the RPC boundary).

**Vite plugin** — `@cloudflare/codemode/vite` discovers `*.codemode.ts` files and auto-exports connector classes for `ctx.exports` access.

Executor-style ranked search with normalized tokenization and scoring.
