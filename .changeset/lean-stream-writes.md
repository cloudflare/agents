---
"agents": patch
---

Cut storage row writes across Streams, the chat adapter, and Tasks — the streaming hot path now writes exactly what the pre-capability chat pattern wrote.

Streams: the append fence is a read instead of a guarded UPDATE (a Durable Object executes one synchronous block at a time, so state-check + tail-read + INSERT is exactly as atomic), removing one stream-row write per append. The stream row is written only at open and settle; settlement stamps the final cursor, and live cursors/liveness derive from the chunk log's tail. `readBatches` termination and the reader liveness checks moved to narrow reads.

Chat adapter: the retention sweep decides abandonment in two phases (coarse row cutoff, then one indexed chunk-tail read per candidate) so an actively appending stream is never swept; the legacy migration imports rows complete (final count and last-activity stamped up front, chunk imports are bare INSERTs — 1+N writes instead of 1+2N); `destroy()` no longer flushes chunks it deletes in the same call; the cleanup alarm no longer scans the table twice; dead `_segmentIndex` state removed.

Tasks: claim refreshes amortize to one row write per half claim-slack of wall time instead of one per step; already-elapsed sleeps journal born-completed in one INSERT; duplicate status messages skip their write; startup reconcile skips job-queue upserts that already match; a parked-run cancel settles in one row write; settle paths only re-sync the wake mirror when their write actually landed.

The in-suite storage-ops benchmark now pins adapter/legacy write parity exactly (12 rows per 100-chunk turn, ~8.5× under naive per-chunk appends) and models the two-phase sweep.
