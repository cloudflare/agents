---
"@cloudflare/ai-chat": minor
---

Refactor AIChatAgent: extract ResumableStream class, add WebSocket ChatTransport, simplify SSE parsing.

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
