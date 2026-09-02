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

  it("bills a message row plus the attachment rows for inline media", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      // A 200 KB image costs four rows, not one: the message row, one payload
      // chunk, its metadata, and the reference that keeps it alive. That is
      // the real price of keeping media out of the message, and it is paid on
      // every media write — the message row in exchange stays a few hundred
      // bytes however large the image is.
      const append = await instance.benchPayloadAppend(200 * 1024);

      expect(append.rowsWritten).toBe(4);
      expect(instance.continuationRowCount("bench-payload")).toBe(0);
    });
  });

  it("bills one extra row per payload chunk, and never splits the message", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      // 2 MiB of payload spans the 1.5 MiB window twice, so it costs five
      // rows: the message, two payload chunks, metadata, and one reference.
      // The message row itself never chunks — the bytes left before it was
      // measured.
      const append = await instance.benchPayloadAppend(2 * 1024 * 1024);

      expect(append.rowsWritten).toBe(5);
      expect(instance.continuationRowCount("bench-payload")).toBe(0);
    });
  });
});
