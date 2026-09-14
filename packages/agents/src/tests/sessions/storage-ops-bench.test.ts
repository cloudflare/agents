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
      // row, and no FTS row because nothing has searched.
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

  it("checks the auto-compaction threshold without re-walking the path", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      // The first append derives the path total with one walk; every later
      // tail append extends it in place. Without the memo each append pays a
      // sized path walk, so 200 appends read O(200^2) rows.
      const appends = await instance.benchThresholdAppends(200, 120);
      expect(appends.rowsRead).toBeLessThan(200 * 6);
    });
  });

  it("adds an FTS delete and insert per changed row once the index exists", async () => {
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

  it("reads the newest window, not the transcript, to find a tool call's owner", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      const lookup = await instance.benchOwnerLookup(200);
      expect(lookup.found).toBe("bench-197");
      // A full read pays the sized path walk — several billed rows per
      // message for the byte subqueries — and then hydrates every row. The
      // newest-first read follows parent pointers from the leaf and stops at
      // the owner, three rows in, so its cost has no transcript term at all:
      // the rows it read, plus the compactions probe and the leaf lookup.
      expect(lookup.fullRead).toBeGreaterThan(1000);
      expect(lookup.newestFirst).toBeLessThan(12);
    });
  });

  it("keeps the owner lookup lazy on a compacted session until it reaches the span", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      // The overlay covers the first 150 rows; the owner sits after it, so
      // the walk never reaches the span and costs the same as without one.
      const recent = await instance.benchOwnerLookup(200, {
        compactedPrefix: 150
      });
      expect(recent.found).toBe("bench-197");
      expect(recent.newestFirst).toBeLessThan(12);
    });

    const hiddenStub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      hiddenStub,
      async (instance: SessionBenchObject) => {
        // An owner inside the compacted span is hidden behind the overlay in
        // either direction. The walk reaches the span's end, plans the prefix
        // by id (one row per step, no byte subqueries) and stops at the
        // overlay: bounded well under the full read, which pays the sized walk
        // and hydrates everything.
        const hidden = await instance.benchOwnerLookup(200, {
          ownerFromLeaf: 100,
          compactedPrefix: 150
        });
        expect(hidden.found).toBeNull();
        expect(hidden.newestFirst).toBeLessThan(hidden.fullRead / 2);
      }
    );
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
