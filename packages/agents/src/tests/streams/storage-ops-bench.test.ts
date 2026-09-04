import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StreamBenchObject } from "../capabilities/streams-bench";

/**
 * Storage-ops accounting for the chat-on-Streams replatform. Row counts are
 * deterministic, so the assertions pin the cost *model* — the logged table
 * carries the absolute numbers for the PR body.
 *
 * Workload: 20 turns × 100 chunks × ~120-byte SSE-delta bodies.
 */
const TURNS = 20;
const CHUNKS = 100;
const BYTES = 120;

describe("Streams storage-ops benchmark", () => {
  it("packed adapter writes match the legacy pattern exactly and stay ~8× under per-chunk appends", async () => {
    const stub = env.StreamBenchObject.getByName("bench");
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      const legacy = await instance.benchLegacySimulation(TURNS, CHUNKS, BYTES);
      const adapter = await instance.benchAdapterPath(TURNS, CHUNKS, BYTES);
      const perChunk = await instance.benchPerChunkPath(TURNS, CHUNKS, BYTES);
      const sweep = await instance.benchSweepReads();

      console.log(
        `[streams-bench] ${TURNS} turns x ${CHUNKS} chunks x ~${BYTES}B\n` +
          `  legacy simulation : ${legacy.rowsWritten} rows written  ${legacy.ms.toFixed(1)}ms\n` +
          `  adapter (packed)  : ${adapter.rowsWritten} rows written  ${adapter.ms.toFixed(1)}ms\n` +
          `  per-chunk appends : ${perChunk.rowsWritten} rows written  ${perChunk.ms.toFixed(1)}ms\n` +
          `  sweep reads       : legacy=${sweep.legacyRowsRead} new=${sweep.newRowsRead}`
      );

      // The fence is a read, so the packed adapter writes exactly the
      // legacy pattern's rows per turn on the hot path: one stream-row
      // insert, one block write per 10-chunk segment, one settle update —
      // 12 for this workload. On top of that, each start() reclaims the
      // previous turn's completed stream (its one block row and its stream
      // row): the cleanup the legacy pattern deferred to a sweep of ~13
      // rows per turn, paid inline as 2. Any regression that adds a write
      // to the streaming hot path breaks this equality.
      expect(adapter.rowsWritten).toBe(legacy.rowsWritten + 2 * (TURNS - 1));
      // Packing is the point: an order of magnitude under naive per-chunk
      // (12 vs 102 rows per turn here, ~8.5×).
      expect(adapter.rowsWritten * 5).toBeLessThan(perChunk.rowsWritten);
      // The two-phase sweep reads the stream rows plus at most one indexed
      // chunk-tail row per stale live candidate; the legacy shape scanned
      // the whole chunk table through a correlated subquery.
      expect(sweep.newRowsRead).toBeLessThan(sweep.legacyRowsRead);
    });
  });
});
