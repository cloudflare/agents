import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StreamBenchObject } from "../capabilities/streams-bench";

describe("legacy chat stream import", () => {
  it("drops the old tables at the root once their streams are imported", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      const { chunks, tables } = await instance.probeLegacyImport(false);
      expect(chunks).toBe(1);
      expect(tables).toEqual([]);
    });
  });

  it("empties the old tables in a facet instead of dropping them", async () => {
    // A facet that drops old indexed tables at its first start after an
    // upgrade can reset its tree's storage on a deployment; deleting the
    // rows is safe.
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      const { chunks, tables } = await instance.probeLegacyImport(true);
      expect(chunks).toBe(1);
      expect(tables).toEqual([
        "cf_ai_chat_stream_chunks",
        "cf_ai_chat_stream_metadata"
      ]);
    });
  });
});
