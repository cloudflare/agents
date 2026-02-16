---
"@cloudflare/ai-chat": patch
---

Add support for `data-*` stream parts (developer-defined typed JSON blobs) in the shared message builder and client hook.

**Data part handling:**

`applyChunkToParts` now handles `data-*` prefixed chunk types, covering both server persistence and client reconstruction (stream resume, cross-tab broadcast). Transient parts (`transient: true`) are broadcast to connected clients but excluded from `message.parts` and SQLite persistence. Non-transient parts support reconciliation by type+id — a second chunk with the same type and id updates the existing part's data in-place instead of appending a duplicate.

**`onData` callback forwarding:**

`useAgentChat` now invokes the `onData` callback for `data-*` chunks on the stream resumption and cross-tab broadcast codepaths, which bypass the AI SDK's internal pipeline. For new messages sent via the transport, the AI SDK already invokes `onData` internally. This is the correct way to consume transient data parts on the client since they are not added to `message.parts`.
