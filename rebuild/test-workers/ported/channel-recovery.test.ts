/**
 * Ported from ORIGINAL Think:
 * - packages/think/src/tests/channel-recovery.test.ts
 * - last original change: unknown
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `partyserver` import to `./compat.js`.
 * - Re-pointed original fixture type import to `./fixtures/index.js`.
 */
import { env } from "cloudflare:workers";
import { getServerByName } from "./compat.js";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkRecoveryTestAgent } from "./fixtures/index.js";

async function freshRecoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

function channelMeta(message: UIMessage | undefined): unknown {
  return (message?.metadata as { channel?: unknown } | undefined)?.channel;
}

describe("recovery × channels", () => {
  it("re-applies channel policy when CONTINUING a recovered partial turn", async () => {
    const agent = await freshRecoveryAgent(
      `channel-continue-${crypto.randomUUID()}`
    );

    await agent.persistTestMessage({
      id: "u-ch-continue",
      role: "user",
      parts: [{ type: "text", text: "Continue this partial answer" }],
      metadata: { channel: "voice" }
    });
    await agent.persistTestMessage({
      id: "a-ch-continue",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }]
    });

    await agent.insertInterruptedStream(
      "stream-ch-continue",
      "req-ch-continue",
      [
        {
          body: JSON.stringify({ type: "start", messageId: "a-ch-continue" }),
          index: 0
        },
        { body: JSON.stringify({ type: "text-start" }), index: 1 },
        {
          body: JSON.stringify({ type: "text-delta", delta: "Partial answer" }),
          index: 2
        }
      ]
    );
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-ch-continue",
      {
        __cfThinkChatFiberSnapshot: {
          kind: "think-chat-turn",
          version: 1,
          requestId: "req-ch-continue",
          continuation: false,
          latestMessageId: "a-ch-continue",
          latestMessageRole: "assistant",
          latestUserMessageId: "u-ch-continue",
          startedAt: Date.now()
        },
        user: null
      }
    );

    await agent.triggerFiberRecovery();
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(1);
    await agent.runScheduledRecoveryContinueForTest();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(channelMeta(messages.find((m) => m.role === "user"))).toBe("voice");

    const channels = await agent.getCapturedTurnChannelsForTest();
    expect(channels.at(-1)).toBe("voice");
    const systems = await agent.getCapturedTurnSystemsForTest();
    expect(systems.at(-1)).toContain("VOICE MODE");
  });

  it("re-applies channel policy when RETRYING a recovered pre-stream turn", async () => {
    const agent = await freshRecoveryAgent(
      `channel-retry-${crypto.randomUUID()}`
    );

    await agent.persistTestMessage({
      id: "u-ch-retry",
      role: "user",
      parts: [{ type: "text", text: "Retry this unanswered message" }],
      metadata: { channel: "voice" }
    });

    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-ch-retry", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "req-ch-retry",
        continuation: false,
        latestMessageId: "u-ch-retry",
        latestMessageRole: "user",
        latestUserMessageId: "u-ch-retry",
        startedAt: Date.now()
      },
      user: null
    });

    await agent.triggerFiberRecovery();
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryRetry")
    ).toBe(1);
    await agent.runScheduledRecoveryRetryForTest();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(channelMeta(messages.find((m) => m.role === "user"))).toBe("voice");

    const channels = await agent.getCapturedTurnChannelsForTest();
    expect(channels.at(-1)).toBe("voice");
    const systems = await agent.getCapturedTurnSystemsForTest();
    expect(systems.at(-1)).toContain("VOICE MODE");
  });

  it("re-applies the channel TOOL policy (not just instructions) on a recovered continue turn", async () => {
    const agent = await freshRecoveryAgent(
      `channel-tools-${crypto.randomUUID()}`
    );

    await agent.persistTestMessage({
      id: "u-ch-tools",
      role: "user",
      parts: [{ type: "text", text: "Continue this partial answer" }],
      metadata: { channel: "voice" }
    });
    await agent.persistTestMessage({
      id: "a-ch-tools",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }]
    });

    await agent.insertInterruptedStream("stream-ch-tools", "req-ch-tools", [
      {
        body: JSON.stringify({ type: "start", messageId: "a-ch-tools" }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Partial answer" }),
        index: 2
      }
    ]);
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-ch-tools", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "req-ch-tools",
        continuation: false,
        latestMessageId: "a-ch-tools",
        latestMessageRole: "assistant",
        latestUserMessageId: "u-ch-tools",
        startedAt: Date.now()
      },
      user: null
    });

    await agent.triggerFiberRecovery();
    await agent.runScheduledRecoveryContinueForTest();

    const toolNames = await agent.getTurnClientToolNames();
    expect(toolNames.at(-1)).toContain("voiceMarker");
  });

  it("falls back to default policy when the recovered turn has NO channel stamp", async () => {
    const agent = await freshRecoveryAgent(
      `channel-none-${crypto.randomUUID()}`
    );

    await agent.persistTestMessage({
      id: "u-ch-none",
      role: "user",
      parts: [{ type: "text", text: "Retry this unanswered message" }]
    });

    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-ch-none", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "req-ch-none",
        continuation: false,
        latestMessageId: "u-ch-none",
        latestMessageRole: "user",
        latestUserMessageId: "u-ch-none",
        startedAt: Date.now()
      },
      user: null
    });

    await agent.triggerFiberRecovery();
    await agent.runScheduledRecoveryRetryForTest();

    const channels = await agent.getCapturedTurnChannelsForTest();
    expect(channels.at(-1)).toBe("");
    const systems = await agent.getCapturedTurnSystemsForTest();
    expect(systems.at(-1)).not.toContain("VOICE MODE");
    const toolNames = await agent.getTurnClientToolNames();
    expect(toolNames.at(-1) ?? []).not.toContain("voiceMarker");
  });

  it("composes channel re-resolution AND agent-tool request_id rebind on the SAME recovered turn", async () => {
    const agent = await freshRecoveryAgent(
      `channel-agenttool-${crypto.randomUUID()}`
    );

    await agent.seedAgentToolChildRunForTest("run-combo", "old-req-combo");
    await agent.persistTestMessage({
      id: "u-combo",
      role: "user",
      parts: [{ type: "text", text: "voice + agent-tool work" }],
      metadata: { channel: "voice" }
    });
    await agent.persistTestMessage({
      id: "a-combo",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }]
    });

    await agent.insertInterruptedStream("stream-combo", "req-combo", [
      {
        body: JSON.stringify({ type: "start", messageId: "a-combo" }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Partial answer" }),
        index: 2
      }
    ]);
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-combo", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "req-combo",
        continuation: false,
        latestMessageId: "a-combo",
        latestMessageRole: "assistant",
        latestUserMessageId: "u-combo",
        startedAt: Date.now()
      },
      user: null
    });

    await agent.triggerFiberRecovery();
    await agent.runScheduledRecoveryContinueForTest();

    const reboundReqId =
      await agent.getAgentToolChildRunRequestIdForTest("run-combo");
    expect(reboundReqId).toBeTruthy();
    expect(reboundReqId).not.toBe("old-req-combo");
    expect(
      await agent.resolveAgentToolRunForRequestForTest(reboundReqId as string)
    ).toBe("run-combo");

    const channels = await agent.getCapturedTurnChannelsForTest();
    expect(channels.at(-1)).toBe("voice");
    const systems = await agent.getCapturedTurnSystemsForTest();
    expect(systems.at(-1)).toContain("VOICE MODE");
    const toolNames = await agent.getTurnClientToolNames();
    expect(toolNames.at(-1)).toContain("voiceMarker");
  });
});
