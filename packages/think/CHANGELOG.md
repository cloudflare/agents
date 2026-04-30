# @cloudflare/think

## 0.5.0

### Minor Changes

- [#1421](https://github.com/cloudflare/agents/pull/1421) [`1b65ff5`](https://github.com/cloudflare/agents/commit/1b65ff5550f904e2a59bd6015703f82b02f85e4f) Thanks [@threepointone](https://github.com/threepointone)! - Add agent tool orchestration for running Think and AIChatAgent sub-agents as
  retained, streaming tools from a parent agent. The new surface includes
  `runAgentTool`, `agentTool`, parent-side run replay and cleanup, Think and
  AIChatAgent child adapter support, and headless React/client event state
  helpers.

### Patch Changes

- [#1424](https://github.com/cloudflare/agents/pull/1424) [`58ca2fc`](https://github.com/cloudflare/agents/commit/58ca2fc1edda0f8a91ddce853014f8a7c8662f64) Thanks [@threepointone](https://github.com/threepointone)! - Add `sendReasoning` controls to Think. Subclasses can set an instance-wide default, and `beforeTurn` can return a per-turn override to include or suppress reasoning chunks in UI message streams.

- [#1423](https://github.com/cloudflare/agents/pull/1423) [`0ed42a9`](https://github.com/cloudflare/agents/commit/0ed42a908ed28181d12dfaa9c97e182e831d0218) Thanks [@threepointone](https://github.com/threepointone)! - Forward `TurnConfig.experimental_telemetry` to Think's internal AI SDK
  `streamText()` call so applications can configure per-turn LLM observability.

## 0.4.2

### Patch Changes

- [`ca510d4`](https://github.com/cloudflare/agents/commit/ca510d4fecbecb07d0d3cdad7d78c32cc226275e) Thanks [@threepointone](https://github.com/threepointone)! - Tighten internal peer dependency floors to reflect the current monorepo set we actually test against: `agents` (`>=0.8.7` → `>=0.11.7`), `@cloudflare/codemode` (`>=0.0.7` → `>=0.3.4`), and `@cloudflare/shell` (`>=0.2.0` → `>=0.3.4`). Upper bounds (`<1.0.0`) are unchanged.

  No runtime change in `@cloudflare/think` itself. The visible effect for consumers: pairing the latest `@cloudflare/think` with a stale `agents` (`<0.11.7`), `@cloudflare/codemode` (`<0.3.4`), or `@cloudflare/shell` (`<0.3.4`) now produces a peer warning where it previously did not. That's the intended signal — those older combinations are no longer tested in the monorepo.

- [#1411](https://github.com/cloudflare/agents/pull/1411) [`2fa68be`](https://github.com/cloudflare/agents/commit/2fa68bea891e1bd8f30839586c2519627f364b0c) Thanks [@threepointone](https://github.com/threepointone)! - Add `options.signal` to `Think.saveMessages` and `Think.continueLastTurn` for external cancellation of programmatic turns, plus protected `abortRequest(id)` / `abortAllRequests()` methods to replace bracket access into the private `_aborts` registry ([#1406](https://github.com/cloudflare/agents/issues/1406)).

  `saveMessages` and `continueLastTurn` accept a second `SaveMessagesOptions` argument:

  ```typescript
  const result = await this.saveMessages(messages, {
    signal: controller.signal
  });
  if (result.status === "aborted") {
    // Inference loop terminated mid-stream; partial chunks persisted.
  }
  ```

  The signal is linked to Think's per-turn `AbortController` for the duration of the call. When it aborts:
  - the inference loop's signal aborts (the same path `chat-request-cancel` takes);
  - partial chunks already streamed are persisted to the resumable stream;
  - `saveMessages` resolves with `{ status: "aborted" }`;
  - `onChatResponse` fires with `status: "aborted"`.

  Pre-aborted signals short-circuit before any model work runs. Listeners are detached cleanly when the turn finishes, so passing the same long-lived `AbortSignal` to many turns (e.g. a parent chat-turn signal driving multiple sub-agent calls) is safe and leak-free.

  `abortRequest(id, reason?)` and `abortAllRequests()` are protected entry points for DO subclasses (e.g. RPC-driven helpers) that want to cancel turns without tracking ids — they replace the historical `(this as unknown as { _aborts: ... })._aborts.destroyAll()` workaround used by helper-as-sub-agent implementations.

  `SaveMessagesResult.status` now includes `"aborted"` alongside `"completed"` and `"skipped"`. Existing callers that only switch on `"completed"` are unaffected.

  **Limitations.**
  - `AbortSignal` cannot cross Durable Object RPC. Construct the controller inside the DO that calls `saveMessages`. To bridge a parent's intent into a child DO, return a `ReadableStream` from the child whose `cancel` callback aborts a per-turn controller — `examples/agents-as-tools` shows the canonical pattern.
  - The signal lives in memory only. If the DO hibernates mid-turn and `chatRecovery` is enabled, the recovered turn calls `continueLastTurn()` internally without the original signal — an abort fired after restart has no effect on the recovered turn.

  See [`cloudflare/agents#1406`](https://github.com/cloudflare/agents/issues/1406) for the motivating use case.

## 0.4.1

### Patch Changes

- [#1395](https://github.com/cloudflare/agents/pull/1395) [`63cfae6`](https://github.com/cloudflare/agents/commit/63cfae6345c5ddc54df5e2f78a19097b9b5462ff) Thanks [@threepointone](https://github.com/threepointone)! - Share submit concurrency bookkeeping through `agents/chat` and use it from both chat agents.

  This extracts the `latest`/`merge`/`drop`/`debounce` admission state machine into a `SubmitConcurrencyController` exported from `agents/chat`. `AIChatAgent` semantics (including merge persistence) are preserved. `Think` now picks up the same pending-enqueue protection, so an overlapping submit is still detected while an accepted request is between admission and turn queue registration.

  Additional fixes:
  - `Think` now captures the turn generation immediately after admission and threads it into `_turnQueue.enqueue`, so a clear that lands between admission and queue registration cannot run a stale turn.
  - Pending-enqueue tracking is now bound to a release function tied to the controller's reset epoch, so a release from a pre-reset submit can no longer erase a post-reset submit's marker and let a third submit slip through as non-overlapping.
  - Debounce cancellation correctly resolves all in-flight waiters instead of overwriting a single timer slot.

- [#1394](https://github.com/cloudflare/agents/pull/1394) [`a0a0d17`](https://github.com/cloudflare/agents/commit/a0a0d179a862547715b0dd2e38d37065f24eabe5) Thanks [@threepointone](https://github.com/threepointone)! - think: add `beforeStep` lifecycle hook and `output` passthrough on `TurnConfig`.
  - **`beforeStep(ctx)`** — new lifecycle hook called before each AI SDK step in the agentic loop, wired to `streamText({ prepareStep })`. Receives a `PrepareStepContext` (the AI SDK's `PrepareStepFunction` parameter — `steps`, `stepNumber`, `model`, `messages`, `experimental_context`) and may return a `StepConfig` (`PrepareStepResult`) to override `model`, `toolChoice`, `activeTools`, `system`, `messages`, `experimental_context`, or `providerOptions` for the current step. Use `beforeTurn` for turn-wide assembly and `beforeStep` when the decision depends on the step number or previous step results. Resolves [#1363](https://github.com/cloudflare/agents/issues/1363).
  - **`TurnConfig.output`** — new optional field on `TurnConfig` forwarded to `streamText`. Accepts the AI SDK's structured-output spec (e.g. `Output.object({ schema })`, `Output.text()`) so a single agent can keep tools enabled on intermediate turns and return schema-validated structured output on a designated turn — without losing tools at model construction. Combine with `activeTools: []` for providers that strip tools when `responseFormat: "json"` is active (e.g. `workers-ai-provider`). Resolves [#1383](https://github.com/cloudflare/agents/issues/1383).
  - New re-exports from `@cloudflare/think`: `PrepareStepFunction`, `PrepareStepResult`, `PrepareStepContext`, `StepConfig`.

  `beforeStep` is available to subclasses; it is not dispatched to extensions (the AI SDK `prepareStep` boundary surfaces non-serializable inputs like `LanguageModel` instances). The AI SDK does not expose `output` or `maxSteps` per step — set those at the turn level via `TurnConfig`. All other extension hook subscriptions are unchanged.

- [#1372](https://github.com/cloudflare/agents/pull/1372) [`040da0f`](https://github.com/cloudflare/agents/commit/040da0fae4bbbcc5d3f412f68441674e84207c8c) Thanks [@threepointone](https://github.com/threepointone)! - Remove Think's unused internal `session_id` config scaffolding and move Think's private config into a dedicated `think_config` table.

  Older builds wrote Think-owned config into Session's shared `assistant_config(session_id, key, value)` table even though Think never actually had top-level multi-session support and `_sessionId()` always returned the empty string. Think now stores its private config rows in `think_config(key, value)`, which better matches the shipped model of one Think Durable Object per conversation and avoids overloading Session's shared metadata table.

  Existing Durable Objects are migrated automatically on startup: legacy Think-owned keys stored in `assistant_config` with `session_id = ''` are copied into `think_config` before config reads and writes continue.

- [#1396](https://github.com/cloudflare/agents/pull/1396) [`fdf5a8a`](https://github.com/cloudflare/agents/commit/fdf5a8a99ec1a88ce9096ddec3a9fb2adf6fd4b1) Thanks [@threepointone](https://github.com/threepointone)! - Fix Think persisting a duplicate orphan assistant row when a user submits during a streaming tool turn ([#1381](https://github.com/cloudflare/agents/issues/1381)).

  When `useAgentChat` posts an in-flight assistant snapshot it minted optimistically (client-generated ID, `state: "input-available"`), Session's INSERT-OR-IGNORE-by-ID would store it as a separate row alongside the eventual server-owned assistant for the same `toolCallId`. The next turn's `convertToModelMessages` then produced a malformed Anthropic prompt and the provider rejected it.

  `reconcileMessages` and `resolveToolMergeId` now live in `agents/chat` and Think runs them in `_handleChatRequest` before persistence. Stale `input-available` snapshots pick up the server's tool output via `mergeServerToolOutputs`, and any incoming assistant whose `toolCallId` already exists on a server row adopts the server's ID so persistence updates the existing row instead of inserting an orphan.

  `@cloudflare/ai-chat` keeps its existing reconciler behavior; the only change is that it now imports `reconcileMessages` / `resolveToolMergeId` from `agents/chat` instead of a local file.

- [#1374](https://github.com/cloudflare/agents/pull/1374) [`a6e22c3`](https://github.com/cloudflare/agents/commit/a6e22c362668fc295208d0718eae4cf2aa3f792a) Thanks [@threepointone](https://github.com/threepointone)! - Fix stream resumption on page refresh: do not broadcast `cf_agent_chat_messages` from Think's `onConnect` while a resumable stream is in flight.

  Previously, Think unconditionally sent a `cf_agent_chat_messages` frame on every new WebSocket connection. When a client refreshed during an active chat turn, that broadcast arrived in the same connect sequence as `cf_agent_stream_resuming` and overwrote the in-progress assistant message the client was about to rebuild from the resumed stream. The assistant reply would stay hidden until the server finished the turn and re-broadcast the persisted history.

  Now Think only broadcasts `cf_agent_chat_messages` on connect when there is no active resumable stream. During an active stream the resume flow is the authoritative source of state: `STREAM_RESUMING` triggers replay of buffered chunks, and the final state broadcast happens when the turn completes. This matches the behavior that `AIChatAgent` already had.

  Marked the internal `_resumableStream` field as `protected` (previously `private`) so framework subclasses and focused tests can coordinate around the resume lifecycle.

- [#1384](https://github.com/cloudflare/agents/pull/1384) [`a7059d4`](https://github.com/cloudflare/agents/commit/a7059d4a5a1071a10c60be0e777968fc7ff5d36c) Thanks [@threepointone](https://github.com/threepointone)! - Introduce `WorkspaceLike` — type the `this.workspace` field as the minimum surface Think actually uses instead of the concrete `Workspace` class.

  `Think`'s `workspace` is now typed as `WorkspaceLike` (`Pick<Workspace, "readFile" | "writeFile" | "readDir" | "rm" | "glob" | "mkdir" | "stat">`) rather than `Workspace`. `createWorkspaceTools()` likewise accepts any `WorkspaceLike`. The default runtime value is unchanged — a full `Workspace` backed by the DO's SQLite — so the vast majority of consumers need no changes.

  This unlocks patterns like a shared workspace across multiple agents: a child agent can override `workspace` with a proxy that forwards each call to a parent DO via RPC, and the rest of Think's workspace-aware code (the builtin tools, lifecycle hooks) keeps working without cast gymnastics. See `examples/assistant` for the cross-chat shared workspace built on this.

  Consumers who use `createWorkspaceStateBackend(workspace)` from `@cloudflare/shell` (codemode's `state.*` API) still need a concrete `Workspace` — that helper reaches for more of the filesystem surface than `WorkspaceLike` covers.

## 0.4.0

### Minor Changes

- [#1350](https://github.com/cloudflare/agents/pull/1350) [`3a1140f`](https://github.com/cloudflare/agents/commit/3a1140fa561fdff5d1925f0c2b3b7436af8b483f) Thanks [@threepointone](https://github.com/threepointone)! - Align `Think` generics with `Agent` / `AIChatAgent`.

  `Think` is now `Think<Env, State, Props>` and extends `Agent<Env, State, Props>`, so subclasses get properly typed `this.state`, `this.setState()`, `initialState`, and `this.ctx.props`. The previous `Config` class generic is removed.

  `configure()` and `getConfig()` remain, but the config type is now specified at the call site via a method-level generic:

  ```ts
  // Before
  export class MyAgent extends Think<Env, MyConfig> {
    getModel() {
      const tier = this.getConfig()?.modelTier ?? "fast";
      // ...
    }
  }

  // After
  export class MyAgent extends Think<Env> {
    getModel() {
      const tier = this.getConfig<MyConfig>()?.modelTier ?? "fast";
      // ...
    }
  }
  ```

  This is a breaking change for anyone using the second type parameter of `Think`. Update the class declaration and any direct `configure(...)` / `getConfig()` call sites that relied on the class-level `Config` type.

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
