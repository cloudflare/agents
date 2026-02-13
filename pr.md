# Title

ai-chat: architecture cleanup, 6 bug fixes, storage guards, new features, docs rewrite

# Description

## TL;DR

- Modularized `AIChatAgent` -- extracted stream resumption, WebSocket transport, and message building into focused modules
- Fixed 6 bugs including `setMessages` data loss, stream resumption race condition (#896), and SQLite crashes on large tool outputs
- Added `maxPersistedMessages`, `body` option, incremental persistence, and automatic row size compaction
- Made `onFinish` optional -- framework handles cleanup automatically
- Rewrote all docs, added 180 tests (unit + React + Playwright e2e), switched examples to Workers AI

All changes are backward compatible. No public API was removed.

## Motivation

Users were hitting crashes from SQLite's 2MB row limit on large tool outputs, stream resumption had a race condition where reconnecting clients missed the resume notification (#896), and `setMessages` with a functional updater silently lost data. These bugs were difficult to isolate because the codebase had no separation of concerns -- `index.ts` was 2,286 lines with stream resumption, chunk buffering, SSE parsing, tool handling, message persistence, and the WebSocket protocol all interleaved in one class.

On the client side, `useAgentChat` created a fake `fetch` callback that assembled a `Response` object from WebSocket messages, then fed it into the AI SDK's `DefaultChatTransport` which re-parsed the SSE. Every chunk was serialized, deserialized, re-serialized, and re-deserialized.

Deprecated APIs from the v4/v5 era were mixed in with current code, with no deprecation warnings or clear boundaries. Test coverage was minimal -- no e2e tests, limited unit tests, no React hook tests. Documentation showed outdated patterns that no longer worked correctly with AI SDK v6.

## What changed

### Architecture (no behavior change)

Extracted three focused modules from the monolithic `AIChatAgent` class:

| New module             | Responsibility                                                          | Lines |
| ---------------------- | ----------------------------------------------------------------------- | ----- |
| `resumable-stream.ts`  | Chunk buffering, SQLite persistence, replay, cleanup                    | 435   |
| `ws-chat-transport.ts` | Native WebSocket `ChatTransport<UIMessage>` for the AI SDK              | 196   |
| `message-builder.ts`   | Reconstruct `UIMessage` parts from stream chunks (shared server/client) | 293   |

`index.ts` went from 2,286 to 1,727 lines. `react.tsx` went from 1,461 to ~1,310 lines. The total line count is similar but the code is now modular and testable.

### Bug fixes (6)

1. **`setMessages` functional updater data loss** -- `setMessages(prev => [...prev, msg])` sent an empty array to the server because the wrapper did not resolve the function before syncing.
2. **`_sendPlaintextReply` creating multiple text parts** -- each network chunk became a separate `text` part in the message instead of accumulating into one.
3. **Uncaught exception on empty request body** -- `JSON.parse(undefined)` threw an uncaught `SyntaxError` when clients sent malformed requests.
4. **`CF_AGENT_MESSAGE_UPDATED` not broadcast for streaming messages** -- tool results applied during an active stream were silently swallowed instead of being broadcast to other connections.
5. **Stream resumption race condition (#896)** -- server sent `CF_AGENT_STREAM_RESUMING` in `onConnect` before the client's message handler was registered, causing missed resume notifications. Fixed with a client-initiated `CF_AGENT_STREAM_RESUME_REQUEST` protocol and a `replay` flag on buffered chunks.
6. **Typo** -- `"recieved"` -> `"received"` in error message.

### New features

- **`maxPersistedMessages`** -- cap SQLite message count. Oldest messages are deleted after each persist. Default: unlimited (backward compatible).
- **`body` option on `useAgentChat`** -- send custom data with every request. Accepts static objects or functions (sync/async). Available in `onChatMessage` via `options.body`.
- **Incremental persistence** -- hash-based cache skips SQL writes for unchanged messages. Populated from SQLite on load, survives hibernation.
- **Row size guard** -- automatic two-pass compaction when messages approach SQLite's 2MB row limit. Compacts tool outputs first, then text parts. Adds metadata (`compactedToolOutputs`/`compactedTextParts`) so clients can detect compaction. LLM-friendly truncation text instructs the model to suggest re-running the tool.
- **Stream chunk guard** -- `ResumableStream` skips storing chunks over 1.8MB (still broadcast to live clients, just not persisted for replay).
- **`onFinish` made optional** -- abort controller cleanup and observability emit moved from the user-provided `onFinish` callback into the framework's stream completion handler. The simpler pattern now works:
  ```typescript
  async onChatMessage() {
    const result = streamText({ ... });
    return result.toUIMessageStreamResponse();
  }
  ```

### Deprecations

All deprecated APIs now emit a one-time `console.warn` on first use, have `@deprecated` JSDoc, and are marked with `// -- DEPRECATED --` section banners. Removal planned for next major.

**Server:** `createToolsFromClientSchemas()`
**Client:** `extractClientToolSchemas()`, `detectToolsRequiringConfirmation()`, `tools`, `toolsRequiringConfirmation`, `experimental_automaticToolResolution`, `autoSendAfterAllConfirmationsResolved`, `addToolResult()`
**Migration:** `migrateToUIMessage()`, `migrateMessagesToUIFormat()`, `needsMigration()`, `analyzeCorruption()`

### Docs

- **New `docs/chat-agents.md`** -- comprehensive reference for `AIChatAgent` and `useAgentChat` (673 lines). Covers server API, client API, all three tool patterns, custom request data, resumable streaming, storage management, multiple AI providers, multi-client sync, and the WebSocket protocol.
- **Rewritten `README.md`** -- correct patterns, Workers AI examples, no `onFinish` boilerplate.
- **Rewritten `human-in-the-loop.md`** -- modern `needsApproval` + `onToolCall` patterns.
- **Rewritten `client-tools-continuation.md`** -- `autoContinueAfterToolResult` with Workers AI.
- **Updated `resumable-streaming.md`** -- accuracy fixes, new protocol details, back-links.
- **Tightened migration guides** -- v5 guide: 392 -> 97 lines. v6 guide: 363 -> 148 lines.
- **Updated `index.md`** -- moved resumable streaming to AI Integration section, removed TODO marker for chat-agents.

### Examples

- **New `examples/ai-chat/`** -- showcases all recommended patterns: server tools, client tools (`onToolCall`), tool approval (`needsApproval`), `pruneMessages`, `maxPersistedMessages`, `body` option, Workers AI.
- **All examples and guides switched to Workers AI** with `@cf/openai/gpt-oss-120b` (no API key needed).
- **`examples/resumable-stream-chat/`** -- updated to `toUIMessageStreamResponse()`, fixed CSS `@source` path.
- **`guides/human-in-the-loop/`** -- rewritten to modern patterns.
- **Lint fixes across `examples/playground/`** -- memoized callbacks to fix exhaustive-deps warnings in `ChatRoomsDemo`, `SupervisorDemo`, `SqlDemo`, `ScheduleDemo`.

### Tests

| Suite                  | Tests   |
| ---------------------- | ------- |
| Workers (vitest)       | 148     |
| React (vitest-browser) | 19      |
| E2E (Playwright)       | 32      |
| **Total**              | **180** |

Notable additions:

- `message-builder.test.ts` (30 tests) -- full chunk type coverage including tool streaming lifecycle
- `row-size-guard.test.ts` (9 tests) -- incremental persistence, compaction, chunk guard
- `max-persisted-messages.test.ts` (5 tests) -- storage cap enforcement
- `onfinish-cleanup.test.ts` (5 tests) -- abort controller cleanup without user `onFinish`
- E2E: 3MB message compaction, multi-tab tool streaming, client tool round-trip with auto-continuation, stream resumption
- React: `body` option, re-render stability, `clearHistory`, `onToolCall`

**Not yet tested:** `useAgentChat` hook decomposition is deferred (see below), so the React tests cover the hook as a single unit. The new `body` option and `onToolCall` type fix are covered by React tests. The deprecated code paths (`tools`, `experimental_automaticToolResolution`) are exercised by unit tests but do not have dedicated React tests since they are slated for removal.

## Design decisions

### Why extract modules instead of rewriting from scratch?

The existing behavior is battle-tested in production. A full rewrite would risk subtle regressions in the WebSocket protocol, hibernation recovery, and stream resumption. Instead, we extracted code into modules with clear interfaces while preserving the exact same behavior. Every extraction was verified by the new test suite.

### Why a native WebSocket ChatTransport?

The old approach created a fake `Response` object from WebSocket messages so it could use the AI SDK's HTTP-based `DefaultChatTransport`. This meant every chunk was serialized to SSE, wrapped in a Response, then re-parsed from SSE. The new `WebSocketChatTransport` implements `ChatTransport<UIMessage>` directly, returning a `ReadableStream<UIMessageChunk>` from WebSocket events. No fake fetch, no double serialization.

### Why compaction instead of splitting messages across rows?

SQLite rows have a 2MB hard limit. We considered splitting large messages across multiple rows, but this would have complicated every query, broken hibernation wake-up (which loads all messages), and created consistency risks. Instead, we compact in-place: large tool outputs are replaced with an LLM-friendly summary, and the metadata preserves what was compacted. The LLM still gets useful context ("this tool returned a large result that was compacted -- suggest re-running it"), and the UX degrades gracefully rather than crashing.

### Why not remove deprecated APIs now?

Users are actively using the v4/v5 patterns (`tools`, `toolsRequiringConfirmation`, `experimental_automaticToolResolution`). Removing them would be a breaking change. Instead, we added `console.warn` on first use, `@deprecated` JSDoc, and clear section banners. The migration path is documented in `migration-to-ai-sdk-v6.md`. Removal happens in the next major.

### Why keep `onFinish` in the signature at all?

Even though framework cleanup is now automatic, users may still want `onFinish` for their own logic (logging, analytics, side effects). Making it optional rather than removing it preserves that escape hatch without forcing everyone to use it.

### Why one large PR instead of a series of smaller ones?

The architecture extraction, bug fixes, and new features are interconnected. For example, the row size guard depends on incremental persistence, which depends on the extracted `ResumableStream` class. The stream resumption race fix touches both `index.ts` and `react.tsx`. Splitting these into separate PRs would have created intermediate states where the code compiled but had subtle inconsistencies. The "Notes for reviewers" section below suggests a review order that makes the diff manageable.

## Notes for reviewers

**Suggested review order:**

1. **Start with the three new extracted modules** -- they are self-contained and easy to review in isolation:
   - `packages/ai-chat/src/resumable-stream.ts` -- stream chunk management
   - `packages/ai-chat/src/ws-chat-transport.ts` -- WebSocket transport
   - `packages/ai-chat/src/message-builder.ts` -- shared chunk-to-parts logic

2. **Then review `index.ts`** -- the diff is large but mostly deletions from the extraction above. The remaining new code is: incremental persistence cache, row size guard, `onFinish` cleanup move, and `body` option plumbing.

3. **Then review `react.tsx`** -- changes are in distinct sections:
   - `WebSocketChatTransport` usage (replaces `aiFetch`)
   - `body` option merging in `prepareBody`
   - `toolsRequiringConfirmation` memoized with `useMemo`
   - `onToolCall` type fix (omit from `UseChatParams` to avoid union)
   - Deprecation warnings gated behind option usage checks

4. **Then docs, examples, tests** -- these are straightforward to skim.

**Other notes:**

- **The e2e tests use Workers AI** (`@cf/openai/gpt-oss-120b`) -- no API key needed. The only OpenAI usage is `BadKeyAgent` which intentionally tests error handling with an invalid key.

- **All changes are backward compatible.** No public API was removed. New features (`maxPersistedMessages`, `body`, incremental persistence, row size guard) are opt-in or automatic with no behavior change for existing users.

- **The playground lint fixes** (`ChatRoomsDemo`, `SupervisorDemo`, `SqlDemo`, `ScheduleDemo`, `useLogs`) are unrelated to ai-chat but fix pre-existing exhaustive-deps warnings that showed up in `npm run check`.

## Deferred

These were considered during the refactor but intentionally left for follow-up work:

- **Decompose `useAgentChat` into smaller hooks.** The hook is ~900 lines with tool resolution, stream resumption, message sync, and transport setup all in one function. It should be split into composable hooks (`useStreamResumption`, `useToolResolution`, etc.), but doing so in this PR would have made the diff even larger and harder to review.

- **Remove deprecated APIs.** The v4/v5 client tool patterns (`tools`, `toolsRequiringConfirmation`, `experimental_automaticToolResolution`, `addToolResult`, etc.) are still used by existing apps. This PR adds deprecation warnings and JSDoc; actual removal happens in the next major version.

- **Revisit constructor monkey-patching.** `AIChatAgent` wraps lifecycle methods (`onConnect`, `onClose`, `onMessage`) in the constructor so users do not have to call `super`. This is a deliberate DX choice but makes the class harder to reason about. A middleware/hook pattern would be cleaner, but changing it is a breaking API change.

- **WebSocket-based initial messages.** Currently, `useAgentChat` fetches initial messages via an HTTP `GET /get-messages` endpoint, which requires a Suspense boundary. Sending them over the existing WebSocket connection would eliminate the HTTP call and simplify the client setup, but the interaction with React Suspense (the socket unmounts during suspend) needs careful design.
