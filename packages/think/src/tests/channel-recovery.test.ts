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
});
