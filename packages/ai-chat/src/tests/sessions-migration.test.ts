import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

/** Legacy ai-chat rows are lifted by the next constructor invocation. */
describe("AIChatAgent Sessions migration", () => {
  it("lifts v4 and v5 rows into one linear session and drops the table", async () => {
    const stub = await getAgentByName(
      env.TestChatAgent,
      `sessions-migration-${crypto.randomUUID()}`
    );
    await stub.seedLegacyMessagesForTest();

    await evictDurableObject(stub);

    const restored = (await stub.getMessagesForTest()) as UIMessage[];
    expect(restored.map((message) => message.id)).toEqual([
      "legacy-v4",
      "legacy-v5"
    ]);
    expect(restored[0].parts).toEqual([{ type: "text", text: "old format" }]);
    expect(restored[1].parts).toEqual([{ type: "text", text: "new format" }]);
    // The source is dropped, not renamed: a tombstone would leave the object
    // holding its whole transcript twice.
    expect(await stub.legacyMessageTableNamesForTest()).toEqual([]);

    await evictDurableObject(stub);

    expect(
      ((await stub.getMessagesForTest()) as UIMessage[]).map(
        (message) => message.id
      )
    ).toEqual(["legacy-v4", "legacy-v5"]);
    expect(await stub.legacyMessageTableNamesForTest()).toEqual([]);
  });
});
