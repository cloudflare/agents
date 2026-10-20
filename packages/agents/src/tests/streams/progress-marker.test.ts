import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StreamBenchObject } from "../capabilities/streams-bench";

/**
 * The chat recovery progress marker is derived from the stream log: durably
 * flushed segments, counted from live logs while a stream's rows exist and
 * from a retired total once they are deleted. It must move only when new
 * content lands, never when rows are merely read or removed.
 */
describe("ResumableStream.progressMarker", () => {
  it("counts flushed segments, survives cutover, reclaim and clear, and never moves on replay", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      const { marker, rowsWritten } = await instance.probeProgressMarker();

      // Opening a stream is not progress; only flushed segments are.
      expect(marker.fresh).toBe(0);
      expect(marker.opened).toBe(0);
      // 25 chunks: two packed segments landed, five are still buffered.
      expect(marker.buffered).toBe(2);
      expect(marker.flushed).toBe(3);
      // A replay reads the log; it appends nothing.
      expect(marker.replayed).toBe(3);
      // The cutover deleted the rows and retired their segments in the same
      // transaction: the marker is exactly where it was.
      expect(marker.cutOver).toBe(3);

      // The second turn's single segment settled with its row still present.
      expect(marker.completed).toBe(4);
      // start() reclaimed that row; its segment moved to the retired total.
      expect(marker.reclaimed).toBe(4);
      expect(marker.thirdFlushed).toBe(5);

      // One explicit credit (a forwarded child chunk) is one unit.
      expect(marker.credited).toBe(6);
      // Clearing history retires the live stream's segment; nothing is lost.
      expect(marker.cleared).toBe(6);

      // No per-chunk write exists: 36 chunks were stored along the way, and
      // the whole sequence — stream opens, block writes, settles, deletions
      // with their retire rows, and one credit — is a fixed count well under
      // one row per chunk.
      expect(rowsWritten).toBeLessThan(40);
    });
  });

  it("keeps the marker when a chat row is deleted through the public capability", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      const { before, after } = await instance.probePublicDelete();
      expect(before).toBe(1);
      expect(after).toBe(1);
    });
  });

  it("retires a stream once when the adapter was constructed more than once", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      const { marker } = await instance.probeReconstruction();
      // Three constructions, one cutover of a one-segment stream: the
      // earlier hooks were replaced, so the segment is retired once.
      expect(marker).toBe(1);
    });
  });

  it("does not re-seed an object that already has a progress row from the mirrored KV value", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      // Four two-segment turns across four isolates: the marker counts the
      // eight segments that landed. The 0.23-0.28 seed read
      // [2, 4, 6, 10, 12, 18, 20] here, adding the retired total once per
      // isolate.
      expect(await instance.probeMirroredSeed()).toEqual([2, 2, 4, 4, 6, 6, 8]);
    });
  });

  it("seeds an object upgraded directly from before 0.23 once", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      expect(await instance.probeDirectUpgradeSeed()).toEqual({
        needsSeed: true,
        seeded: 500,
        retired: 502,
        laterNeedsSeed: false,
        later: 502
      });
    });
  });

  it("keeps counting a legacy value an older release seeded", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      const marker = await instance.probeLegacyColumn();
      expect(marker.seeded).toBe(40);
      // Two segments retired by the cutover add to it.
      expect(marker.retired).toBe(42);
      expect(marker.credited).toBe(43);
    });
  });
});
