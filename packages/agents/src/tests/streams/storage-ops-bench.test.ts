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
  it("packed adapter writes stay within 2× the legacy pattern and ~10× under per-chunk appends", async () => {
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

      // The packed adapter pays at most the legacy pattern plus one fence
      // write per segment (and start() no longer pre-creates two tables).
      expect(adapter.rowsWritten).toBeLessThanOrEqual(2 * legacy.rowsWritten);
      // Packing is the point: an order of magnitude under naive per-chunk.
      expect(adapter.rowsWritten * 5).toBeLessThan(perChunk.rowsWritten);
      // The new sweep reads only stream rows; the legacy shape scanned the
      // chunk table through a correlated subquery.
      expect(sweep.newRowsRead).toBeLessThan(sweep.legacyRowsRead);
    });
  });
});
