import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

async function freshRecoveryAgent(name: string) {
  return getAgentByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

/**
 * `runTurn` (wait mode) drives the same programmatic turn path as
 * `saveMessages`, so it must participate in the chat-recovery fiber lifecycle
 * and compose with recovery. These assert (1) a `runTurn` turn is recovery-fiber
 * wrapped and cleaned up, and (2) a fresh `runTurn` builds correctly on top of a
 * transcript that was just resolved by a recovery continuation.
 */
describe("recovery × runTurn", () => {
  it("wraps a runTurn turn in a recovery fiber and cleans it up", async () => {
    const agent = await freshRecoveryAgent(
      `runturn-fiber-${crypto.randomUUID()}`
    );

    const result = await agent.testRunTurnWait(
      "Programmatic hello via runTurn"
    );
    expect(result.status).toBe("completed");
    expect(result.continuation).toBe(false);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);

    // No leaked recovery fibers after a clean turn.
    expect(await agent.getActiveFibers()).toHaveLength(0);
    expect(await agent.getTurnCallCount()).toBe(1);
  });

  it("lets a fresh runTurn build on a transcript resolved by recovery continue", async () => {
    const agent = await freshRecoveryAgent(
      `runturn-after-recovery-${crypto.randomUUID()}`
    );

    // Seed a mid-stream interrupted turn.
    await agent.persistTestMessage({
      id: "u-runturn-rec",
      role: "user",
      parts: [{ type: "text", text: "answer this" }]
    });
    await agent.persistTestMessage({
      id: "a-runturn-rec",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }]
    });
    await agent.insertInterruptedStream(
      "stream-runturn-rec",
      "req-runturn-rec",
      [
        {
          body: JSON.stringify({ type: "start", messageId: "a-runturn-rec" }),
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
      "__cf_internal_chat_turn:req-runturn-rec",
      {
        __cfThinkChatFiberSnapshot: {
          kind: "think-chat-turn",
          version: 1,
          requestId: "req-runturn-rec",
          continuation: false,
          latestMessageId: "a-runturn-rec",
          latestMessageRole: "assistant",
          latestUserMessageId: "u-runturn-rec",
          startedAt: Date.now()
        },
        user: null
      }
    );

    // Assert atomically with the recovery scan. An immediate alarm may consume
    // the Task after this RPC releases the Durable Object.
    const transport = await agent.triggerFiberRecoveryWithTransportForTest(
      "_chatRecoveryContinue"
    );
    expect(transport).toEqual({ tasks: 1, schedules: 0 });
    await agent.runScheduledRecoveryContinueForTest();

    // Recovery resolved the interrupted turn and left no leaked fiber.
    expect(await agent.getActiveFibers()).toHaveLength(0);
    const afterRecovery = (await agent.getStoredMessages()) as UIMessage[];
    expect(afterRecovery.length).toBeGreaterThanOrEqual(2);
    expect(afterRecovery.at(-1)?.role).toBe("assistant");

    // A fresh runTurn composes cleanly on top of the recovered transcript,
    // adding exactly one user + one assistant message and leaking no fiber.
    const followUp = await agent.testRunTurnWait("now a follow-up");
    expect(followUp.status).toBe("completed");

    const finalMessages = (await agent.getStoredMessages()) as UIMessage[];
    expect(finalMessages).toHaveLength(afterRecovery.length + 2);
    expect(finalMessages.at(-1)?.role).toBe("assistant");
    expect(await agent.getActiveFibers()).toHaveLength(0);
  });

  it("continues an interrupted assistant message instead of appending a duplicate assistant", async () => {
    const agent = await freshRecoveryAgent(
      `runturn-continuation-accumulator-${crypto.randomUUID()}`
    );

    await agent.persistTestMessage({
      id: "u-continuation-accumulator",
      role: "user",
      parts: [{ type: "text", text: "continue this partial answer" }]
    });
    await agent.persistTestMessage({
      id: "a-continuation-accumulator",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }]
    });
    await agent.insertInterruptedStream(
      "stream-continuation-accumulator",
      "req-continuation-accumulator",
      [
        {
          body: JSON.stringify({
            type: "start",
            messageId: "a-continuation-accumulator"
          }),
          index: 0
        },
        { body: JSON.stringify({ type: "text-start" }), index: 1 },
        {
          body: JSON.stringify({
            type: "text-delta",
            delta: "Partial answer"
          }),
          index: 2
        }
      ]
    );
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-continuation-accumulator",
      {
        __cfThinkChatFiberSnapshot: {
          kind: "think-chat-turn",
          version: 1,
          requestId: "req-continuation-accumulator",
          continuation: false,
          latestMessageId: "a-continuation-accumulator",
          latestMessageRole: "assistant",
          latestUserMessageId: "u-continuation-accumulator",
          startedAt: Date.now()
        },
        user: null
      }
    );

    await agent.triggerFiberRecovery();
    await agent.runScheduledRecoveryContinueForTest();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const assistants = messages.filter(
      (message) => message.role === "assistant"
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.id).toBe("a-continuation-accumulator");
    expect(
      assistants[0]?.parts
        .filter(
          (part): part is { type: "text"; text: string } => part.type === "text"
        )
        .map((part) => part.text)
        .join("")
    ).toContain("Continued response.");
    expect(
      assistants[0]?.parts.filter(
        (part) => "state" in part && part.state === "streaming"
      )
    ).toEqual([]);
  });
});

describe("recovery × onChatResponse after a reset (#2266)", () => {
  it("fires the response hook once for a turn persisted before the reset", async () => {
    const agent = await freshRecoveryAgent(`hook-reset-${crypto.randomUUID()}`);
    await agent.resetBeforeNextResponseHookForTest();

    const result = await agent.testRunTurnWait("hello");
    expect(result.status).toBe("completed");
    expect(await agent.getChatResponsesForTest()).toEqual([]);

    await agent.recoverFromResetForTest();
    await agent.runScheduledRecoveryContinueForTest();
    await agent.runScheduledRecoveryRetryForTest();
    expect(await agent.getTurnCallCount()).toBe(1);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    const responses = await agent.getChatResponsesForTest();
    expect(responses).toEqual([
      expect.objectContaining({
        status: "completed",
        messageId: messages[1].id,
        recovered: true
      })
    ]);
    expect(await agent.getActiveFibers()).toHaveLength(0);

    await agent.replayPendingResponseHooksForTest();
    expect(await agent.getChatResponsesForTest()).toHaveLength(1);
  });

  it("replays an owed response hook on startup without a chat fiber", async () => {
    const agent = await freshRecoveryAgent(
      `hook-reset-start-${crypto.randomUUID()}`
    );
    await agent.resetBeforeNextResponseHookForTest();
    await agent.testRunTurnWait("hello");
    expect(await agent.getChatResponsesForTest()).toEqual([]);

    await agent.replayPendingResponseHooksForTest();
    await agent.replayPendingResponseHooksForTest();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(await agent.getChatResponsesForTest()).toEqual([
      expect.objectContaining({
        status: "completed",
        messageId: messages[1].id,
        recovered: true
      })
    ]);
  });

  it("does not replay the hook of a turn that completed normally", async () => {
    const agent = await freshRecoveryAgent(
      `hook-no-reset-${crypto.randomUUID()}`
    );
    await agent.testRunTurnWait("hello");
    await agent.replayPendingResponseHooksForTest();

    expect(await agent.getChatResponsesForTest()).toEqual([
      expect.not.objectContaining({ recovered: true })
    ]);
  });
});
