import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  Measurement,
  SqliteStrategiesBench,
  Strategy,
  Workload
} from "../capabilities/sqlite-strategies-bench";

/**
 * Experimental: temporary stream blocks in DO SQLite → atomic cutover to
 * a session message → delete the blocks. Compares three block shapes on
 * billed rows, write time, page growth, replay, and the cursor a restart
 * recovers. Numbers are logged; only the invariants are asserted.
 */

const STRATEGIES: Strategy[] = ["packed", "slots", "rollover"];

// flushEvery is what a 1 s time-based flush produces at the workload's
// token rate (chat ~20 chunks/s); the 10-chunk row is today's packing.
const WORKLOADS: Workload[] = [
  {
    name: "W1 chat 400x70B pack10",
    chunks: 400,
    bytesPerChunk: 70,
    flushEvery: 10
  },
  {
    name: "W1 chat 400x70B pack20",
    chunks: 400,
    bytesPerChunk: 70,
    flushEvery: 20
  },
  {
    name: "W2 long 2000x70B pack20",
    chunks: 2000,
    bytesPerChunk: 70,
    flushEvery: 20
  },
  {
    name: "W3 huge 20000x70B pack20",
    chunks: 20000,
    bytesPerChunk: 70,
    flushEvery: 20
  }
];

function table(rows: Measurement[]): string {
  const cols: [string, (m: Measurement) => string | number][] = [
    ["strategy", (m) => m.strategy],
    ["workload", (m) => m.workload],
    ["rows W", (m) => m.rowsWritten],
    ["rows R", (m) => m.rowsRead],
    ["write ms", (m) => m.writeMs],
    ["cutover W", (m) => m.cutoverRowsWritten],
    ["cutover ms", (m) => m.cutoverMs],
    ["db +KB", (m) => Math.round(m.dbGrowthBytes / 1024)],
    ["peak +KB", (m) => Math.round(m.dbPeakGrowthBytes / 1024)],
    ["replay ms", (m) => m.replayMs],
    ["replay R", (m) => m.replayRowsRead],
    ["kill@", (m) => m.killAt],
    ["recovered", (m) => m.recoveredCursor]
  ];
  const lines = [cols.map((c) => c[0]).join(" | ")];
  for (const m of rows)
    lines.push(cols.map((c) => String(c[1](m))).join(" | "));
  return lines.join("\n");
}

describe("SQLite block strategies (experimental bench)", () => {
  it("packed rows vs generational slots vs mutable rollover blocks", async () => {
    const results: Measurement[] = [];
    for (const strategy of STRATEGIES) {
      const stub = env.SqliteStrategiesBench.getByName(`bench-${strategy}`);
      await runInDurableObject(
        stub,
        async (instance: SqliteStrategiesBench) => {
          await instance.wipe();
          for (const workload of WORKLOADS) {
            const killAt = Math.floor(workload.chunks * 0.6) + 3; // mid-flush
            const m = await instance.run(strategy, workload, killAt);
            results.push(m);
            // Invariants every strategy must hold.
            expect(m.replayChunks).toBe(workload.chunks);
            // A restart recovers exactly the flushed prefix, never more.
            const flushedBefore =
              Math.floor(killAt / workload.flushEvery) * workload.flushEvery;
            expect(m.recoveredCursor).toBe(flushedBefore);
          }
        }
      );
    }
    console.log(`\n${table(results)}\n`);
  }, 120_000);
});
