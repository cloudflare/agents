# @cloudflare/think

## 0.3.0

### Minor Changes

- [#1340](https://github.com/cloudflare/agents/pull/1340) [`3cbe776`](https://github.com/cloudflare/agents/commit/3cbe77668df356906244db6a75c4cfba2daa1836) Thanks [@threepointone](https://github.com/threepointone)! - Align Think lifecycle hooks with the AI SDK and fix latent bugs around tool-call hooks and extension dispatch.

  **Lifecycle hook context types are now derived from the AI SDK** (resolves [#1339](https://github.com/cloudflare/agents/issues/1339)). `StepContext`, `ChunkContext`, `ToolCallContext`, and `ToolCallResultContext` are derived from `StepResult`, `TextStreamPart`, and `TypedToolCall` so users get full typed access to `reasoning`, `sources`, `files`, `providerMetadata` (where Anthropic cache tokens live), `request`/`response`, etc., instead of `unknown`. The relevant AI SDK types are re-exported from `@cloudflare/think`.

  **`beforeToolCall` / `afterToolCall` now fire with correct timing.** `beforeToolCall` runs **before** the tool's `execute` (Think wraps every tool's `execute`), and `afterToolCall` runs **after** with `durationMs` and a discriminated `success`/`output`/`error` outcome (backed by `experimental_onToolCallFinish`).

  **`ToolCallDecision` is now functional.** Returning `{ action: "block", reason }`, `{ action: "substitute", output }`, or `{ action: "allow", input }` from `beforeToolCall` actually intercepts execution.

  **Extension hook dispatch.** `ExtensionManifest.hooks` claimed support for `beforeToolCall`/`afterToolCall`/`onStepFinish`/`onChunk` but Think only ever dispatched `beforeTurn`. All five hooks now dispatch to subscribed extensions with JSON-safe snapshots. Extension hook handlers also receive `(snapshot, host)` (symmetric with tool `execute`); previously only tool executes got the host bridge.

  **Breaking renames** (per AI SDK conventions): `ToolCallContext.args` → `input`, `ToolCallResultContext.args` → `input`, `ToolCallResultContext.result` → `output`. `afterToolCall` is now a discriminated union — read `output` only when `ctx.success === true`, and `error` when `ctx.success === false`. Equivalent renames on `ToolCallDecision`.

  See [docs/think/lifecycle-hooks.md](https://github.com/cloudflare/agents/blob/main/docs/think/lifecycle-hooks.md) for the full hook reference.

### Patch Changes

- [#1340](https://github.com/cloudflare/agents/pull/1340) [`3cbe776`](https://github.com/cloudflare/agents/commit/3cbe77668df356906244db6a75c4cfba2daa1836) Thanks [@threepointone](https://github.com/threepointone)! - Fix `_wrapToolsWithDecision` to `await originalExecute(...)` before checking for `Symbol.asyncIterator`. The previous code missed `Promise<AsyncIterable>` returns from plain async functions (`async function execute(...) { return makeIter(); }`) — `Symbol.asyncIterator in promise` is always false, the collapse logic was skipped, and the AI SDK ended up treating the iterator instance itself as the final output value (which the wrapper's own comment warned about). Both sync-returned-iterable and async-returned-iterable cases are now covered, with regression tests for each.

## 0.2.5

### Patch Changes

- [#1330](https://github.com/cloudflare/agents/pull/1330) [`b4d3fcf`](https://github.com/cloudflare/agents/commit/b4d3fcfcce7363b137ad47c31d40aebcb34d9a28) Thanks [@threepointone](https://github.com/threepointone)! - Fix `subAgent()` cross-DO I/O errors on first use and drop the `"experimental"` compatibility flag requirement.

  ### `subAgent()` cross-DO I/O fix

  Three issues in the facet initialization path caused `"Cannot perform I/O on behalf of a different Durable Object"` errors when spawning sub-agents in production:
  - `subAgent()` constructed a `Request` in the parent DO and passed it to the child via `stub.fetch()`. The `Request` carried native I/O tied to the parent isolate, which the child rejected.
  - The facet flag was set _after_ the first `onStart()` ran, so `broadcastMcpServers()` fired with `_isFacet === false` on the initial boot.
  - `_broadcastProtocol()`, the inherited `broadcast()`, and `_workflow_broadcast()` iterated the connection registry without an `_isFacet` guard, letting broadcasts reach into the parent DO's WebSocket registry from a child isolate.

  Replaces the fetch-based handshake with a new `_cf_initAsFacet(name)` RPC that runs entirely in the child isolate, sets `_isFacet` before init, and seeds partyserver's `__ps_name` key directly. Adds `_isFacet` guards to `_broadcastProtocol()` and overrides `broadcast()` to no-op on facets so downstream callers (chat-streaming paths, workflow broadcasts, user `this.broadcast(...)`) are covered. Removes the previous internal `_cf_markAsFacet()` method — `_cf_initAsFacet(name)` is the correct entry point (it sets the flag before running the first `onStart()`, which `_cf_markAsFacet` did not).

  ### `"experimental"` compatibility flag no longer required

  `ctx.facets`, `ctx.exports`, and `env.LOADER` (Worker Loader) have graduated out of the `"experimental"` compatibility flag in workerd. `agents` and `@cloudflare/think` no longer require it:
  - `subAgent()` / `abortSubAgent()` / `deleteSubAgent()` — the `@experimental` JSDoc tag and runtime error messages no longer reference the flag. The runtime guards on `ctx.facets` / `ctx.exports` stay in place and now nudge users toward updating `compatibility_date` instead.
  - `Think` — the `@experimental` JSDoc tag no longer references the flag.

  No code change is required; remove `"experimental"` from your `compatibility_flags` in `wrangler.jsonc` if it was only there for these features.

- [#1332](https://github.com/cloudflare/agents/pull/1332) [`7cb8acf`](https://github.com/cloudflare/agents/commit/7cb8acff8281a30bc17980e506ab5582f3cb1c72) Thanks [@threepointone](https://github.com/threepointone)! - Expose `createdAt` on fiber and chat recovery contexts so apps can suppress continuations for stale, interrupted turns.
  - `FiberRecoveryContext` (from `agents`) gains `createdAt: number` — epoch milliseconds when `runFiber` started, read from the `cf_agents_runs` row that was already tracked internally.
  - `ChatRecoveryContext` (from `@cloudflare/ai-chat` and `@cloudflare/think`) gains the same `createdAt` field, threaded through from the underlying fiber.

  With this, the stale-recovery guard pattern described in [#1324](https://github.com/cloudflare/agents/issues/1324) is a short override:

  ```typescript
  override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    if (Date.now() - ctx.createdAt > 2 * 60 * 1000) return { continue: false };
    return {};
  }
  ```

  No behavior change for existing callers. See `docs/chat-agents.md` (new "Guarding against stale recoveries" section) for the full recipe, including a loop-protection pattern using `onChatResponse`.

## 0.2.4

### Patch Changes

- [#1314](https://github.com/cloudflare/agents/pull/1314) [`61309f7`](https://github.com/cloudflare/agents/commit/61309f71438482a3e42b37a5a981975e4963af06) Thanks [@threepointone](https://github.com/threepointone)! - Enable `chatRecovery` by default — chat turns are now wrapped in `runFiber` for durable execution out of the box.

## 0.2.3

### Patch Changes

- [#1310](https://github.com/cloudflare/agents/pull/1310) [`bd0346e`](https://github.com/cloudflare/agents/commit/bd0346ec05406e258b3c8904874c7a8c0f4608e5) Thanks [@threepointone](https://github.com/threepointone)! - Fix `getConfig()` throwing "no such table: assistant_config" when called inside `configureSession()`

  The config storage helpers (`getConfig`, `configure`) now lazily ensure the `assistant_config` table exists before querying it, so they are safe to call at any point in the agent lifecycle — including during `configureSession()`.

- [#1312](https://github.com/cloudflare/agents/pull/1312) [`89773d1`](https://github.com/cloudflare/agents/commit/89773d12c391a472ba3d45c88b83c98ba7455947) Thanks [@threepointone](https://github.com/threepointone)! - Rename `unstable_chatRecovery` to `chatRecovery` — the feature is now stable.

## 0.2.2

### Patch Changes

- [#1163](https://github.com/cloudflare/agents/pull/1163) [`d3f757c`](https://github.com/cloudflare/agents/commit/d3f757c264f6271cb34863daaad0e381e40e6a6f) Thanks [@threepointone](https://github.com/threepointone)! - Add first-class browser tools (`@cloudflare/think/tools/browser`) for CDP-based web automation, matching the execution ladder alongside workspace, execute, and extensions.

## 0.2.1

### Patch Changes

- [#1275](https://github.com/cloudflare/agents/pull/1275) [`37b2ce3`](https://github.com/cloudflare/agents/commit/37b2ce37913566ce81d30377d5cb5b224765a3f3) Thanks [@threepointone](https://github.com/threepointone)! - Add built-in workspace to Think. Every Think instance now has `this.workspace` backed by the DO's SQLite storage, and workspace tools (read, write, edit, list, find, grep, delete) are automatically merged into every chat turn. Override `workspace` to add R2 spillover for large files. `@cloudflare/shell` is now a required peer dependency.

- [#1278](https://github.com/cloudflare/agents/pull/1278) [`8c7caab`](https://github.com/cloudflare/agents/commit/8c7caabb68361c8ce71b10e292d6dd33a9cc72dd) Thanks [@threepointone](https://github.com/threepointone)! - Think now owns the inference loop with lifecycle hooks at every stage.

  **Breaking:** `onChatMessage()`, `assembleContext()`, and `getMaxSteps()` are removed. Use lifecycle hooks and the `maxSteps` property instead. If you need full custom inference, extend `Agent` directly.

  **New lifecycle hooks:** `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChunk` — fire on every turn from all entry paths (WebSocket, `chat()`, `saveMessages`, auto-continuation).

  **`beforeTurn(ctx)`** receives the assembled system prompt, messages, tools, and model. Return a `TurnConfig` to override any part — model, system prompt, messages, tools, activeTools, toolChoice, maxSteps, providerOptions.

  **`maxSteps`** is now a property (default 10) instead of a method. Override per-turn via `TurnConfig.maxSteps`.

  **MCP tools auto-merged** — no need to manually merge `this.mcp.getAITools()` in `getTools()`.

  **Dynamic context blocks:** `Session.addContext()` and `Session.removeContext()` allow adding/removing context blocks after session initialization (e.g., from extensions).

  **Extension manifest expanded** with `context` (namespaced context block declarations) and `hooks` fields.

## 0.2.0

### Minor Changes

- [#1270](https://github.com/cloudflare/agents/pull/1270) [`87b4512`](https://github.com/cloudflare/agents/commit/87b4512985e47de659bf970a65a6d1951f5855fe) Thanks [@threepointone](https://github.com/threepointone)! - Wire Session into Think as the storage layer, achieving full feature parity with AIChatAgent plus Session-backed advantages.

  **Think (`@cloudflare/think`):**
  - Session integration: `this.messages` backed by `session.getHistory()`, tree-structured messages, context blocks, compaction, FTS5 search
  - `configureSession()` override for context blocks, compaction, search, skills (sync or async)
  - `assembleContext()` returns `{ system, messages }` with context block composition
  - `onChatResponse()` lifecycle hook fires from all turn paths
  - Non-destructive regeneration via `trigger: "regenerate-message"` with Session branching
  - `saveMessages()` for programmatic turn entry (scheduled responses, webhooks, proactive agents)
  - `continueLastTurn()` for extending the last assistant response
  - Custom body persistence across hibernation
  - `sanitizeMessageForPersistence()` hook for PII redaction
  - `messageConcurrency` strategies (queue/latest/merge/drop/debounce)
  - `resetTurnState()` extracted as protected method
  - `chatRecovery` with `runFiber` wrapping on all 4 turn paths
  - `onChatRecovery()` hook with `ChatRecoveryContext`
  - `hasPendingInteraction()` / `waitUntilStable()` for quiescence detection
  - Re-export `Session` from `@cloudflare/think`
  - Constructor wraps `onStart` — subclasses never need `super.onStart()`

  **agents (`agents/chat`):**
  - Extract `AbortRegistry`, `applyToolUpdate` + builders, `parseProtocolMessage` into shared `agents/chat` layer
  - Add `applyChunkToParts` export for fiber recovery

  **AIChatAgent (`@cloudflare/ai-chat`):**
  - Refactor to use shared `AbortRegistry` from `agents/chat`
  - Add `continuation` flag to `OnChatMessageOptions`
  - Export `getAgentMessages()` and tool part helpers
  - Add `getHttpUrl()` to `useAgent` return value

- [#1256](https://github.com/cloudflare/agents/pull/1256) [`dfab937`](https://github.com/cloudflare/agents/commit/dfab937c81b358415e66bda3f8abe76b85d12c11) Thanks [@threepointone](https://github.com/threepointone)! - Add durable fiber execution to the Agent base class.

  `runFiber(name, fn)` registers work in SQLite, holds a `keepAlive` ref, and enables recovery via `onFiberRecovered` after DO eviction. `ctx.stash()` and `this.stash()` checkpoint progress that survives eviction.

  `AIChatAgent` gains `chatRecovery` — when enabled, each chat turn is wrapped in a fiber. `onChatRecovery` provides provider-specific recovery (Workers AI continuation, OpenAI response retrieval, Anthropic synthetic message). `continueLastTurn()` appends to the interrupted assistant message seamlessly.

  `Think` now extends `Agent` directly (no mixin). Fiber support is inherited from the base class.

  **Breaking (experimental APIs only):**
  - Removed `withFibers` mixin (`agents/experimental/forever`)
  - Removed `withDurableChat` mixin (`@cloudflare/ai-chat/experimental/forever`)
  - Removed `./experimental/forever` export from both packages
  - Think no longer has a `fibers` flag — recovery is automatic via alarm housekeeping

## 0.1.2

### Patch Changes

- [#1248](https://github.com/cloudflare/agents/pull/1248) [`c74b615`](https://github.com/cloudflare/agents/commit/c74b6158060f49faf0c73f6c84f33b6db92c9ad0) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#1247](https://github.com/cloudflare/agents/pull/1247) [`31c6279`](https://github.com/cloudflare/agents/commit/31c6279575c876cc5a7e69a4130e13a0c1afc630) Thanks [@threepointone](https://github.com/threepointone)! - Add `ContinuationState` to `agents/chat` — shared state container for auto-continuation lifecycle. AIChatAgent's 15 internal auto-continuation fields consolidated into one `ContinuationState` instance (no public API change). Think gains deferred continuations, resume coordination for pending continuations, `onClose` cleanup, and hibernation persistence for client tools via `think_request_context` table.

- [#1237](https://github.com/cloudflare/agents/pull/1237) [`f3d5557`](https://github.com/cloudflare/agents/commit/f3d555797934c6bd15cf5af2678f5e20aa74713a) Thanks [@threepointone](https://github.com/threepointone)! - Add `TurnQueue` to `agents/chat` — a shared serial async queue with
  generation-based invalidation for chat turn scheduling. AIChatAgent and
  Think now both use `TurnQueue` internally, unifying turn serialization
  and the epoch/clear-generation concept. Think gains proper turn
  serialization (previously concurrent chat turns could interleave).

## 0.1.1

### Patch Changes

- [#1220](https://github.com/cloudflare/agents/pull/1220) [`31d96cb`](https://github.com/cloudflare/agents/commit/31d96cb10ab1c8cbd9fd96b73d82ef55c5524138) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix `@cloudflare/shell` peer dependency to require `>=0.2.0`. Previously, npm could resolve an incompatible shell version, causing runtime errors. If you hit `Workspace` constructor errors, upgrade `@cloudflare/shell` to 0.2.0 or later.

## 0.1.0

### Minor Changes

- [#1138](https://github.com/cloudflare/agents/pull/1138) [`36e2020`](https://github.com/cloudflare/agents/commit/36e2020d41d3d8a83b65b7e45e5af924b09f82ed) Thanks [@threepointone](https://github.com/threepointone)! - Drop Zod v3 from peer dependency range — now requires `zod ^4.0.0`. Replace dynamic `import("ai")` with `z.fromJSONSchema()` from Zod 4 for MCP tool schema conversion, removing the `ai` runtime dependency from the agents core. Remove `ensureJsonSchema()`.

## 0.0.2

### Patch Changes

- [#1125](https://github.com/cloudflare/agents/pull/1125) [`3b0df53`](https://github.com/cloudflare/agents/commit/3b0df53df10899df79d80e1d1938dbad0ae39b75) Thanks [@threepointone](https://github.com/threepointone)! - first publish
