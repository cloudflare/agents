import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

/** Legacy ai-chat rows are lifted by the next constructor invocation. */
describe("AIChatAgent Sessions migration", () => {
  it("lifts v4 and v5 rows into one linear session and tombstones the table", async () => {
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
    expect(await stub.legacyMessageTableNamesForTest()).toEqual([
      "cf_ai_chat_agent_messages__lifted_v1"
    ]);

    await evictDurableObject(stub);

    expect(
      ((await stub.getMessagesForTest()) as UIMessage[]).map(
        (message) => message.id
      )
    ).toEqual(["legacy-v4", "legacy-v5"]);
    expect(await stub.legacyMessageTableNamesForTest()).toEqual([
      "cf_ai_chat_agent_messages__lifted_v1"
    ]);
  });
});
