/**
 * Wake-driven chat recovery after forced Durable Object eviction.
 *
 * This explicitly tears down a running test actor, then routes back through
 * partyserver so the normal startup wrapper discovers the persisted fiber. It
 * does not assert natural idle hibernation or hibernation eligibility.
 */
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

async function recoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function seedInterruptedContinueTurn(
  agent: Awaited<ReturnType<typeof recoveryAgent>>
): Promise<void> {
  const requestId = "req-forced-eviction";
  const userId = "user-forced-eviction";
  const assistantId = "assistant-forced-eviction";

  await agent.persistTestMessage({
    id: userId,
    role: "user",
    parts: [{ type: "text", text: "answer this" }]
  });
  await agent.persistTestMessage({
    id: assistantId,
    role: "assistant",
    parts: [{ type: "text", text: "Partial answer" }]
  });
  await agent.insertInterruptedStream(`stream-${requestId}`, requestId, [
    {
      body: JSON.stringify({ type: "start", messageId: assistantId }),
      index: 0
    },
    { body: JSON.stringify({ type: "text-start" }), index: 1 },
    {
      body: JSON.stringify({ type: "text-delta", delta: "Partial answer" }),
      index: 2
    }
  ]);
  await agent.insertInterruptedFiber(`__cf_internal_chat_turn:${requestId}`, {
    __cfThinkChatFiberSnapshot: {
      kind: "think-chat-turn",
      version: 1,
      requestId,
      continuation: false,
      latestMessageId: assistantId,
      latestMessageRole: "assistant",
      latestUserMessageId: userId,
      startedAt: Date.now()
    },
    user: null
  });
}

describe("Think chat recovery after forced Durable Object eviction", () => {
  it("startup schedules and executes one continuation from durable state", async () => {
    const name = `evict-recovery-${crypto.randomUUID()}`;
    let agent = await recoveryAgent(name);
    await seedInterruptedContinueTurn(agent);

    expect(await agent.getActiveFibers()).toHaveLength(1);
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(0);

    await evictDurableObject(agent as unknown as DurableObjectStub);

    agent = await recoveryAgent(name);

    // The zero-delay schedule may execute as soon as startup releases the DO,
    // so observe the real alarm path instead of manually invoking its callback.
    await waitFor(async () => (await agent.getTurnCallCount()) === 1);
    await waitFor(async () => (await agent.getActiveFibers()).length === 0);

    // Let any duplicate zero-delay alarm surface before pinning exactly-once.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await agent.getTurnCallCount()).toBe(1);
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(0);
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.at(-1)?.role).toBe("assistant");
    expect(JSON.stringify(messages.at(-1)?.parts)).toContain(
      "Continued response."
    );
  });
});
