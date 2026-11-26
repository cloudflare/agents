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
  it("moves the progress marker's durable part into Streams' counters, once", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      const root = await instance.probeLegacyProgressImport(false);
      expect(root).toEqual({ marker: 7, tables: [], rowsLeft: 0 });
    });
    const facetStub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(facetStub, async (instance: StreamBenchObject) => {
      const facet = await instance.probeLegacyProgressImport(true);
      expect(facet).toEqual({
        marker: 7,
        tables: ["cf_agents_chat_progress"],
        rowsLeft: 0
      });
    });
  });

  it("lets a released host construct ResumableStream over an earlier version's tables", async () => {
    // ai-chat 0.12.x and Think 0.24.x pass `{ onProgress }` where the facet
    // check now goes, and call markError and start with origin ids.
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      // The carried total (5 + 2) plus the stream's one stored unit.
      expect(await instance.probeReleasedHostAdapter()).toEqual({
        marker: 8,
        legacyTables: [],
        originIds: ["u1"],
        errored: "error"
      });
    });
  });

  it("makes no counters table until something is counted", async () => {
    const stub = env.StreamBenchObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: StreamBenchObject) => {
      expect(await instance.probeCountersTableAfterStart()).toBe(false);
    });
  });
});
