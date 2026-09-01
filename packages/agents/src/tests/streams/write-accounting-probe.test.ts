import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { StreamBenchObject } from "../capabilities/streams-bench";

/**
 * Pins the billed-write accounting model on real DO SQLite. Cloudflare
 * bills `rowsWritten`, which counts index maintenance — `total_changes()`
 * (the path-parity benchmark's metric) counts only table rows. An
 * ordinary rowid table's PRIMARY KEY is a hidden UNIQUE index, so its
 * INSERTs bill 2 rows; WITHOUT ROWID makes the PK the table and bills 1.
 * The capability tables (stream chunks, task steps/runs, jobs) are
 * WITHOUT ROWID for exactly this reason, and the `real*` assertions here
 * fail if a schema change quietly re-adds a per-write index tax to the
 * streaming hot path.
 */
it("billed writes: WITHOUT ROWID tables pay one row per insert, indexes bill per touch", async () => {
  const stub = env.StreamBenchObject.getByName("write-accounting");
  await runInDurableObject(stub, async (instance: StreamBenchObject) => {
    const probe = await instance.probeWriteAccounting();

    // The model: hidden PK index on rowid tables, +1 per explicit index
    // touched, untouched indexes are free.
    expect(probe.rowidCompositePkInsert).toBe(2);
    expect(probe.withoutRowidInsert).toBe(1);
    expect(probe.textPkPlusIndexInsert).toBe(3);
    expect(probe.updateNotTouchingIndexed).toBe(1);
    expect(probe.updateTouchingIndexed).toBe(2);

    // The real hot statements: a chunk append bills exactly one row. A
    // stream open pays its row plus the hidden PK index plus the tag
    // index — the metadata table deliberately stays a rowid table so
    // rowid keeps "newest first" deterministic within one created_at
    // millisecond, a cost paid once per stream, never per chunk. Settle
    // touches no index and bills one.
    expect(probe.realChunkAppend).toBe(1);
    expect(probe.realStreamOpen).toBe(3);
    expect(probe.realStreamSettle).toBe(1);
  });
});
