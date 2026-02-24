# @cloudflare/ai-chat

## 0.1.4

### Patch Changes

- [#967](https://github.com/cloudflare/agents/pull/967) [`c128447`](https://github.com/cloudflare/agents/commit/c1284478fe212ddd6e1bc915877cee5c10fcfd49) Thanks [@threepointone](https://github.com/threepointone)! - Follow-up to #956. Allow `addToolOutput` to work with tools in `approval-requested` and `approval-responded` states, not just `input-available`. Also adds support for `state: "output-error"` and `errorText` fields, enabling custom denial messages when rejecting tool approvals (addresses remaining items from #955).

  Additionally, tool approval rejections (`approved: false`) now auto-continue the conversation when `autoContinue` is set, so the LLM sees the denial and can respond naturally (e.g. suggest alternatives).

  This enables the Vercel AI SDK recommended pattern for client-side tool denial:

  ```ts
  addToolOutput({
    toolCallId: invocation.toolCallId,
    state: "output-error",
    errorText: "User declined: insufficient permissions",
  });
  ```

- [#958](https://github.com/cloudflare/agents/pull/958) [`f70a8b9`](https://github.com/cloudflare/agents/commit/f70a8b9e2774d729825b8d85152c403d0c1e6dba) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix duplicate assistant message persistence when clients resend full history with local assistant IDs that differ from server IDs.

  `AIChatAgent.persistMessages()` now reconciles non-tool assistant messages against existing server history by content and order, reusing the server ID instead of inserting duplicate rows.

- [#977](https://github.com/cloudflare/agents/pull/977) [`5426b6f`](https://github.com/cloudflare/agents/commit/5426b6f3a8f394bdbad5e6b5cf22e279249bcdae) Thanks [@dmmulroy](https://github.com/dmmulroy)! - Expose `requestId` in `OnChatMessageOptions` so handlers can send properly-tagged error responses for pre-stream failures.

  Also fix `saveMessages()` to pass the full options object (`requestId`, `abortSignal`, `clientTools`, `body`) to `onChatMessage` and use a consistent request ID for `_reply`.

- [#973](https://github.com/cloudflare/agents/pull/973) [`969fbff`](https://github.com/cloudflare/agents/commit/969fbff702d5702c1f0ea6faaecb3dfd0431a01b) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#983](https://github.com/cloudflare/agents/pull/983) [`2785f10`](https://github.com/cloudflare/agents/commit/2785f104f187834a0d568ad7db668d961b33707f) Thanks [@threepointone](https://github.com/threepointone)! - Fix abort/cancel support for streaming responses. The framework now properly cancels the reader loop when the abort signal fires and sends a done signal to the client. Added a warning log when cancellation arrives but the stream has not closed (indicating the user forgot to pass `abortSignal` to their LLM call). Also fixed vitest project configs to scope test file discovery and prevent e2e/react tests from being picked up by the wrong runner.

- [#979](https://github.com/cloudflare/agents/pull/979) [`23c90ea`](https://github.com/cloudflare/agents/commit/23c90ea4bdd63c03f28c40e1c3594b34ff523bf7) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Fix jsonSchema not initialized error when calling getAITools() in onChatMessage

- [#980](https://github.com/cloudflare/agents/pull/980) [`00c576d`](https://github.com/cloudflare/agents/commit/00c576de0ddcbac1ae4496abb14804cfb34e251e) Thanks [@threepointone](https://github.com/threepointone)! - Fix `_sanitizeMessageForPersistence` stripping Anthropic `redacted_thinking` blocks. The sanitizer now strips OpenAI ephemeral metadata first, then filters out only reasoning parts that are truly empty (no text and no remaining `providerMetadata`). This preserves Anthropic's `redacted_thinking` blocks (stored as empty-text reasoning parts with `providerMetadata.anthropic.redactedData`) while still removing OpenAI placeholders. Fixes #978.

- [#953](https://github.com/cloudflare/agents/pull/953) [`bd22d60`](https://github.com/cloudflare/agents/commit/bd22d6005fab16d0dc358274dcb12d368a31e076) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Moved `/get-messages` endpoint handling from a prototype `override onRequest()` method to a constructor wrapper. This ensures the endpoint always works, even when users override `onRequest` without calling `super.onRequest()`.

- [#956](https://github.com/cloudflare/agents/pull/956) [`ab401a0`](https://github.com/cloudflare/agents/commit/ab401a0e0b6942490e845cc9e34d9f17f65cbde8) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix denied tool approvals (`CF_AGENT_TOOL_APPROVAL` with `approved: false`) to transition tool parts to `output-denied` instead of `approval-responded`.

  This ensures `convertToModelMessages` emits a `tool_result` for denied approvals, which is required by providers like Anthropic.

  Also adds regression tests for denied approval behavior, including rejection from `approval-requested` state.

- [#982](https://github.com/cloudflare/agents/pull/982) [`5a851be`](https://github.com/cloudflare/agents/commit/5a851bef389683a13380626c8bed515a6351b172) Thanks [@threepointone](https://github.com/threepointone)! - Undeprecate client tool APIs (`createToolsFromClientSchemas`, `clientTools`, `AITool`, `extractClientToolSchemas`, and the `tools` option on `useAgentChat`) for SDK/platform use cases where tools are defined dynamically at runtime. Fix spurious `detectToolsRequiringConfirmation` deprecation warning when using the `tools` option.

## 0.1.3

### Patch Changes

- [#954](https://github.com/cloudflare/agents/pull/954) [`943c407`](https://github.com/cloudflare/agents/commit/943c4070992bb836625abb5bf4e3271a6f52f7a2) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.1.2

### Patch Changes

- [#930](https://github.com/cloudflare/agents/pull/930) [`cd408fe`](https://github.com/cloudflare/agents/commit/cd408fe495176e67066ebbb3962c224ada702124) Thanks [@threepointone](https://github.com/threepointone)! - Fix stale agent reference in useAgentChat transport under React StrictMode

  The `agentRef` was updated via `useEffect` (async, after render), but the `WebSocketChatTransport` is created in `useMemo` (sync, during render). When the agent reconnects or switches, `useMemo` would capture the old (closed) agent because the effect hadn't fired yet — causing `sendMessage` to send to a dead WebSocket. Fixed by updating `agentRef.current` synchronously during render, matching the pattern already used by other refs in the same hook.

## 0.1.1

### Patch Changes

- [`eeadbf4`](https://github.com/cloudflare/agents/commit/eeadbf4e780e2477798185cbc7a8abbeff2eadda) Thanks [@threepointone](https://github.com/threepointone)! - Add @ai-sdk/react as peer dependency to ai-chat

  Declare @ai-sdk/react ^3.0.0 as a peerDependency in packages/ai-chat/package.json to express runtime compatibility with the React SDK. package-lock.json was updated to reflect the resulting dependency graph changes.

## 0.1.0

The first minor release of `@cloudflare/ai-chat` — a major step up from the `agents/ai-chat-agent` re-export. This release refactors the internals (extracting ResumableStream, adding a WebSocket ChatTransport, simplifying SSE parsing) and ships a wave of bug fixes for streaming, tool continuations, and message persistence. New features include `maxPersistedMessages` for storage caps, `body` for custom request data, row size protection, incremental persistence, and data parts — typed JSON blobs that can be attached to messages alongside text for citations, progress indicators, and usage metadata. Tool approval (`needsApproval`) now persists across page refresh, client tools survive DO hibernation, and `autoContinueAfterToolResult` defaults to `true` so the LLM responds after tool results without explicit opt-in.

### Minor Changes

- [#899](https://github.com/cloudflare/agents/pull/899) [`04c6411`](https://github.com/cloudflare/agents/commit/04c6411c9a73fe48784d7ce86150d62cf54becda) Thanks [@threepointone](https://github.com/threepointone)! - Refactor AIChatAgent: extract ResumableStream class, add WebSocket ChatTransport, simplify SSE parsing.

  **Bug fixes:**
  - Fix `setMessages` functional updater sending empty array to server
  - Fix `_sendPlaintextReply` creating multiple text parts instead of one
  - Fix uncaught exception on empty/invalid request body
  - Fix `CF_AGENT_MESSAGE_UPDATED` not broadcast for streaming messages
  - Fix stream resumption race condition (client-initiated resume request + replay flag)
  - Fix `_streamCompletionPromise` not resolved on error (tool continuations could hang)
  - Fix `body` lost during tool continuations (now preserved alongside `clientTools`)
  - Fix `clearAll()` not clearing in-memory chunk buffer (orphaned chunks could flush after clear)
  - Fix errored streams never cleaned up by garbage collector
  - Fix `reasoning-delta` silently dropping data when `reasoning-start` was missed (stream resumption)
  - Fix row size guard using `string.length` instead of UTF-8 byte count for SQLite limits
  - Fix `completed` guard on abort listener to prevent redundant cancel after stream completion

  **New features:**
  - `maxPersistedMessages` — cap SQLite message storage with automatic oldest-message deletion
  - `body` option on `useAgentChat` — send custom data with every request (static or dynamic)
  - Incremental persistence with hash-based cache to skip redundant SQL writes
  - Row size guard — automatic two-pass compaction when messages approach SQLite 2MB limit
  - `onFinish` is now optional — framework handles abort controller cleanup and observability
  - Stream chunk size guard in ResumableStream (skip oversized chunks for replay)
  - Full tool streaming lifecycle in message-builder (tool-input-start/delta/error, tool-output-error)

  **Docs:**
  - New `docs/chat-agents.md` — comprehensive AIChatAgent and useAgentChat reference
  - Rewritten README, migration guides, human-in-the-loop, resumable streaming, client tools docs
  - New `examples/ai-chat/` example with modern patterns and Workers AI

  **Deprecations (with console.warn):**
  - `createToolsFromClientSchemas()`, `extractClientToolSchemas()`, `detectToolsRequiringConfirmation()`
  - `tools`, `toolsRequiringConfirmation`, `experimental_automaticToolResolution` options
  - `addToolResult()` (use `addToolOutput()`)

- [#919](https://github.com/cloudflare/agents/pull/919) [`6b6497c`](https://github.com/cloudflare/agents/commit/6b6497c65e07175ffd83f8cf3a6b3371e2dc17eb) Thanks [@threepointone](https://github.com/threepointone)! - Change `autoContinueAfterToolResult` default from `false` to `true`.

  Client-side tool results and tool approvals now automatically trigger a server continuation by default, matching the behavior of server-executed tools (which auto-continue via `streamText`'s multi-step). This eliminates the most common setup friction with client tools — the LLM now responds after receiving tool results without requiring explicit opt-in.

  To restore the previous behavior, set `autoContinueAfterToolResult: false` in `useAgentChat`.

### Patch Changes

- [#900](https://github.com/cloudflare/agents/pull/900) [`16b2dca`](https://github.com/cloudflare/agents/commit/16b2dcaf5adc152e78f01230dd99d4710867d4b6) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Add support for `data-*` stream parts (developer-defined typed JSON blobs) in the shared message builder and client hook.

  **Data part handling:**

  `applyChunkToParts` now handles `data-*` prefixed chunk types, covering both server persistence and client reconstruction (stream resume, cross-tab broadcast). Transient parts (`transient: true`) are broadcast to connected clients but excluded from `message.parts` and SQLite persistence. Non-transient parts support reconciliation by type+id — a second chunk with the same type and id updates the existing part's data in-place instead of appending a duplicate.

  **`onData` callback forwarding:**

  `useAgentChat` now invokes the `onData` callback for `data-*` chunks on the stream resumption and cross-tab broadcast codepaths, which bypass the AI SDK's internal pipeline. For new messages sent via the transport, the AI SDK already invokes `onData` internally. This is the correct way to consume transient data parts on the client since they are not added to `message.parts`.

- [#922](https://github.com/cloudflare/agents/pull/922) [`c8e5244`](https://github.com/cloudflare/agents/commit/c8e524499d902229e8ac83afd6cf2864f888cecc) Thanks [@threepointone](https://github.com/threepointone)! - Fix tool approval UI not surviving page refresh, and fix invalid prompt error after approval
  - Handle `tool-approval-request` and `tool-output-denied` stream chunks in the server-side message builder. Previously these were only handled client-side, so the server never transitioned tool parts to `approval-requested` or `output-denied` state.
  - Persist the streaming message to SQLite (without broadcasting) when a tool enters `approval-requested` state. The stream is paused waiting for user approval, so this is a natural persistence point. Without this, refreshing the page would reload from SQLite where the tool was still in `input-available` state, showing "Running..." instead of the Approve/Reject UI.
  - On stream completion, update the early-persisted message in place rather than appending a duplicate.
  - Fix `_applyToolApproval` to merge with existing approval data instead of replacing it. Previously `approval: { approved }` would overwrite the entire object, losing the `id` field that `convertToModelMessages` needs to produce a valid `tool-approval-request` content part. This caused an `InvalidPromptError` on the continuation stream after approval.

- [#897](https://github.com/cloudflare/agents/pull/897) [`994a808`](https://github.com/cloudflare/agents/commit/994a808abb5620b57aba4e0e0125bbcd89c1ae5f) Thanks [@alexanderjacobsen](https://github.com/alexanderjacobsen)! - Fix client tool schemas lost after DO restart by re-sending them with CF_AGENT_TOOL_RESULT

- [#916](https://github.com/cloudflare/agents/pull/916) [`24e16e0`](https://github.com/cloudflare/agents/commit/24e16e025b82dbd7b321339a18c6d440b2879136) Thanks [@threepointone](https://github.com/threepointone)! - Widen peer dependency ranges across packages to prevent cascading major bumps during 0.x minor releases. Mark `@cloudflare/ai-chat` and `@cloudflare/codemode` as optional peer dependencies of `agents` to fix unmet peer dependency warnings during installation.

- [#912](https://github.com/cloudflare/agents/pull/912) [`baa87cc`](https://github.com/cloudflare/agents/commit/baa87cceccd11ce051af5d2918831ec8eddd86fb) Thanks [@threepointone](https://github.com/threepointone)! - Persist request context across Durable Object hibernation.

  Persist `_lastBody` and `_lastClientTools` to SQLite so custom body fields and client tool schemas survive Durable Object hibernation during tool continuation flows (issue #887). Add test coverage for body forwarding during tool auto-continuation, and update JSDoc for `OnChatMessageOptions.body` to document tool continuation and hibernation behavior.

- [#913](https://github.com/cloudflare/agents/pull/913) [`bc91c9a`](https://github.com/cloudflare/agents/commit/bc91c9a63aefa2faf37db2ad7b5f3f382a1de101) Thanks [@threepointone](https://github.com/threepointone)! - Sync `_lastClientTools` cache and SQLite when client tools arrive via `CF_AGENT_TOOL_RESULT`, and align the wire type with `ClientToolSchema` (`JSONSchema7` instead of `Record<string, unknown>`)

- [#919](https://github.com/cloudflare/agents/pull/919) [`6b6497c`](https://github.com/cloudflare/agents/commit/6b6497c65e07175ffd83f8cf3a6b3371e2dc17eb) Thanks [@threepointone](https://github.com/threepointone)! - Add auto-continuation support for tool approval (`needsApproval`).

  When a tool with `needsApproval: true` is approved via `CF_AGENT_TOOL_APPROVAL`, the server can now automatically continue the conversation (matching the existing `autoContinue` behavior of `CF_AGENT_TOOL_RESULT`). The client hook passes `autoContinue` with approval messages when `autoContinueAfterToolResult` is enabled. Also fixes silent data loss where `tool-output-available` events for tool calls in previous assistant messages were dropped during continuation streams by adding a cross-message fallback search in `_streamSSEReply`.

- [#910](https://github.com/cloudflare/agents/pull/910) [`a668155`](https://github.com/cloudflare/agents/commit/a668155598aa8cd2f53b724391d1c538f3e96a2d) Thanks [@threepointone](https://github.com/threepointone)! - Add structural message validation and fix message metadata on broadcast/resume path.

  **Structural message validation:**

  Messages loaded from SQLite are now validated for required structure (non-empty `id` string, valid `role`, `parts` is an array). Malformed rows — from corruption, manual tampering, or schema drift — are logged with a warning and silently skipped instead of crashing the agent. This is intentionally lenient: empty `parts` arrays are allowed (streams that errored mid-flight), and no tool/data schema validation is performed at load time (that remains a userland concern via `safeValidateUIMessages` from the AI SDK).

  **Message metadata on broadcast/resume path:**

  The server already captures `messageMetadata` from `start`, `finish`, and `message-metadata` stream chunks and persists it on `message.metadata`. However, the client-side broadcast path (multi-tab sync) and stream resume path (reconnection) did not propagate metadata — the `activeStreamRef` only tracked `parts`. Now it also tracks `metadata`, and `flushActiveStreamToMessages` includes it in the partial message flushed to React state. This means cross-tab clients and reconnecting clients see metadata (model info, token usage, timestamps) during streaming, not just after the final `CF_AGENT_CHAT_MESSAGES` broadcast.

## 0.0.8

### Patch Changes

- [#882](https://github.com/cloudflare/agents/pull/882) [`584cebe`](https://github.com/cloudflare/agents/commit/584cebe882f437a685b96b26b15200dc50ba70e1) Thanks [@alexanderjacobsen](https://github.com/alexanderjacobsen)! - Fix multi-step client tool calling: pass stored client tool schemas to `onChatMessage` during tool continuations so the LLM can call additional client tools after auto-continuation. Also add a re-trigger mechanism to the client-side tool resolution effect to handle tool calls arriving during active resolution.

- [#891](https://github.com/cloudflare/agents/pull/891) [`0723b99`](https://github.com/cloudflare/agents/commit/0723b9909f037d494e0c7db43e031c952578c82e) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fix `getCurrentAgent()` returning `undefined` connection when used with `@cloudflare/ai-chat` and Vite SSR

  Re-export `agentContext` as `__DO_NOT_USE_WILL_BREAK__agentContext` from the main `agents` entry point and update `@cloudflare/ai-chat` to import it from `agents` instead of the `agents/internal_context` subpath export. This prevents Vite SSR pre-bundling from creating two separate `AsyncLocalStorage` instances, which caused `getCurrentAgent().connection` to be `undefined` inside `onChatMessage` and tool `execute` functions.

  The `agents/internal_context` subpath export has been removed from `package.json` and the deprecated `agentContext` alias has been removed from `internal_context.ts`. This was never a public API.

- [#886](https://github.com/cloudflare/agents/pull/886) [`4292f6b`](https://github.com/cloudflare/agents/commit/4292f6ba6d49201c88b09553452c3b243620f35b) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Forward custom body fields from client requests to `onChatMessage` options

  Custom data sent via `prepareSendMessagesRequest` or the AI SDK's `body` option in `sendMessage` is now available in the `onChatMessage` handler through `options.body`. This allows passing dynamic context (e.g., model selection, temperature, custom metadata) from the client to the server without workarounds.

## 0.0.7

### Patch Changes

- [#859](https://github.com/cloudflare/agents/pull/859) [`3de98a3`](https://github.com/cloudflare/agents/commit/3de98a398d55aeca51c7b845ed4c5d6051887d6d) Thanks [@threepointone](https://github.com/threepointone)! - broaden peer deps

- [#865](https://github.com/cloudflare/agents/pull/865) [`c3211d0`](https://github.com/cloudflare/agents/commit/c3211d0b0cc36aa294c15569ae650d3afeab9926) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.6

### Patch Changes

- [#829](https://github.com/cloudflare/agents/pull/829) [`83f137f`](https://github.com/cloudflare/agents/commit/83f137f7046aeafc3b480b5aa4518f6290b14406) Thanks [@Muhammad-Bin-Ali](https://github.com/Muhammad-Bin-Ali)! - Fix duplicate assistant messages when using needsApproval tools

  When calling `addToolApprovalResponse`, the original assistant message is now updated in place instead of creating a duplicate with a new ID.

- Updated dependencies [[`68916bf`](https://github.com/cloudflare/agents/commit/68916bfa08358d4bb5d61aff37acd8dc4ffc950e), [`3f490d0`](https://github.com/cloudflare/agents/commit/3f490d045844e4884db741afbb66ca1fe65d4093)]:
  - agents@0.3.10

## 0.0.5

### Patch Changes

- [#813](https://github.com/cloudflare/agents/pull/813) [`7aebab3`](https://github.com/cloudflare/agents/commit/7aebab369d1bef6c685e05a4a3bd6627edcb87db) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#797](https://github.com/cloudflare/agents/pull/797) [`77be4f8`](https://github.com/cloudflare/agents/commit/77be4f8149e41730148a360adfff9e66becdd5ed) Thanks [@iTrooz](https://github.com/iTrooz)! - refactor(ai-chat): put SSE reply and plaintext reply logic into 2 separate functions

- [#800](https://github.com/cloudflare/agents/pull/800) [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#818](https://github.com/cloudflare/agents/pull/818) [`7c74336`](https://github.com/cloudflare/agents/commit/7c743360d7e3639e187725391b9d5c114838bd18) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#795](https://github.com/cloudflare/agents/pull/795) [`99cbca0`](https://github.com/cloudflare/agents/commit/99cbca0847d0d6c97f44b73f2eb155dabe590032) Thanks [@Jerrynh770](https://github.com/Jerrynh770)! - Fix resumable streaming to avoid delivering live chunks before resume ACK

- Updated dependencies [[`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`d1a0c2b`](https://github.com/cloudflare/agents/commit/d1a0c2b73b1119d71e120091753a6bcca0e2faa9), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`fd79481`](https://github.com/cloudflare/agents/commit/fd7948180abf066fa3d27911a83ffb4c91b3f099), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`e20da53`](https://github.com/cloudflare/agents/commit/e20da5319eb46bac6ac580edf71836b00ac6f8bb), [`f604008`](https://github.com/cloudflare/agents/commit/f604008957f136241815909319a552bad6738b58), [`7aebab3`](https://github.com/cloudflare/agents/commit/7aebab369d1bef6c685e05a4a3bd6627edcb87db), [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e), [`7c74336`](https://github.com/cloudflare/agents/commit/7c743360d7e3639e187725391b9d5c114838bd18), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`ded8d3e`](https://github.com/cloudflare/agents/commit/ded8d3e8aeba0358ebd4aecb5ba15344b5a21db1)]:
  - agents@0.3.7

## 0.0.4

### Patch Changes

- [#761](https://github.com/cloudflare/agents/pull/761) [`0e8fc1e`](https://github.com/cloudflare/agents/commit/0e8fc1e8cca3ad5acb51f5a0c92528c5b6beb358) Thanks [@iTrooz](https://github.com/iTrooz)! - Allow returning a non-streaming reponse from onChatMessage()

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
