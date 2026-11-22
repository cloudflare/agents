import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkTestAgent } from "./agents/think-session";

type OutboxAccess = {
  _outbox: {
    send(
      sink: string,
      payload: unknown,
      options: { key: string }
    ): Promise<unknown>;
    list(options: { sink: string; status: string }): Promise<unknown[]>;
  };
};

async function drainOwedHooks(agent: ThinkTestAgent): Promise<void> {
  const outbox = (agent as unknown as OutboxAccess)._outbox;
  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline &&
    (await outbox.list({ sink: "__cf_think_response_hook", status: "pending" }))
      .length > 0
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("owed response hooks", () => {
  // An owed hook can fire after later turns ended. It must not replace the
  // terminal status a reconnecting client reads with its own older one.
  it("keeps a newer turn's terminal status when an older owed hook fires", async () => {
    const stub = await getAgentByName(
      env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
      `owed-terminal-${crypto.randomUUID()}`
    );
    await runInDurableObject(stub, async (agent: ThinkTestAgent) => {
      await agent.testChat("first");
      const older = (await agent.getStoredMessages())
        .filter((m) => m.role === "assistant")
        .at(-1);
      expect(older).toBeDefined();
      await agent.testChat("second");
      await agent.recordTerminalForTest(
        "newer-request",
        "the newer turn failed"
      );

      const outbox = (agent as unknown as OutboxAccess)._outbox;
      await outbox.send(
        "__cf_think_response_hook",
        {
          requestId: "older-request",
          messageId: older?.id,
          continuation: false,
          status: "error",
          error: "the older turn failed"
        },
        { key: "older-request" }
      );
      const deadline = Date.now() + 5_000;
      while (
        Date.now() < deadline &&
        (
          await outbox.list({
            sink: "__cf_think_response_hook",
            status: "pending"
          })
        ).length > 0
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(await agent.getPendingChatTerminalForTest()).toMatchObject({
        requestId: "newer-request"
      });
    });
  });

  it("retries an owed hook whose bookkeeping fails", async () => {
    const stub = await getAgentByName(
      env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
      `owed-retry-${crypto.randomUUID()}`
    );
    await runInDurableObject(stub, async (agent: ThinkTestAgent) => {
      await agent.testChat("hello");
      const reply = (await agent.getStoredMessages()).at(-1);
      const self = agent as unknown as {
        _recordTerminalChatStatus(...args: unknown[]): Promise<void>;
      };
      const original = self._recordTerminalChatStatus;
      self._recordTerminalChatStatus = async () => {
        self._recordTerminalChatStatus = original;
        throw new Error("simulated terminal-status write failure");
      };
      const before = (await agent.getResponseLog()).length;
      await (agent as unknown as OutboxAccess)._outbox.send(
        "__cf_think_response_hook",
        {
          requestId: "owed-retry",
          messageId: reply?.id,
          continuation: false,
          status: "completed"
        },
        { key: "owed-retry" }
      );
      await drainOwedHooks(agent);
      const log = await agent.getResponseLog();
      expect(log.slice(before).map((response) => response.requestId)).toEqual([
        "owed-retry"
      ]);
    });
  }, 20_000);

  it("fires an owed hook stored by an earlier release on start", async () => {
    const stub = await getAgentByName(
      env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
      `owed-legacy-${crypto.randomUUID()}`
    );
    await runInDurableObject(stub, async (agent: ThinkTestAgent, state) => {
      await agent.testChat("hello");
      const reply = (await agent.getStoredMessages()).at(-1);
      const before = (await agent.getResponseLog()).length;
      await state.storage.put("cf_think_pending_response_hook:legacy", {
        requestId: "legacy",
        messageId: reply?.id,
        continuation: false,
        status: "completed"
      });
      await (
        agent as unknown as { _releaseOwedResponseHooks(): Promise<void> }
      )._releaseOwedResponseHooks();
      await drainOwedHooks(agent);
      const log = await agent.getResponseLog();
      expect(log.slice(before)).toEqual([
        expect.objectContaining({ requestId: "legacy", recovered: true })
      ]);
      expect(
        await state.storage.get("cf_think_pending_response_hook:legacy")
      ).toBeUndefined();
    });
  });
});
