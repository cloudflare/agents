import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionBenchObject } from "../capabilities/sessions";

/**
 * Storage-operation accounting for Sessions. These assertions pin the billed
 * write model: no secondary indexes or counter rows on the text append path.
 * One small attachment adds a whole-file row, one 1.5 MiB chunk row, and one
 * derived message reference.
 */
describe("Sessions storage-ops benchmark", () => {
  it("writes one row per text append and update", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      const appends = await instance.benchLinearAppends(20, 120);
      const update = await instance.benchUpdate();

      expect(appends.rowsWritten).toBe(20);
      expect(update.rowsWritten).toBe(1);
    });
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

  it("adds one reference-row write for an offloaded attachment", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      const append = await instance.benchAttachmentAppend(4096);

      expect(append.rowsWritten).toBe(4);
      expect(instance.attachmentBlobCount()).toBe(1);
    });
  });
});
