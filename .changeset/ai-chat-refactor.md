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
