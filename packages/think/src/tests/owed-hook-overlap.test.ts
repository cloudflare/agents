import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkAsyncHookTestAgent } from "./agents/think-session";

type OutboxAccess = {
  _outbox: {
    send(
      sink: string,
      payload: unknown,
      options: { key: string }
    ): Promise<unknown>;
  };
};

describe("owed response hooks", () => {
  // The Outbox fires an owed hook from the alarm, so it can run while a live
  // turn's `onChatResponse` is running. Both must reach the app.
  it("fires onChatResponse for a live turn and for an owed hook that overlap", async () => {
    const stub = await getAgentByName(
      env.ThinkAsyncHookTestAgent as unknown as DurableObjectNamespace<ThinkAsyncHookTestAgent>,
      `owed-overlap-${crypto.randomUUID()}`
    );
    await runInDurableObject(stub, async (agent: ThinkAsyncHookTestAgent) => {
      await agent.setHookDelay(400);
      await agent.testChat("first");
      const assistant = (await agent.getStoredMessages())
        .filter((m) => m.role === "assistant")
        .at(-1);
      expect(assistant).toBeDefined();
      // What start releases for a turn a reset left owing its hook.
      await (agent as unknown as OutboxAccess)._outbox.send(
        "__cf_think_response_hook",
        {
          requestId: "owed-request",
          messageId: assistant?.id,
          continuation: false,
          status: "completed"
        },
        { key: "owed-request" }
      );
      // Start the live turn while the owed hook is still running.
      const deadline = Date.now() + 5_000;
      while (
        Date.now() < deadline &&
        (await agent.getHookConcurrencyForTest()).running === 0
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await agent.testChat("second");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const log = await agent.getResponseLog();
      expect((await agent.getHookConcurrencyForTest()).most).toBe(2);
      expect(log).toHaveLength(3);
      expect(log.map((response) => response.requestId)).toContain(
        "owed-request"
      );
    });
  });
});
