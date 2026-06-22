import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

async function freshRecoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

function channelMeta(message: UIMessage | undefined): unknown {
  return (message?.metadata as { channel?: unknown } | undefined)?.channel;
}

/**
 * recovery × channels: a turn's channel id is persisted on the user message
 * (`metadata.channel`). When that turn is interrupted and recovered, the
 * recovered turn must (a) preserve the stamp and (b) re-resolve the channel and
 * re-apply its per-channel policy (instructions / tool narrowing). This locks
 * the invariant documented in rfc-think-channels.md and
 * rfc-chat-recovery-foundation.md across BOTH recovery paths — `continue`
 * (partial assistant) and `retry` (unanswered user leaf).
 */
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

    // (a) The channel stamp survives recovery.
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(channelMeta(messages.find((m) => m.role === "user"))).toBe("voice");

    // (b) Per-channel policy is re-applied on the recovered turn.
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

    // (a) The channel stamp survives recovery.
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(channelMeta(messages.find((m) => m.role === "user"))).toBe("voice");

    // (b) Per-channel policy is re-applied on the recovered RETRY turn. This is
    // the path that previously dropped channel context (`_retryLastUserTurn`
    // admitted the turn without re-resolving the channel), so the recovered
    // turn silently ran with default policy instead of the channel's.
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

    // The voice channel's `tools` callback was re-invoked on the recovered
    // turn, so its `voiceMarker` tool is in scope.
    const toolNames = await agent.getTurnClientToolNames();
    expect(toolNames.at(-1)).toContain("voiceMarker");
  });

  it("falls back to default policy when the recovered turn has NO channel stamp", async () => {
    const agent = await freshRecoveryAgent(
      `channel-none-${crypto.randomUUID()}`
    );

    // A user message with no `metadata.channel` at all.
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

    // No channel was resolved, so NO per-channel policy leaks onto the turn:
    // no active channel, default instructions, and no channel-scoped tool.
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

    // This facet is running as an agent-tool child (in-flight run row) on a
    // voice-channel turn that then gets interrupted mid-stream.
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

    // (1) The agent-tool child run was rebound to the recovery turn's id so the
    // parent's re-attach tail keeps attributing frames.
    const reboundReqId =
      await agent.getAgentToolChildRunRequestIdForTest("run-combo");
    expect(reboundReqId).toBeTruthy();
    expect(reboundReqId).not.toBe("old-req-combo");
    expect(
      await agent.resolveAgentToolRunForRequestForTest(reboundReqId as string)
    ).toBe("run-combo");

    // (2) ...and the voice channel's instructions + tool policy were re-applied
    // on that very same recovered turn.
    const channels = await agent.getCapturedTurnChannelsForTest();
    expect(channels.at(-1)).toBe("voice");
    const systems = await agent.getCapturedTurnSystemsForTest();
    expect(systems.at(-1)).toContain("VOICE MODE");
    const toolNames = await agent.getTurnClientToolNames();
    expect(toolNames.at(-1)).toContain("voiceMarker");
  });
});
