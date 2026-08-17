/**
 * Wake-driven chat recovery after forced Durable Object eviction.
 *
 * This explicitly tears down a running test actor, then routes back through
 * partyserver so the normal startup wrapper discovers the persisted fiber. It
 * does not assert natural idle hibernation or hibernation eligibility.
 */
import type { UIMessage } from "ai";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type {
  ThinkNonRecoveryTestAgent,
  ThinkRecoveryTestAgent
} from "./agents/think-session";

const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_STREAM_RESUME_ACK = "cf_agent_stream_resume_ack";
const MSG_STREAM_RESUMING = "cf_agent_stream_resuming";

async function recoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

async function nonRecoveryAgent(name: string) {
  return getServerByName(
    env.ThinkNonRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkNonRecoveryTestAgent>,
    name
  );
}

async function getStoredBranches(
  agent: Awaited<ReturnType<typeof recoveryAgent>>,
  messageId: string
): Promise<UIMessage[]> {
  // SAFETY: The test agent returns sanitized UIMessage values. PartyServer's
  // RPC serializer cannot infer the AI SDK's open metadata shape.
  return (await agent.getBranchesForTest(messageId)) as UIMessage[];
}

async function getNonRecoveryStoredBranches(
  agent: Awaited<ReturnType<typeof nonRecoveryAgent>>,
  messageId: string
): Promise<UIMessage[]> {
  return (await agent.getBranchesForTest(messageId)) as UIMessage[];
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

async function connectNonRecoveryAgent(name: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `http://example.com/agents/think-non-recovery-test-agent/${name}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(response.status).toBe(101);
  const webSocket = response.webSocket;
  expect(webSocket).toBeDefined();
  webSocket!.accept();
  return webSocket!;
}

function waitForWebSocketFrame(
  webSocket: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 3000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      webSocket.removeEventListener("message", onMessage);
      reject(new Error(`WebSocket frame not received within ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(event.data as string) as Record<string, unknown>;
      if (!predicate(frame)) return;
      clearTimeout(timeout);
      webSocket.removeEventListener("message", onMessage);
      resolve(frame);
    };
    webSocket.addEventListener("message", onMessage);
  });
}

async function closeWebSocket(webSocket: WebSocket): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 200);
    webSocket.addEventListener(
      "close",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
  webSocket.close();
  await closed;
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

async function seedInterruptedRegeneration(
  agent: Awaited<ReturnType<typeof recoveryAgent>>,
  streamStatus: "streaming" | "completed" | "error" = "streaming",
  includePartialChunks = true
): Promise<{
  userId: string;
  oldAssistantId: string;
  partialAssistantId: string;
}> {
  const requestId = "req-regeneration-eviction";
  const userId = "user-regeneration-eviction";
  const oldAssistantId = "assistant-old-regeneration-eviction";
  const partialAssistantId = "assistant-partial-regeneration-eviction";

  await agent.persistTestMessage({
    id: userId,
    role: "user",
    parts: [{ type: "text", text: "answer this differently" }]
  });
  await agent.persistTestMessage({
    id: oldAssistantId,
    role: "assistant",
    parts: [{ type: "text", text: "Old answer" }]
  });
  const partialChunks = includePartialChunks
    ? [
        {
          body: JSON.stringify({
            type: "start",
            messageId: partialAssistantId
          }),
          index: 0
        },
        {
          body: JSON.stringify({
            type: "text-start",
            id: "regenerated-text"
          }),
          index: 1
        },
        {
          body: JSON.stringify({
            type: "text-delta",
            id: "regenerated-text",
            delta: "Partial replacement"
          }),
          index: 2
        }
      ]
    : [];
  await agent.insertInterruptedStream(
    `stream-${requestId}`,
    requestId,
    partialChunks,
    streamStatus
  );
  await agent.insertInterruptedFiber(`__cf_internal_chat_turn:${requestId}`, {
    __cfThinkChatFiberSnapshot: {
      kind: "think-chat-turn",
      version: 1,
      requestId,
      continuation: false,
      latestMessageId: userId,
      latestMessageRole: "user",
      latestUserMessageId: userId,
      historyLeafId: userId,
      activeLeafIdAtStart: oldAssistantId,
      startedAt: Date.now()
    },
    user: null
  });

  return { userId, oldAssistantId, partialAssistantId };
}

async function seedPreStreamRegeneration(
  agent: Awaited<ReturnType<typeof recoveryAgent>>
): Promise<{ requestId: string; userId: string; oldAssistantId: string }> {
  const requestId = "req-pre-stream-regeneration-eviction";
  const userId = "user-pre-stream-regeneration-eviction";
  const oldAssistantId = "assistant-old-pre-stream-regeneration-eviction";

  await agent.persistTestMessage({
    id: userId,
    role: "user",
    parts: [{ type: "text", text: "try another answer" }]
  });
  await agent.persistTestMessage({
    id: oldAssistantId,
    role: "assistant",
    parts: [{ type: "text", text: "Old answer" }]
  });
  await agent.insertInterruptedFiber(`__cf_internal_chat_turn:${requestId}`, {
    __cfThinkChatFiberSnapshot: {
      kind: "think-chat-turn",
      version: 1,
      requestId,
      continuation: false,
      latestMessageId: userId,
      latestMessageRole: "user",
      latestUserMessageId: userId,
      historyLeafId: userId,
      activeLeafIdAtStart: oldAssistantId,
      startedAt: Date.now()
    },
    user: null
  });

  return { requestId, userId, oldAssistantId };
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

  it("retries pre-stream regeneration from the selected branch point", async () => {
    const name = `evict-pre-stream-regeneration-${crypto.randomUUID()}`;
    let agent = await recoveryAgent(name);
    const { requestId, userId, oldAssistantId } =
      await seedPreStreamRegeneration(agent);

    await evictDurableObject(agent as unknown as DurableObjectStub);
    agent = await recoveryAgent(name);

    await waitFor(async () => (await agent.getTurnCallCount()) === 1);
    await waitFor(async () => (await agent.getActiveFibers()).length === 0);

    const branches = await getStoredBranches(agent, userId);
    expect(branches).toHaveLength(2);
    expect(branches.map((message) => message.id)).toContain(oldAssistantId);
    expect(await agent.getPromptRolesForTest()).toEqual([["system", "user"]]);

    await agent.retryBranchForTest({
      targetUserId: userId,
      historyLeafId: userId,
      activeLeafIdAtStart: oldAssistantId,
      originalRequestId: requestId
    });
    expect(await getStoredBranches(agent, userId)).toHaveLength(2);
    expect(await agent.getTurnCallCount()).toBe(1);
  });

  it("retries the selected regeneration branch when the stream has no chunks", async () => {
    const name = `evict-empty-stream-regeneration-${crypto.randomUUID()}`;
    let agent = await recoveryAgent(name);
    const { userId, oldAssistantId } = await seedInterruptedRegeneration(
      agent,
      "streaming",
      false
    );

    await evictDurableObject(agent as unknown as DurableObjectStub);
    agent = await recoveryAgent(name);

    await waitFor(async () => (await agent.getTurnCallCount()) === 1);
    await waitFor(async () => (await agent.getActiveFibers()).length === 0);

    const branches = await getStoredBranches(agent, userId);
    expect(branches).toHaveLength(2);
    expect(branches.map((message) => message.id)).toContain(oldAssistantId);
    expect(await agent.getPromptRolesForTest()).toEqual([["system", "user"]]);
  });

  it("recovers regeneration on the selected sibling branch", async () => {
    const name = `evict-regeneration-${crypto.randomUUID()}`;
    let agent = await recoveryAgent(name);
    const { userId, oldAssistantId, partialAssistantId } =
      await seedInterruptedRegeneration(agent);

    await evictDurableObject(agent as unknown as DurableObjectStub);
    agent = await recoveryAgent(name);

    await waitFor(async () => (await agent.getTurnCallCount()) === 1);
    await waitFor(async () => (await agent.getActiveFibers()).length === 0);

    const branches = await getStoredBranches(agent, userId);
    expect(branches.map((message) => message.id)).toEqual([
      oldAssistantId,
      partialAssistantId
    ]);
    const continuationBranches = await getStoredBranches(
      agent,
      partialAssistantId
    );
    expect(continuationBranches).toHaveLength(1);
    expect(JSON.stringify(continuationBranches[0].parts)).toContain(
      "Continued response."
    );
    expect(await agent.getPromptRolesForTest()).toEqual([
      ["system", "user", "assistant", "user"]
    ]);
  });

  it("persists terminal regeneration on the selected sibling branch", async () => {
    const name = `evict-terminal-regeneration-${crypto.randomUUID()}`;
    let agent = await recoveryAgent(name);
    const { userId, oldAssistantId, partialAssistantId } =
      await seedInterruptedRegeneration(agent, "completed");

    await evictDurableObject(agent as unknown as DurableObjectStub);
    agent = await recoveryAgent(name);

    await waitFor(async () => (await agent.getActiveFibers()).length === 0);

    expect(await agent.getTurnCallCount()).toBe(0);
    const branches = await getStoredBranches(agent, userId);
    expect(branches.map((message) => message.id)).toEqual([
      oldAssistantId,
      partialAssistantId
    ]);
  });
});

describe("Think resume handshake after forced Durable Object eviction", () => {
  it("persists an orphaned regeneration as a sibling without chat recovery", async () => {
    const name = `evict-resume-regeneration-${crypto.randomUUID()}`;
    let agent = await nonRecoveryAgent(name);
    const { requestId, userId, oldAssistantId, partialAssistantId } =
      await agent.seedInterruptedRegenerationForResumeTest();

    await evictDurableObject(agent as unknown as DurableObjectStub);

    const webSocket = await connectNonRecoveryAgent(name);
    try {
      const resuming = await waitForWebSocketFrame(
        webSocket,
        (frame) => frame.type === MSG_STREAM_RESUMING
      );
      expect(resuming.id).toBe(requestId);

      const replayDone = waitForWebSocketFrame(
        webSocket,
        (frame) =>
          frame.type === MSG_CHAT_RESPONSE &&
          frame.id === requestId &&
          frame.done === true
      );
      webSocket.send(
        JSON.stringify({ type: MSG_STREAM_RESUME_ACK, id: requestId })
      );
      await replayDone;

      agent = await nonRecoveryAgent(name);
      await waitFor(async () => {
        const userBranches = await getNonRecoveryStoredBranches(agent, userId);
        const oldAnswerBranches = await getNonRecoveryStoredBranches(
          agent,
          oldAssistantId
        );
        return [...userBranches, ...oldAnswerBranches].some(
          (message) => message.id === partialAssistantId
        );
      });

      const branches = await getNonRecoveryStoredBranches(agent, userId);
      expect(branches.map((message) => message.id)).toEqual([
        oldAssistantId,
        partialAssistantId
      ]);
    } finally {
      await closeWebSocket(webSocket);
    }
  });
});
