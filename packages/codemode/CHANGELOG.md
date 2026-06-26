# @cloudflare/codemode

## 0.4.2

### Patch Changes

- [#1807](https://github.com/cloudflare/agents/pull/1807) [`7eea2fb`](https://github.com/cloudflare/agents/commit/7eea2fb9e0f278b227b5f419b847e6882d3ef9b1) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Cleanup connector imports so connector modules are imported normally and the Vite plugin only auto-exports the CodemodeRuntime facet class. Codemode now fails loudly when the runtime facet class is not exported from the Worker entry.

- [#1814](https://github.com/cloudflare/agents/pull/1814) [`a79144d`](https://github.com/cloudflare/agents/commit/a79144d7b47efc85afa3665dc68f4b5ab8a9aad4) Thanks [@threepointone](https://github.com/threepointone)! - Dispose the dynamically-loaded Worker and its RPC entrypoint stub after each
  `DynamicWorkerExecutor.execute()` run.

  Each execution spins up a child Worker via `loader.load()` and obtains an RPC
  `Fetcher` stub via `getEntrypoint()`. These own native handles, and the code
  previously left them for the garbage collector. When such a handle is finalized
  late — for example during isolate shutdown under
  `@cloudflare/vitest-pool-workers` — workerd raises a fatal assertion ("tried to
  defer destruction during isolate shutdown") that kills the worker, surfacing as
  a flaky "Worker exited unexpectedly" with no failing assertion. The milder
  manifestation is workerd's "An RPC result was not disposed properly" warning.

  The executor now disposes the entrypoint stub and the loaded worker in `finally`
  blocks (best-effort, via `Symbol.dispose`), releasing the handles while the
  isolate is still alive. No behavior or API change for callers.

- [#1793](https://github.com/cloudflare/agents/pull/1793) [`247ebeb`](https://github.com/cloudflare/agents/commit/247ebeb1fe34bd3b07a03530485e4597592e5ecc) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Pass the outer MCP tool-call context to `openApiMcpServer` request callbacks so server-to-client requests and notifications can be associated with the originating response stream.

- [#1791](https://github.com/cloudflare/agents/pull/1791) [`9c85369`](https://github.com/cloudflare/agents/commit/9c85369a3f8bcfc0a2c4c3a559623cb5943c5fdd) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Remove the root entry's runtime dependency on the optional `ai` and `zod` peers. Executor and runtime imports now bundle without either framework package installed.

- [#1772](https://github.com/cloudflare/agents/pull/1772) [`d4f27fe`](https://github.com/cloudflare/agents/commit/d4f27fededefebc17cf455218e952ff76ade847b) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Include each package's documentation in its published package.

- [#1806](https://github.com/cloudflare/agents/pull/1806) [`43f663d`](https://github.com/cloudflare/agents/commit/43f663d2245fc5c74d0c41d0ada0d7b7da700c12) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Increase the default DynamicWorkerExecutor timeout from 30 seconds to 60 seconds to better support longer-running codemode executions.

## 0.4.1

### Patch Changes

- [#1760](https://github.com/cloudflare/agents/pull/1760) [`6769830`](https://github.com/cloudflare/agents/commit/676983019be59cc96e2faaca6f1551a0cb3caa08) Thanks [@cjol](https://github.com/cjol)! - Fix the runtime tool description to say "Execute JavaScript" instead of "Execute TypeScript". The codemode sandbox executes JavaScript only; TypeScript types are generated for LLM context but are not executed.

## 0.4.0

### Minor Changes

- [#1581](https://github.com/cloudflare/agents/pull/1581) [`b2b6762`](https://github.com/cloudflare/agents/commit/b2b67623deab327042b99344d8ee530ae37a71b2) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Add the connector model and a durable runtime for codemode.

  **Connectors** — class-based integrations that bridge external services into the sandbox. A connector is three things: `name()`, optional `instructions()`, and `tools()` — one record, one entry per tool, with each tool carrying its own description, schema, `requiresApproval`, `execute`, and optional `revert`:
  - `CodemodeConnector` — abstract base; author `tools()` directly (AI SDK toolsets are shape-compatible and can be returned as-is). Its constructor accepts a `DurableObjectState` or an `ExecutionContext`, so you pass `this.ctx` from inside an Agent/DO with no cast.
  - `McpConnector` — derives `tools()` from an MCP connection (`createConnection()`); decorate derived tools via the `tool(name, t)` hook
  - **Per-execution resources** — a tool's `execute(args, ctx)`/`revert(args, result, ctx)` now receive the run's `executionId` (stable across pause/resume), and connectors can override `disposeExecution(executionId, status)` to tear down a resource scoped to one run (a browser/CDP session, a transaction). It fires on each terminal transition (`completed`/`error`/`rejected`/`rolled_back`) and **never on pause**, so a resource survives an approval pause and is released when the run truly ends. Must be idempotent (a completed-then-rolled-back run disposes twice). A stale/no-op `reject` no longer triggers teardown, so a still-resumable run keeps its resources
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
  - `runtime.approve({ executionId })` replays the log and runs the approved action; it only resumes a **paused** run — approving a run that already completed, was rejected, or rolled back (a stale/racing approval UI) is a safe no-op that revives nothing (returning an error outcome) rather than re-offering a rejected action or re-applying rolled-back effects. `runtime.reject({ seq, executionId })` ends the execution with a first-class `rejected` status (it does **not** auto-undo already-applied actions — call `rollback()` for that)
  - `runtime.rollback({ executionId })` reverts **all** applied, reversible actions (any tool with a `revert`, not just approval-gated ones) in reverse order, marking only those actually reverted; it attempts every revert even if one fails (surfacing the failures afterward) and marks the execution `rolled_back`
  - **Retention** — terminal executions are auto-pruned to `maxExecutions` (default 50) as new runs begin; `runtime.deleteExecution(id)` and `runtime.pruneExecutions(keep)` are explicit controls. Running/paused executions are never pruned.
  - `codemode.step(name, fn)` is the explicit side-effect boundary — wrap any nondeterministic or side-effectful work so it runs once and replays thereafter
  - The runtime facet's identity is **derived from the connector set** — changing connectors yields a fresh runtime, so stored snippets and paused executions are always bound to the connectors that can run them

  **Snippets** — durable, addressable saved scripts that replace the old static skills. The model writes and runs scripts; the developer promotes the good ones with `runtime.saveSnippet(name, { executionId?, description })` and the model re-runs them with `codemode.run(name, input)`. Snippets live on the runtime, surface in `codemode.search`/`describe`, and are structurally bound to the connector set (no per-snippet dependency tracking).

  **Runtime-facing tool** — `createCodemodeRuntime({ ctx, executor, connectors }).tool()` returns one `{ code }` tool. Inside the sandbox: `codemode.search/describe/step/run` plus `<connector>.<method>(...)` globals — a deliberately minimal surface: discover, learn, do-once, reuse.

  **Result shaping** — `createCodemodeRuntime` accepts an optional `transformResult` that reshapes the **model-facing** result of a completed run (initial run and resume), after the raw value is recorded — so the audit trail keeps the full result while the model sees the shaped one. Exported `truncateResult`/`truncateResponse` (with `{ maxChars?, maxTokens? }`) are the default building blocks: structured results pass through unchanged until oversized, then serialize to a bounded, marked string.

  `ResolvedProvider` gains an optional `prelude` — sandbox-side JS that can define real in-sandbox functions on a namespace (used to implement `codemode.step`, which wraps a local closure that can't cross the RPC boundary). New exported types `ToolExecuteContext` and `ExecutionEndStatus` describe the per-execution resource contract.

  **Vite plugin** — `@cloudflare/codemode/vite` discovers `*.codemode.ts` files and auto-exports connector classes for `ctx.exports` access.

  Executor-style ranked search with normalized tokenization and scoring.

- [#1656](https://github.com/cloudflare/agents/pull/1656) [`4c2d1a7`](https://github.com/cloudflare/agents/commit/4c2d1a7f7f337bf426b0b35e3c9e8e4901c6360b) Thanks [@cjol](https://github.com/cjol)! - Codemode runtime refinements (pre-release):
  - **SQL storage.** The `CodemodeRuntime` facet now stores executions, the tool-call log, and snippets in SQLite tables (one row per log entry) instead of single key-value blobs — appends no longer rewrite the whole execution, and pruning/expiry/listing are indexed. Args/results are serialized with a binary- and bigint-safe codec.
  - **Size guards.** Any single recorded value (call args, a recorded result, the final result) is capped at 1 MB serialized (`MAX_DURABLE_VALUE_BYTES`). Oversized args or call results fail the run with a model-actionable error; an oversized final result completes normally with a placeholder in the audit trail.
  - **Replay policy.** Connector tools can declare `replay: "reexecute"`: the call is logged for sequencing/divergence but its result is never stored — replays re-execute it. For idempotent reads with large results. Incompatible with `requiresApproval`.
  - **`onPassEnd` hook.** Connectors get `onPassEnd(executionId, status)` at the end of every execution pass — including pauses, where `disposeExecution` deliberately does not fire — to release per-pass resources (sockets, leases).
  - **Explicit runtime identity.** The runtime facet is keyed by an explicit `name` (default `"default"`) instead of a fingerprint of the connector set, so executions and snippets survive connector changes. Each execution/snippet records the connector names it needs; resume and `codemode.run` verify them and fail with a clear error when one is missing.
  - **`expirePaused`.** `runtime.expirePaused({ maxAgeMs })` (default 24h) expires stale non-terminal runs and fires `disposeExecution`, reclaiming their resources — for use from a recurring alarm/scheduled task. Paused (awaiting-approval) runs are marked rejected; runs stuck `running` after a host crash are marked errored (they could never be resumed or pruned otherwise).
  - **Lifecycle hardening.** `runtime.reject()` returns whether it actually terminated the run (`false` for a stale/duplicate reject — e.g. the action was approved from another tab) so callers never report a run as rejected when its gated action actually executed. `deleteExecution` on a non-terminal run also disposes its per-execution connector resources. Oversized execution code is rejected up front with a model-actionable error, and snippet schemas are size-checked on save. `createCodemodeRuntime` rejects duplicate connector names (they would silently shadow each other in the sandbox).
  - **Reserved-name hardening.** The executor rejects provider/connector names that would shadow harness globals (`Promise`, `setTimeout`, `Error`, `console`, …).
  - **Anti-hallucination tool description.** The default execute tool description now states explicitly that the connector namespaces plus `codemode` are the only sandbox globals (no `host`, `fs`, `require`, `process`), and tells the model to discover method names via `codemode.search` instead of guessing. `tool({ connectorHints })` renders a one-line usage hint next to each connector in the description. A sandbox `ReferenceError` (`x is not defined`) now gets the list of available globals appended, so the model's retry is informed.

- [#1656](https://github.com/cloudflare/agents/pull/1656) [`4c2d1a7`](https://github.com/cloudflare/agents/commit/4c2d1a7f7f337bf426b0b35e3c9e8e4901c6360b) Thanks [@cjol](https://github.com/cjol)! - Add `ToolSetConnector` — adapt an AI SDK `ToolSet` into a codemode connector.

  `toolSetConnector(ctx, { tools })` (default name `tools`) turns existing AI SDK tools into connector tools for the durable runtime, converting their input schemas to JSON Schema for the sandbox type declarations. Tools with `needsApproval: true` are mapped to `requiresApproval: true` on the connector tool — calling one pauses the execution durably for human approval instead of the tool being unavailable. Tools without an `execute` function (client-side / provider-executed) are excluded from both the bindings and the generated types, with a one-time warning — the sandbox can't call them. The runtime tool's description now also instructs the model to stop and wait when an execution returns `status: "paused"`.

## 0.3.8

### Patch Changes

- [#1555](https://github.com/cloudflare/agents/pull/1555) [`2d45abd`](https://github.com/cloudflare/agents/commit/2d45abdcb6bb0bbe71c135a4b12071a118cd776e) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Default `openApiMcpServer` to the MCP SDK's Workers-safe JSON schema validator so elicitation response validation does not rely on runtime code generation.

## 0.3.7

### Patch Changes

- [#1547](https://github.com/cloudflare/agents/pull/1547) [`f739ec9`](https://github.com/cloudflare/agents/commit/f739ec9cd74c73da6a2d68403ab05f20940e36af) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Dispatch all codemode tool calls positionally and remove provider-level `positionalArgs` configuration.

## 0.3.6

### Patch Changes

- [#1521](https://github.com/cloudflare/agents/pull/1521) [`2911bae`](https://github.com/cloudflare/agents/commit/2911bae6c7a0e331de9cb8471ab877aee2a385d2) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Preserve binary values across codemode tool calls so `Uint8Array` arguments and results survive the sandbox boundary. This fixes `state.writeFileBytes()` from codemode with byte arrays and keeps `readFileBytes()` results as `Uint8Array` values.

- [#1523](https://github.com/cloudflare/agents/pull/1523) [`5f1376f`](https://github.com/cloudflare/agents/commit/5f1376fed1b9ff47dda4b98c5369a4e060ce796d) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Remove the echoed source `code` field from codemode tool results. Successful sandbox executions now return only the execution `result` and any captured `logs`.

## 0.3.5

### Patch Changes

- [#1468](https://github.com/cloudflare/agents/pull/1468) [`186a2a4`](https://github.com/cloudflare/agents/commit/186a2a45700fbd9680b69e8b72ea062fd325d077) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Add a browser-safe codemode export with an iframe sandbox executor and browser
  tool helper. Harden iframe message handling with nonce-scoped messages, reject
  sanitized tool name collisions, and keep tools with `needsApproval: false`.

- [#1470](https://github.com/cloudflare/agents/pull/1470) [`1033fa2`](https://github.com/cloudflare/agents/commit/1033fa28786d1e70a55a0455a6092a4a604be03c) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Resolve OpenAPI specs inside the codemode sandbox to avoid Worker Loader RPC size limits for heavily-referenced specs.

- [#1508](https://github.com/cloudflare/agents/pull/1508) [`13acffe`](https://github.com/cloudflare/agents/commit/13acffee172fcd0d40ecfcd3ba9c5088b474286e) Thanks [@threepointone](https://github.com/threepointone)! - fix(codemode): harden OpenAPI sandbox ref handling

## 0.3.4

### Patch Changes

- [#1266](https://github.com/cloudflare/agents/pull/1266) [`d5dbf45`](https://github.com/cloudflare/agents/commit/d5dbf45e3dfb2d93ca1ece43d2e84cea2cb28d37) Thanks [@threepointone](https://github.com/threepointone)! - Add optional `description` to `codeMcpServer`, matching the existing option on `createCodeTool`. Supports `{{types}}` and `{{example}}` placeholders; falls back to the built-in default when omitted.

- [`c5ca556`](https://github.com/cloudflare/agents/commit/c5ca55618bd79042f566e55d1ebbe0636f91e75a) Thanks [@threepointone](https://github.com/threepointone)! - Fix `@tanstack/ai` peer dependency range from `^0.8.0` to `>=0.8.0 <1.0.0`. The caret range for pre-1.0 packages only allows `>=0.8.0 <0.9.0`, which excluded the current 0.10.0 release.

## 0.3.3

### Patch Changes

- [#1248](https://github.com/cloudflare/agents/pull/1248) [`c74b615`](https://github.com/cloudflare/agents/commit/c74b6158060f49faf0c73f6c84f33b6db92c9ad0) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

## 0.3.2

### Patch Changes

- [#1204](https://github.com/cloudflare/agents/pull/1204) [`39d8d62`](https://github.com/cloudflare/agents/commit/39d8d62d82a3c16ccfc9e70c341eb4e38dd05076) Thanks [@threepointone](https://github.com/threepointone)! - Unwrap MCP content wrappers in `codeMcpServer` so sandbox code sees plain values instead of raw `{ content: [{ type: "text", text }] }` objects. Error responses (`isError`) now throw proper exceptions catchable via try/catch, and `structuredContent` is returned directly when present.

## 0.3.1

### Patch Changes

- [#1181](https://github.com/cloudflare/agents/pull/1181) [`e9bace9`](https://github.com/cloudflare/agents/commit/e9bace967dbf3a79e5d873142f6530ad79c8b456) Thanks [@threepointone](https://github.com/threepointone)! - Fix `createCodeTool` dropping `positionalArgs` from providers, causing multi-argument tool calls (e.g. `stateTools`) to silently lose arguments after the first.

## 0.3.0

### Minor Changes

- [#1138](https://github.com/cloudflare/agents/pull/1138) [`36e2020`](https://github.com/cloudflare/agents/commit/36e2020d41d3d8a83b65b7e45e5af924b09f82ed) Thanks [@threepointone](https://github.com/threepointone)! - Drop Zod v3 from peer dependency range — now requires `zod ^4.0.0`. Replace dynamic `import("ai")` with `z.fromJSONSchema()` from Zod 4 for MCP tool schema conversion, removing the `ai` runtime dependency from the agents core. Remove `ensureJsonSchema()`.

### Patch Changes

- [#1149](https://github.com/cloudflare/agents/pull/1149) [`47ce125`](https://github.com/cloudflare/agents/commit/47ce125e36e3c892fdb702a626af1f62b0a247e7) Thanks [@threepointone](https://github.com/threepointone)! - feat: add TanStack AI integration (`@cloudflare/codemode/tanstack-ai`)

  New entry point for using codemode with TanStack AI's `chat()` instead of the Vercel AI SDK's `streamText()`.

  ```typescript
  import {
    createCodeTool,
    tanstackTools
  } from "@cloudflare/codemode/tanstack-ai";
  import { chat } from "@tanstack/ai";

  const codeTool = createCodeTool({
    tools: [tanstackTools(myServerTools)],
    executor
  });

  const stream = chat({ adapter, tools: [codeTool], messages });
  ```

  **Exports:**
  - `createCodeTool` — returns a TanStack AI `ServerTool` (via `toolDefinition().server()`)
  - `tanstackTools` — converts a `TanStackTool[]` into a `ToolProvider` with pre-generated types
  - `generateTypes` — generates TypeScript type definitions from TanStack AI tools
  - `resolveProvider` — re-exported framework-agnostic provider resolver

  **Internal cleanup:** extracted `resolveProvider` into a framework-agnostic `resolve.ts` module so the main entry (`@cloudflare/codemode`) no longer pulls in the `ai` package at runtime. Shared constants and helpers moved to `shared.ts` to avoid duplication between the AI SDK and TanStack AI entry points.

## 0.2.2

### Patch Changes

- [#1122](https://github.com/cloudflare/agents/pull/1122) [`a16e74d`](https://github.com/cloudflare/agents/commit/a16e74db106a5f498e1710286023f4acfbb322be) Thanks [@threepointone](https://github.com/threepointone)! - Add `ToolProvider` interface for composing tools from multiple sources into a single codemode sandbox. `createCodeTool` now accepts a `ToolProvider[]` alongside raw tool sets. Each provider contributes tools under a named namespace (e.g. `state.*`, `mcp.*`) with the default being `codemode.*`. Providers with `positionalArgs: true` use natural function signatures (`state.readFile("/path")`) instead of single-object args. The old `executor.execute(code, fns)` signature is deprecated but still works with a warning.

## 0.2.1

### Patch Changes

- [#1114](https://github.com/cloudflare/agents/pull/1114) [`5d88b81`](https://github.com/cloudflare/agents/commit/5d88b810cda4edc4f55ea6bc619a376efa9b8f4d) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Add `@cloudflare/codemode/mcp` barrel export with two functions:
  - `codeMcpServer({ server, executor })` — wraps an MCP server with a single `code` tool where each upstream tool becomes a typed `codemode.*` method
  - `openApiMcpServer({ spec, executor, request })` — creates `search` + `execute` MCP tools from an OpenAPI spec with host-side request proxying and automatic `$ref` resolution

- [#1113](https://github.com/cloudflare/agents/pull/1113) [`1264372`](https://github.com/cloudflare/agents/commit/1264372999698d63b81bab79426c6e6f409585d5) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Add optional `modules` option to `DynamicWorkerExecutorOptions` to allow injecting custom ES modules into the sandbox

- [#1117](https://github.com/cloudflare/agents/pull/1117) [`9837adc`](https://github.com/cloudflare/agents/commit/9837adc9267f2508d574fb329786bb51c8c3a61c) Thanks [@mattzcarey](https://github.com/mattzcarey)! - DynamicWorkerExecutor now normalizes code and sanitizes tool names internally. Users no longer need to call `normalizeCode()` or `sanitizeToolName()` before passing code/fns to `execute()`.

## 0.2.0

### Minor Changes

- [#1102](https://github.com/cloudflare/agents/pull/1102) [`f07ef51`](https://github.com/cloudflare/agents/commit/f07ef51e163364570f5fbfa9e5c867b13634c6a7) Thanks [@mattzcarey](https://github.com/mattzcarey)! - **BREAKING:** `generateTypes` and `ToolDescriptor`/`ToolDescriptors` types are no longer exported from the main entry point. Import them from `@cloudflare/codemode/ai` instead:

  ```ts
  // Before
  import { generateTypes } from "@cloudflare/codemode";

  // After
  import { generateTypes } from "@cloudflare/codemode/ai";
  ```

  The main entry point (`@cloudflare/codemode`) no longer requires the `ai` or `zod` peer dependencies. It now exports:
  - `sanitizeToolName` — sanitize tool names into valid JS identifiers
  - `normalizeCode` — normalize LLM-generated code into async arrow functions
  - `generateTypesFromJsonSchema` — generate TypeScript type definitions from plain JSON Schema (no AI SDK needed)
  - `jsonSchemaToType` — convert a JSON Schema to a TypeScript type declaration string
  - `DynamicWorkerExecutor`, `ToolDispatcher` — sandboxed code execution
  - `JsonSchemaToolDescriptor` / `JsonSchemaToolDescriptors` — types for the JSON Schema API

  The `ai` and `zod` peer dependencies are now optional — only required when importing from `@cloudflare/codemode/ai`.

## 0.1.3

### Patch Changes

- [#1092](https://github.com/cloudflare/agents/pull/1092) [`c2df742`](https://github.com/cloudflare/agents/commit/c2df74279f3b0b3ad7895c81a0a7eea09b5595c0) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Export `normalizeCode` utility function for use by consumers that need to normalize user-provided code to async arrow function format before sandbox execution.

- [#1074](https://github.com/cloudflare/agents/pull/1074) [`33b92d5`](https://github.com/cloudflare/agents/commit/33b92d5264c62528d2a66d424c4b3d012ec9d648) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Remove `zod-to-ts` dependency to reduce bundle size. Zod schemas are now converted to TypeScript strings via JSON Schema using the existing `jsonSchemaToTypeString()` function and AI SDK's `asSchema()`.

## 0.1.2

### Patch Changes

- [#1020](https://github.com/cloudflare/agents/pull/1020) [`70ebb05`](https://github.com/cloudflare/agents/commit/70ebb05823b48282e3d9e741ab74251c1431ebdd) Thanks [@threepointone](https://github.com/threepointone)! - udpate dependencies

## 0.1.1

### Patch Changes

- [#962](https://github.com/cloudflare/agents/pull/962) [`ef46d68`](https://github.com/cloudflare/agents/commit/ef46d68e9c381b7541c4aa803014144abce4fb72) Thanks [@tumberger](https://github.com/tumberger)! - Validate tool arguments against Zod schema before execution in codemode sandbox

- [#973](https://github.com/cloudflare/agents/pull/973) [`969fbff`](https://github.com/cloudflare/agents/commit/969fbff702d5702c1f0ea6faaecb3dfd0431a01b) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#960](https://github.com/cloudflare/agents/pull/960) [`179b8cb`](https://github.com/cloudflare/agents/commit/179b8cbc60bc9e6ac0d2ee26c430d842950f5f08) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Harden JSON Schema to TypeScript converter for production use
  - Add depth and circular reference guards to prevent stack overflows on recursive or deeply nested schemas
  - Add `$ref` resolution for internal JSON Pointers (`#/definitions/...`, `#/$defs/...`, `#`)
  - Add tuple support (`prefixItems` for JSON Schema 2020-12, array `items` for draft-07)
  - Add OpenAPI 3.0 `nullable: true` support across all schema branches
  - Fix string escaping in enum/const values, property names (control chars, U+2028/U+2029), and JSDoc comments (`*/`)
  - Add per-tool error isolation in `generateTypes()` so one malformed schema cannot crash the pipeline
  - Guard missing `inputSchema` in `getAITools()` with a fallback to `{ type: "object" }`
  - Add per-tool error isolation in `getAITools()` so one bad MCP tool does not break the entire tool set

- [#961](https://github.com/cloudflare/agents/pull/961) [`f6aa79f`](https://github.com/cloudflare/agents/commit/f6aa79f3bf86922db73b4d33439262aefcbcf817) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Updated default tool prompt to explicitly request JavaScript code from LLMs, preventing TypeScript syntax errors in the Dynamic Worker executor.

## 0.1.0

### Minor Changes

- [#879](https://github.com/cloudflare/agents/pull/879) [`90e54da`](https://github.com/cloudflare/agents/commit/90e54dab21f7c2c783aac117693918765e8b254b) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Remove experimental_codemode() and CodeModeProxy. Replace with createCodeTool() from @cloudflare/codemode/ai which returns a standard AI SDK Tool. The package no longer owns an LLM call or model choice. Users call streamText/generateText with their own model and pass the codemode tool.

  The AI-dependent export (createCodeTool) is now at @cloudflare/codemode/ai. The root export (@cloudflare/codemode) contains the executor, type generation, and utilities which do not require the ai peer dependency.

  ToolDispatcher (extends RpcTarget) replaces CodeModeProxy (extends WorkerEntrypoint) for dispatching tool calls from the sandbox back to the host. It is passed as a parameter to the dynamic worker's evaluate() method instead of being injected as an env binding, removing the need for CodeModeProxy and globalOutbound service bindings. Only a WorkerLoader binding is required now. globalOutbound on DynamicWorkerExecutor defaults to null which blocks fetch/connect at the runtime level. New Executor interface (execute(code, fns) => ExecuteResult) allows custom sandbox implementations. DynamicWorkerExecutor is the Cloudflare Workers implementation. Console output captured in ExecuteResult.logs. Configurable execution timeout.

  AST-based code normalization via acorn replaces regex. sanitizeToolName() exported for converting MCP-style tool names to valid JS identifiers.

### Patch Changes

- [#954](https://github.com/cloudflare/agents/pull/954) [`943c407`](https://github.com/cloudflare/agents/commit/943c4070992bb836625abb5bf4e3271a6f52f7a2) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.8

### Patch Changes

- [#916](https://github.com/cloudflare/agents/pull/916) [`24e16e0`](https://github.com/cloudflare/agents/commit/24e16e025b82dbd7b321339a18c6d440b2879136) Thanks [@threepointone](https://github.com/threepointone)! - Widen peer dependency ranges across packages to prevent cascading major bumps during 0.x minor releases. Mark `@cloudflare/ai-chat` and `@cloudflare/codemode` as optional peer dependencies of `agents` to fix unmet peer dependency warnings during installation.

## 0.0.7

### Patch Changes

- [#849](https://github.com/cloudflare/agents/pull/849) [`21a7977`](https://github.com/cloudflare/agents/commit/21a79778f5150aecd890f55a164d397f70db681e) Thanks [@Muhammad-Bin-Ali](https://github.com/Muhammad-Bin-Ali)! - Allow configurable model in `experimental_codemode` instead of hardcoded `gpt-4.1`

- [#859](https://github.com/cloudflare/agents/pull/859) [`3de98a3`](https://github.com/cloudflare/agents/commit/3de98a398d55aeca51c7b845ed4c5d6051887d6d) Thanks [@threepointone](https://github.com/threepointone)! - broaden peer deps

- [#865](https://github.com/cloudflare/agents/pull/865) [`c3211d0`](https://github.com/cloudflare/agents/commit/c3211d0b0cc36aa294c15569ae650d3afeab9926) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.6

### Patch Changes

- [#813](https://github.com/cloudflare/agents/pull/813) [`7aebab3`](https://github.com/cloudflare/agents/commit/7aebab369d1bef6c685e05a4a3bd6627edcb87db) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#800](https://github.com/cloudflare/agents/pull/800) [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#818](https://github.com/cloudflare/agents/pull/818) [`7c74336`](https://github.com/cloudflare/agents/commit/7c743360d7e3639e187725391b9d5c114838bd18) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- Updated dependencies [[`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`d1a0c2b`](https://github.com/cloudflare/agents/commit/d1a0c2b73b1119d71e120091753a6bcca0e2faa9), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`fd79481`](https://github.com/cloudflare/agents/commit/fd7948180abf066fa3d27911a83ffb4c91b3f099), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`e20da53`](https://github.com/cloudflare/agents/commit/e20da5319eb46bac6ac580edf71836b00ac6f8bb), [`f604008`](https://github.com/cloudflare/agents/commit/f604008957f136241815909319a552bad6738b58), [`7aebab3`](https://github.com/cloudflare/agents/commit/7aebab369d1bef6c685e05a4a3bd6627edcb87db), [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e), [`7c74336`](https://github.com/cloudflare/agents/commit/7c743360d7e3639e187725391b9d5c114838bd18), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`ded8d3e`](https://github.com/cloudflare/agents/commit/ded8d3e8aeba0358ebd4aecb5ba15344b5a21db1)]:
  - agents@0.3.7

## 0.0.5

### Patch Changes

- [#776](https://github.com/cloudflare/agents/pull/776) [`93c613e`](https://github.com/cloudflare/agents/commit/93c613e077e7aa16e78cf9b0b53e285577e92ce5) Thanks [@ShoeBoom](https://github.com/ShoeBoom)! - prepend custom prompt to default assistant text

- Updated dependencies [[`395f461`](https://github.com/cloudflare/agents/commit/395f46105d3affb5a2e2ffd28c516a0eefe45bb4), [`f27e62c`](https://github.com/cloudflare/agents/commit/f27e62c24f586abb285843db183198230ddd47ca)]:
  - agents@0.3.6

## 0.0.4

### Patch Changes

- [#771](https://github.com/cloudflare/agents/pull/771) [`87dc96d`](https://github.com/cloudflare/agents/commit/87dc96d19de1d26dbb2badecbb9955a4eb8e9e2e) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- Updated dependencies [[`cf8a1e7`](https://github.com/cloudflare/agents/commit/cf8a1e7a24ecaac62c2aefca7b0fd5bf1373e8bd), [`87dc96d`](https://github.com/cloudflare/agents/commit/87dc96d19de1d26dbb2badecbb9955a4eb8e9e2e)]:
  - agents@0.3.4

## 0.0.3

### Patch Changes

- [`a5d0137`](https://github.com/cloudflare/agents/commit/a5d01379b9ad2d88bc028c50f1858b4e69f106c5) Thanks [@threepointone](https://github.com/threepointone)! - trigger a new release

- Updated dependencies [[`a5d0137`](https://github.com/cloudflare/agents/commit/a5d01379b9ad2d88bc028c50f1858b4e69f106c5)]:
  - agents@0.3.3

## 0.0.2

### Patch Changes

- [#756](https://github.com/cloudflare/agents/pull/756) [`0c4275f`](https://github.com/cloudflare/agents/commit/0c4275f8f4b71c264c32c3742d151ef705739c2f) Thanks [@threepointone](https://github.com/threepointone)! - feat: split ai-chat and codemode into separate packages

  Extract @cloudflare/ai-chat and @cloudflare/codemode into their own packages
  with comprehensive READMEs. Update agents README to remove chat-specific
  content and point to new packages. Fix documentation imports to reflect
  new package structure.

  Maintains backward compatibility, no breaking changes.

- Updated dependencies [[`0c4275f`](https://github.com/cloudflare/agents/commit/0c4275f8f4b71c264c32c3742d151ef705739c2f), [`f12553f`](https://github.com/cloudflare/agents/commit/f12553f2fa65912c68d9a7620b9a11b70b8790a2)]:
  - agents@0.3.2
