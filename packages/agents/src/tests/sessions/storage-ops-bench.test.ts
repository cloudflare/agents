import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  SessionBenchObject,
  SessionSearchHarnessObject
} from "../capabilities/sessions";

/**
 * Billed-row accounting for Sessions. Every number here is the sum of
 * `rowsWritten` over every cursor the measured window produced — the unit a
 * Durable Object is actually billed for, not `total_changes()`. Rows written
 * cost ~1000x rows read, so these are pinned exactly: a regression that adds
 * an index, a counter row, or a second UPDATE shows up as a changed number.
 */
describe("Sessions storage-ops benchmark", () => {
  it("writes one row per text append and one per changed update", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      // 20 appends x (1 message row) = 20. No secondary index, no counter
      // row, and no FTS row with search indexing off.
      const appends = await instance.benchLinearAppends(20, 120);
      expect(appends.rowsWritten).toBe(20);

      // An update whose serialized row is byte-identical writes nothing:
      // no row, no reference diff, no event.
      const noop = await instance.benchNoOpUpdate(
        "bench-18",
        `18:${"x".repeat(120)}`
      );
      expect(noop.rowsWritten).toBe(0);

      // A changed update rewrites exactly the one message row.
      const update = await instance.benchUpdate();
      expect(update.rowsWritten).toBe(1);
    });
  });

  it("adds an FTS delete and insert per changed row when indexing is on", async () => {
    const stub = env.SessionSearchHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: SessionSearchHarnessObject) => {
        const billed = await instance.benchIndexedWrites();
        // Message row + one FTS insert.
        expect(billed.append).toBe(2);
        // Message row + FTS delete + FTS insert.
        expect(billed.update).toBe(3);
      }
    );
  });

  it("bulk-deletes a linear prefix with one boundary rewrite", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      const deleted = await instance.benchDeleteLinearPrefix(20);

      // Nineteen deletes plus one surviving boundary-child update. The old
      // per-message splice loop rewrote a child for every deleted row.
      expect(deleted.rowsWritten).toBe(20);
    });
  });

  it("bills one row for a payload the message row can hold", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      // The payload stays in the row. Billing counts ROWS, not bytes: a
      // 200 KB row and a 40-byte row both cost one.
      const append = await instance.benchAttachmentAppend(200 * 1024);

      expect(append.rowsWritten).toBe(1);
      expect(instance.attachmentBlobCount()).toBe(0);
      expect(instance.attachmentChunkCount()).toBe(0);
    });
  });

  it("bills four rows when the row cannot hold the payload", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      const append = await instance.benchAttachmentAppend(2 * 1024 * 1024);

      // Message row + attachment reference row + whole-file blob row + two
      // 1.5 MiB chunk rows = 5. Chunking never reclaims space, so this cost
      // is only ever paid to make an over-budget row fit.
      expect(append.rowsWritten).toBe(5);
      expect(instance.attachmentBlobCount()).toBe(1);
      expect(instance.attachmentChunkCount()).toBe(2);
    });
  });
});
