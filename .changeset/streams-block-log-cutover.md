---
"agents": minor
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

feat(streams): rollover block log and an atomic stream → message cutover.

The Streams chunk log is now mutable rollover blocks: an append grows the open block row (an UPDATE) until it reaches 256 KB, then opens the next. Same one billed row per append as before, but a stream of thousands of chunks is a handful of rows to delete instead of thousands. Existing `cf_agents_stream_chunks` rows are folded into blocks on startup.

`writer.close({ commit, discard })` (and `error(reason, { … })`) settles the stream, runs the caller's synchronous writes and deletes the stream's rows in one SQLite transaction, so a finished message and the discard of its temporary log commit together or not at all. `Session.__DO_NOT_USE_WILL_BREAK__sync().upsert()` is the matching synchronous message write.

`ResumableStream.complete(streamId, { persist })` exposes the cutover to chat hosts, `discardCompleted()` drops a completed stream's rows once its message is persisted, and `start()` reclaims completed streams a crash left behind — AIChatAgent and Think now discard right after persisting, so the retention sweep no longer has completed streams to find.
