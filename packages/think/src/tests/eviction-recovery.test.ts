import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

/**
 * Chat-recovery × real DO eviction.
 *
 * The existing recovery suites (channel-recovery, run-turn-recovery,
 * agent-tool-reattach-recovery, action-pause-recovery) simulate hibernation by
 * hand-crafting `cf_agents_runs` snapshots and then calling
 * `triggerFiberRecovery()` directly. That proves the recovery *machinery* but
 * never exercises the production lifecycle: an idle DO is evicted from memory,
 * and on the NEXT wake its `onStart` runs `_checkRunFibers()` itself, which
 * detects the interrupted fiber persisted in storage and schedules the recovery
 * continuation.
 *
 * These tests seed the SAME interrupted-turn durable state, then use the real
 * `evictDurableObject` helper (vitest-pool-workers >= 0.16.20) so the runtime's
 * own teardown + wake drives recovery. The original synthetic-fiber tests are
 * retained as fast unit-level coverage of edge cases (channel re-resolution,
 * RETRY vs CONTINUE arms, exhaustion budgets) that are awkward to provoke
 * through a full eviction; this file adds the missing end-to-end rehydration
 * proof alongside them.
 *
 * Re-acquiring after eviction: a Think DO routes through partyserver, which sets
 * the DO's `name` (and rebuilds `this.session`) on the way in via
 * `getServerByName`. After eviction the instance is torn down, so the next
 * access goes through `getServerByName` again — exactly as a real
 * post-hibernation request does. The first such routed RPC also runs the wake's
 * onStart, which is where `_checkRunFibers()` detects the stored fiber.
 */

function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function recoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

/** Seed a mid-stream-interrupted CONTINUE turn: persisted user + partial
 *  assistant, an orphaned stream, and an interrupted fiber snapshot. */
async function seedInterruptedContinueTurn(
  agent: Awaited<ReturnType<typeof recoveryAgent>>,
  reqId: string,
  userId: string,
  assistantId: string,
  channel?: string
) {
  await agent.persistTestMessage({
    id: userId,
    role: "user",
    parts: [{ type: "text", text: "answer this" }],
    ...(channel ? { metadata: { channel } } : {})
  });
  await agent.persistTestMessage({
    id: assistantId,
    role: "assistant",
    parts: [{ type: "text", text: "Partial answer" }]
  });
  await agent.insertInterruptedStream(`stream-${reqId}`, reqId, [
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
  await agent.insertInterruptedFiber(`__cf_internal_chat_turn:${reqId}`, {
    __cfThinkChatFiberSnapshot: {
      kind: "think-chat-turn",
      version: 1,
      requestId: reqId,
      continuation: false,
      latestMessageId: assistantId,
      latestMessageRole: "assistant",
      latestUserMessageId: userId,
      startedAt: Date.now()
    },
    user: null
  });
}

describe("chat recovery survives a real DO eviction (wake-driven _checkRunFibers)", () => {
  it("onStart on the post-eviction wake schedules the CONTINUE recovery from the stored fiber", async () => {
    const name = uniqueName("evict-rec-continue");
    let agent = await recoveryAgent(name);

    await seedInterruptedContinueTurn(
      agent,
      "req-evict-continue",
      "u-evict-continue",
      "a-evict-continue"
    );

    // Sanity: an interrupted fiber is durably present before eviction.
    expect(await agent.getActiveFibers()).toHaveLength(1);
    // No recovery has been scheduled yet — we never called triggerFiberRecovery.
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(0);

    // Evict from memory. The fiber snapshot survives in cf_agents_runs.
    await evictDurableObject(agent as unknown as DurableObjectStub);

    // The first routed RPC after eviction wakes a fresh instance, whose onStart
    // runs `_checkRunFibers()` ITSELF and schedules the continuation — no manual
    // triggerFiberRecovery() needed. This is the production hibernation path.
    agent = await recoveryAgent(name);
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(1);

    // Run the scheduled continuation (the alarm callback the scheduler fires).
    await agent.runScheduledRecoveryContinueForTest();

    // Recovery resolved the interrupted turn from storage and left no leaked
    // fiber — the transcript ends on a settled assistant message.
    expect(await agent.getActiveFibers()).toHaveLength(0);
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.at(-1)?.role).toBe("assistant");
  });

  it("re-applies channel policy on a turn recovered after eviction", async () => {
    const name = uniqueName("evict-rec-channel");
    let agent = await recoveryAgent(name);

    await seedInterruptedContinueTurn(
      agent,
      "req-evict-voice",
      "u-evict-voice",
      "a-evict-voice",
      "voice"
    );

    await evictDurableObject(agent as unknown as DurableObjectStub);

    // Wake-driven recovery scheduling, then run the continuation.
    agent = await recoveryAgent(name);
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(1);
    await agent.runScheduledRecoveryContinueForTest();

    // (a) The channel stamp survived eviction on the persisted user message.
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const userMsg = messages.find((m) => m.role === "user");
    expect((userMsg?.metadata as { channel?: string })?.channel).toBe("voice");

    // (b) The recovered turn re-resolved the channel from storage and re-applied
    // BOTH its instructions and its tool policy (the channel `tools` callback was
    // re-invoked) — proving the per-channel policy rebuilds from durable state,
    // not from any in-memory context lost at eviction.
    const channels = await agent.getCapturedTurnChannelsForTest();
    expect(channels.at(-1)).toBe("voice");
    const systems = await agent.getCapturedTurnSystemsForTest();
    expect(systems.at(-1)).toContain("VOICE MODE");
    const toolNames = await agent.getTurnClientToolNames();
    expect(toolNames.at(-1)).toContain("voiceMarker");
  });

  it("rebinds an agent-tool child run's request_id on a recovery driven by eviction", async () => {
    const name = uniqueName("evict-rec-reattach");
    let agent = await recoveryAgent(name);

    // This facet is running as an agent-tool child (in-flight run row) on a turn
    // that then gets interrupted mid-stream.
    await agent.seedAgentToolChildRunForTest("run-evict", "old-req-evict");
    await seedInterruptedContinueTurn(
      agent,
      "req-evict-reattach",
      "u-evict-reattach",
      "a-evict-reattach"
    );

    await evictDurableObject(agent as unknown as DurableObjectStub);

    // Wake-driven recovery, then continuation.
    agent = await recoveryAgent(name);
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(1);
    await agent.runScheduledRecoveryContinueForTest();

    // The child-run row (durable cf_agent_tool_child_runs) was rebound off the
    // pre-eviction request id onto the recovery turn's fresh id, and that id now
    // attributes back to the run — so the parent's re-attach tail keeps crediting
    // frames after the DO came back from memory.
    const reboundReqId =
      await agent.getAgentToolChildRunRequestIdForTest("run-evict");
    expect(reboundReqId).toBeTruthy();
    expect(reboundReqId).not.toBe("old-req-evict");
    expect(
      await agent.resolveAgentToolRunForRequestForTest(reboundReqId as string)
    ).toBe("run-evict");
  });

  it("schedules a RETRY recovery after eviction for an unanswered user leaf", async () => {
    const name = uniqueName("evict-rec-retry");
    let agent = await recoveryAgent(name);

    // A user message whose turn never produced an assistant reply (pre-stream
    // eviction → retry path).
    await agent.persistTestMessage({
      id: "u-evict-retry",
      role: "user",
      parts: [{ type: "text", text: "retry this unanswered message" }]
    });
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-evict-retry",
      {
        __cfThinkChatFiberSnapshot: {
          kind: "think-chat-turn",
          version: 1,
          requestId: "req-evict-retry",
          continuation: false,
          latestMessageId: "u-evict-retry",
          latestMessageRole: "user",
          latestUserMessageId: "u-evict-retry",
          startedAt: Date.now()
        },
        user: null
      }
    );

    await evictDurableObject(agent as unknown as DurableObjectStub);

    // The post-eviction wake's onStart detects the interrupted user-leaf fiber
    // and schedules the RETRY arm (vs CONTINUE for a partial assistant).
    agent = await recoveryAgent(name);
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryRetry")
    ).toBe(1);
    await agent.runScheduledRecoveryRetryForTest();

    // Recovery ran the unanswered turn to completion: an assistant reply now
    // tops the transcript and no fiber leaked.
    expect(await agent.getActiveFibers()).toHaveLength(0);
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.at(-1)?.role).toBe("assistant");
  });
});
