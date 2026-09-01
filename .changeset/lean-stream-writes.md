---
"agents": patch
---

Cut storage row writes across Streams, the chat adapter, and Tasks — the streaming hot path now writes exactly what the pre-capability chat pattern wrote.

Streams: the append fence is a read instead of a guarded UPDATE (a Durable Object executes one synchronous block at a time, so state-check + tail-read + INSERT is exactly as atomic), removing one stream-row write per append. The stream row is written only at open and settle; settlement stamps the final cursor, and live cursors/liveness derive from the chunk log's tail. `readBatches` termination and the reader liveness checks moved to narrow reads.

Chat adapter: the retention sweep decides abandonment in two phases (coarse row cutoff, then one indexed chunk-tail read per candidate) so an actively appending stream is never swept; the legacy migration imports rows complete (final count and last-activity stamped up front, chunk imports are bare INSERTs — 1+N writes instead of 1+2N); `destroy()` no longer flushes chunks it deletes in the same call; the cleanup alarm no longer scans the table twice; dead `_segmentIndex` state removed.

Tasks: claim refreshes amortize to one row write per half claim-slack of wall time instead of one per step; already-elapsed sleeps journal born-completed in one INSERT; duplicate status messages skip their write; startup reconcile skips job-queue upserts that already match; a parked-run cancel settles in one row write; settle paths only re-sync the wake mirror when their write actually landed.

Replay memory is bounded: the chat adapter's chunk replay iterates the stored log in pages (a generator over paged reads) instead of materializing the whole turn per reconnecting client.

Schema: the hot-write capability tables (stream chunks, task runs, task steps, jobs — none released) are now WITHOUT ROWID. Cloudflare bills index maintenance as rows written, and an ordinary rowid table's PRIMARY KEY is a hidden UNIQUE index — so every chunk append was billing 2 rows despite being one table write. WITHOUT ROWID makes it exactly 1. The stream metadata table deliberately stays a rowid table: rowid is the insertion-order tiebreak that keeps newest-first deterministic for same-millisecond rows, at one billed row per stream open. The task runs table also drops its `(state, next_at)` index, which taxed every claim/refresh/settle write to speed one startup scan.

The in-suite storage-ops benchmark now pins adapter/legacy write parity exactly (12 table rows per 100-chunk turn, ~8.5× under naive per-chunk appends), models the two-phase sweep, and a write-accounting test pins the billed model per statement (a 100-chunk turn bills 14 rows vs the legacy schema's 33).
