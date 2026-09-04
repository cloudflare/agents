---
"agents": minor
"@cloudflare/ai-chat": minor
"@cloudflare/think": minor
---

feat(streams): rollover block log and an atomic stream → message cutover; no more stream-buffer sweeps.

The Streams chunk log is now mutable rollover blocks: an append grows the open block row (an UPDATE) until it reaches 256 KB, then opens the next. Same one billed row per append as before, but a stream of thousands of chunks is a handful of rows to delete instead of thousands. Existing `cf_agents_stream_chunks` rows are folded into blocks on startup.

`writer.close({ commit, discard })` (and `error(reason, { … })`) settles the stream, runs the caller's synchronous writes and deletes the stream's rows in one SQLite transaction. `Session.__DO_NOT_USE_WILL_BREAK__sync().upsert()` is the matching synchronous message write; its `after()` dispatches the change feed and auto-compaction once the transaction commits.

Chat hosts (`AIChatAgent`, `Think`) now persist the finished turn's assistant message inside that cutover: the message, the stream's settlement and the deletion of its temporary rows commit together, so a crash leaves either the live stream (recovery rebuilds the message from it) or the message, never neither. `ResumableStream.start()` reclaims anything a crash left behind. The `_cleanupStreamBuffers` alarm is no longer armed (`cleanupStreamBuffers` and `STREAM_CLEANUP_DELAY_SECONDS` are removed from `agents/chat`; the host callback is kept as a no-op so alarms persisted by earlier versions still resolve).
