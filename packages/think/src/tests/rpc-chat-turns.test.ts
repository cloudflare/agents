import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkTestAgent } from "./agents";

type RpcChatTestStub = {
  rpcChatWhileQueuedForTest(action: "cancel" | "clear"): Promise<{
    userTexts: string[];
    steps: number;
    done: boolean;
    error: string | null;
    events: number;
  }>;
  rpcChatClearedWhileStreamingForTest(): Promise<{
    messages: number;
    done: boolean;
    error: string | null;
  }>;
};

async function freshAgent(): Promise<RpcChatTestStub> {
  return getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    crypto.randomUUID()
  ) as unknown as Promise<RpcChatTestStub>;
}

const CLEARED = "The chat was cleared before the turn finished.";

// Replays of ChatRpc.tla: an RPC chat() turn meets a cancel or a clear.
describe("Think.chat() admission", () => {
  it("never runs a request its caller cancelled while it waited in the queue", async () => {
    const agent = await freshAgent();
    const result = await agent.rpcChatWhileQueuedForTest("cancel");
    // The message was not stored and the model ran for the first turn only.
    expect(result.userTexts).toEqual(["active turn"]);
    expect(result.steps).toBe(1);
    // The caller cancelled it, so the callback gets no terminal call.
    expect(result).toMatchObject({ done: false, error: null, events: 0 });
  });

  it("tells the caller when the chat is cleared while its request waits in the queue", async () => {
    const agent = await freshAgent();
    const result = await agent.rpcChatWhileQueuedForTest("clear");
    expect(result.userTexts).toEqual([]);
    expect(result).toMatchObject({ done: false, error: CLEARED, events: 0 });
  });

  it("stores nothing in a chat cleared while the reply streams, and tells the caller", async () => {
    const agent = await freshAgent();
    const result = await agent.rpcChatClearedWhileStreamingForTest();
    expect(result).toEqual({ messages: 0, done: false, error: CLEARED });
  });
});
