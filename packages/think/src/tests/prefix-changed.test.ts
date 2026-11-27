import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { subscribe } from "agents/observability";
import { describe, expect, it } from "vitest";

type PrefixStub = {
  addLateTool(): Promise<void>;
  say(text: string): Promise<void>;
  lastText(): Promise<string>;
};

describe("harness-backed Think: chat:prefix:changed", () => {
  it("emits once when the tools a turn sends change", async () => {
    const payloads: unknown[] = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:prefix:changed") payloads.push(event.payload);
    });
    try {
      const agent = (await getAgentByName(
        env.ThinkPrefixChangedAgent,
        crypto.randomUUID()
      )) as unknown as PrefixStub;
      await agent.say("hello");
      // The turn answered, on AI SDK 6 as on 7.
      expect(await agent.lastText()).toBe("ok");
      await agent.say("again");
      expect(payloads).toEqual([]);
      await agent.addLateTool();
      await agent.say("tools");
      await agent.say("steady");
      expect(payloads).toEqual([
        {
          session: expect.any(String),
          requestId: expect.any(String),
          causes: [{ kind: "tools", added: ["late"], removed: [], changed: [] }]
        }
      ]);
    } finally {
      unsubscribe();
    }
  });
});
