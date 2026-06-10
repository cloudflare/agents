---
"@cloudflare/codemode": minor
---

Add the connector model and a durable runtime for codemode.

**Connectors** — class-based integrations that bridge external services into the sandbox. A connector is three things: `name()`, optional `instructions()`, and `tools()` — one record, one entry per tool, with each tool carrying its own description, schema, `requiresApproval`, `execute`, and optional `revert`:

- `CodemodeConnector` — abstract base; author `tools()` directly (AI SDK toolsets are shape-compatible and can be returned as-is). Its constructor accepts a `DurableObjectState` or an `ExecutionContext`, so you pass `this.ctx` from inside an Agent/DO with no cast.
- `McpConnector` — derives `tools()` from an MCP connection (`createConnection()`); decorate derived tools via the `tool(name, t)` hook
- `OpenApiConnector` — derives one typed tool **per operation** from the spec (host-side, zero prompt tokens), so the model calls `api.get_repository({ owner, repo })` directly; `request()` remains as a low-level escape hatch. Derivation resolves local `$ref`s (including `allOf`/`oneOf`/`anyOf`) and is memoized by spec identity, so a static spec is parsed once even though connectors are reconstructed per message; operations whose names collide (or hit the reserved `request`/`spec`) are skipped with a warning

**Runtime** — `CodemodeRuntime`, a DurableObject facet that wraps an `Executor` and makes execution durable via abort-and-replay:

- Every tool call and `codemode.step(name, fn)` is recorded in a durable log
- Reads and steps execute and record their result
- Approval-required actions pause the run (abort)
- The facet is **stateless across calls** — execution id + a host-allocated sequence + the approval requirement are threaded into every call, so runs are safe across hibernation and can run concurrently without clobbering one another
- Once a run pauses or terminates, the facet **refuses further progress**: every subsequent call/step gets a pause decision and records nothing, so model code that catches the pause sentinel and keeps going can't drive extra side effects
- A decided-but-not-yet-recorded call is logged as `executing` (not `applied`), so a crash between deciding and recording the result **re-executes on replay** instead of replaying `undefined`
- **Replay divergence** (a call's connector/method or its arguments differ from the recorded run, e.g. nondeterminism not wrapped in `codemode.step`) is detected and recorded as a failed execution
- Execution outcomes are **returned, not thrown**: the tool yields `{ status: "completed" | "paused" | "error" }` so a sandbox error or divergence is an observable tool result rather than an exception that breaks the agent loop
- Lifecycle calls target an **explicit `executionId`** — there is no implicit "current run" (a single shared pointer would be racy with concurrent runs). Every tool outcome (`completed`/`paused`/`error`) carries `executionId`, and `pending()`/`executions()` surface ids for approval UIs
- `runtime.pending()` lists actions awaiting approval, for approval UIs — with no `executionId` it **aggregates across all paused runs** (not just the most recent); `runtime.executions()` lists all runs (the audit trail)
- `runtime.approve({ executionId })` replays the log and runs the approved action; `runtime.reject({ seq, executionId })` ends the execution (it does **not** auto-undo already-applied actions — call `rollback()` for that)
- `runtime.rollback({ executionId })` reverts **all** applied, reversible actions (any tool with a `revert`, not just approval-gated ones) in reverse order, marking only those actually reverted; it attempts every revert even if one fails (surfacing the failures afterward) and marks the execution `rolled_back`
- **Retention** — terminal executions are auto-pruned to `maxExecutions` (default 50) as new runs begin; `runtime.deleteExecution(id)` and `runtime.pruneExecutions(keep)` are explicit controls. Running/paused executions are never pruned.
- `codemode.step(name, fn)` is the explicit side-effect boundary — wrap any nondeterministic or side-effectful work so it runs once and replays thereafter
- The runtime facet's identity is **derived from the connector set** — changing connectors yields a fresh runtime, so stored snippets and paused executions are always bound to the connectors that can run them

**Snippets** — durable, addressable saved scripts that replace the old static skills. The model writes and runs scripts; the developer promotes the good ones with `runtime.saveSnippet(name, { executionId?, description })` and the model re-runs them with `codemode.run(name, input)`. Snippets live on the runtime, surface in `codemode.search`/`describe`, and are structurally bound to the connector set (no per-snippet dependency tracking).

**Runtime-facing tool** — `createCodemodeRuntime({ ctx, executor, connectors }).tool()` returns one `{ code }` tool. Inside the sandbox: `codemode.search/describe/step/run` plus `<connector>.<method>(...)` globals — a deliberately minimal surface: discover, learn, do-once, reuse.

`ResolvedProvider` gains an optional `prelude` — sandbox-side JS that can define real in-sandbox functions on a namespace (used to implement `codemode.step`, which wraps a local closure that can't cross the RPC boundary).

**Vite plugin** — `@cloudflare/codemode/vite` discovers `*.codemode.ts` files and auto-exports connector classes for `ctx.exports` access.

Executor-style ranked search with normalized tokenization and scoring.
