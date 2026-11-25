/**
 * A reply left with nothing a client can show and nothing a model request
 * can carry is not stored, and one that is stored is removed. The usual way
 * to get one: the reply is cut off while the model is still reasoning, and
 * the reasoning a reply ends in is never kept.
 */
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

async function recoveryAgent(name = `empty-reply-${crypto.randomUUID()}`) {
  return getAgentByName(
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

/**
 * Evict the agent with an interrupted turn seeded, and let its wake recover
 * the turn: the stored chunks become the partial reply, then recovery runs.
 */
async function recoverAfterEviction(
  chunks: Array<Record<string, unknown>>
): Promise<UIMessage[]> {
  const name = `empty-reply-${crypto.randomUUID()}`;
  let agent = await recoveryAgent(name);
  await seedInterruptedTurn(agent, chunks);
  await evictDurableObject(agent as unknown as DurableObjectStub);
  agent = await recoveryAgent(name);
  await waitFor(async () => (await agent.getTurnCallCount()) === 1);
  await waitFor(async () => (await agent.getActiveFibers()).length === 0);
  return (await agent.getStoredMessages()) as UIMessage[];
}

const question: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Think about it" }]
};

/** Cut off in its reasoning and stored as it was, as an older version did. */
const reasoningOnly = {
  id: "assistant-reasoning",
  role: "assistant",
  parts: [
    { type: "step-start" },
    { type: "reasoning", text: "Let me think", state: "streaming" }
  ]
} as UIMessage;

const asStream = (chunks: Array<Record<string, unknown>>) =>
  chunks.map((chunk, index) => ({ body: JSON.stringify(chunk), index }));

const reasoningChunks = [
  { type: "start", messageId: "assistant-partial" },
  { type: "start-step" },
  { type: "reasoning-start", id: "r" },
  { type: "reasoning-delta", id: "r", delta: "Let me think" }
];

async function seedInterruptedTurn(
  agent: Awaited<ReturnType<typeof recoveryAgent>>,
  chunks: Array<Record<string, unknown>>
): Promise<void> {
  const requestId = "req-cut-off";
  await agent.persistTestMessage(question);
  await agent.insertInterruptedStream(
    `stream-${requestId}`,
    requestId,
    asStream(chunks)
  );
  await agent.insertInterruptedFiber(`__cf_internal_chat_turn:${requestId}`, {
    __cfThinkChatFiberSnapshot: {
      kind: "think-chat-turn",
      version: 1,
      requestId,
      continuation: false,
      latestMessageId: question.id,
      latestMessageRole: "user",
      latestUserMessageId: question.id,
      startedAt: Date.now()
    },
    user: null
  });
}

const ids = (messages: UIMessage[]) => messages.map((message) => message.id);

describe("Think: a reply that holds nothing", () => {
  it("does not store a reply cut off while the model was still reasoning", async () => {
    const stored = await recoverAfterEviction(reasoningChunks);

    // The cut-off reply was not stored, so recovery answered the question
    // again in a reply of its own.
    expect(ids(stored)).not.toContain("assistant-partial");
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(stored[1].parts.some((part) => part.type === "text")).toBe(true);
  });

  it("does not store a reply cut off right after its text part opened", async () => {
    const stored = await recoverAfterEviction([
      ...reasoningChunks,
      { type: "reasoning-end", id: "r" },
      { type: "text-start", id: "t" }
    ]);

    expect(ids(stored)).not.toContain("assistant-partial");
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
  });

  it("retries the question of a turn cut off in its reasoning", async () => {
    const agent = await recoveryAgent();
    await seedInterruptedTurn(agent, reasoningChunks);

    // Nothing of the reply is stored, so there is nothing to continue.
    expect(await agent.triggerFiberRecovery()).toEqual({
      scheduledContinueCount: 0,
      scheduledRetryCount: 1
    });
  });

  it("continueLastTurn over a stored reply that is only reasoning removes it and answers the question", async () => {
    const agent = await recoveryAgent();
    // The previous release stored a reply stopped in its reasoning.
    await agent.persistTestMessage(question);
    await agent.persistTestMessage(reasoningOnly);

    expect((await agent.testContinueLastTurn()).status).toBe("completed");

    expect(await agent.getTurnCallCount()).toBe(1);
    const stored = (await agent.getStoredMessages()) as UIMessage[];
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(stored[1].id).not.toBe("assistant-reasoning");
    expect(stored[1].parts.some((part) => part.type === "text")).toBe(true);
  });

  it("a re-run of the continue attempt after the reply was removed answers the question", async () => {
    const agent = await recoveryAgent();
    // The state a first attempt leaves when it removed the empty reply and
    // then died before its retry turn finished.
    await agent.persistTestMessage(question);

    await agent.runRecoveryContinueForTest({
      targetAssistantId: "assistant-reasoning"
    });

    expect(await agent.getTurnCallCount()).toBe(1);
    const stored = (await agent.getStoredMessages()) as UIMessage[];
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
  });

  it("a second delivery of the continue payload retries when the incident recorded the removal", async () => {
    const agent = await recoveryAgent();
    // The first run recorded the removal on the incident, removed the
    // reply, and died in its retry turn.
    await agent.persistTestMessage(question);
    await agent.seedIncidentForTest({
      incidentId: "inc-removed",
      requestId: "req-removed",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now(),
      replyRemoved: true
    });

    await agent.runChatRecoveryContinueForTestWith({
      incidentId: "inc-removed",
      originalRequestId: "req-removed",
      targetAssistantId: "assistant-reasoning"
    });

    expect(await agent.getTurnCallCount()).toBe(1);
    const stored = (await agent.getStoredMessages()) as UIMessage[];
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
  });

  it("a continue attempt whose reply is gone leaves a newer question alone", async () => {
    const agent = await recoveryAgent();
    await agent.persistTestMessage(question);
    await agent.persistTestMessage({
      id: "user-2",
      role: "user",
      parts: [{ type: "text", text: "Something else" }]
    });

    await agent.runRecoveryContinueForTest({
      targetAssistantId: "assistant-reasoning",
      originMessageIds: ["user-1"]
    });

    expect(await agent.getTurnCallCount()).toBe(0);
  });

  it("keeps a server tool call cut off mid-run, settled as an error that says it may have run", async () => {
    const stored = await recoverAfterEviction([
      ...reasoningChunks,
      { type: "reasoning-end", id: "r" },
      { type: "tool-input-start", toolCallId: "tc1", toolName: "getWeather" },
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "getWeather",
        input: { city: "Paris" }
      }
    ]);

    // The cut-off reply is kept and continued, with the record of the call.
    const reply = stored.find((message) => message.id === "assistant-partial");
    expect(
      reply?.parts.find((part) => part.type === "tool-getWeather")
    ).toMatchObject({
      state: "output-error",
      errorText:
        "The tool call was interrupted before a result was recorded. The tool may still have run."
    });
  });

  it("a new question removes an earlier reply that held only reasoning", async () => {
    const agent = await recoveryAgent();
    await agent.persistTestMessage(question);
    await agent.persistTestMessage(reasoningOnly);

    expect((await agent.testSaveMessages("Something else")).status).toBe(
      "completed"
    );

    const stored = (await agent.getStoredMessages()) as UIMessage[];
    expect(ids(stored)).not.toContain("assistant-reasoning");
    // The new question follows the first one, and its reply follows it.
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant"
    ]);
    expect(stored.every((message) => message.parts.length > 0)).toBe(true);
  });

  it("a recovery that would continue it removes it and answers the question again", async () => {
    const agent = await recoveryAgent();
    await agent.persistTestMessage(question);
    await agent.persistTestMessage(reasoningOnly);

    await agent.runRecoveryContinueForTest({
      targetAssistantId: "assistant-reasoning"
    });

    expect(await agent.getTurnCallCount()).toBe(1);
    const stored = (await agent.getStoredMessages()) as UIMessage[];
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(stored[1].id).not.toBe("assistant-reasoning");
    expect(stored[1].parts.some((part) => part.type === "text")).toBe(true);
  });
});
