import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionBenchObject } from "../capabilities/sessions";

/**
 * Storage-operation accounting for Sessions. These assertions pin the billed
 * write model: no secondary indexes or counter rows on the text append path,
 * and one derived reference row for a message with one attachment.
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

  it("adds one reference-row write for an offloaded attachment", async () => {
    const stub = env.SessionBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionBenchObject) => {
      const append = await instance.benchAttachmentAppend(4096);

      expect(append.rowsWritten).toBe(2);
      expect(instance.attachmentStore.writes).toBe(1);
    });
  });
});
