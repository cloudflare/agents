import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";

describe("continueLastTurn", () => {
  it("should append to the last assistant message without creating a user message", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Tell me a story" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Once upon a time" }]
      }
    ] as ChatMessage[]);

    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];

    const userMessages = messages.filter((m: ChatMessage) => m.role === "user");
    expect(userMessages).toHaveLength(1);

    const assistantMessages = messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].id).toBe("assistant-1");

    const parts = assistantMessages[0].parts;
    expect(parts.length).toBeGreaterThan(1);

    const firstTextPart = parts[0] as { type: string; text: string };
    expect(firstTextPart.text).toBe("Once upon a time");

    const allText = parts
      .filter((p: ChatMessage["parts"][number]) => p.type === "text")
      .map((p: { type: string; text?: string }) => p.text ?? "")
      .join("");
    expect(allText).toContain("Continued response.");
  });

  it("should skip when there is no assistant message", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      }
    ] as ChatMessage[]);

    const result = (await agentStub.callContinueLastTurn()) as {
      status: string;
    };
    expect(result.status).toBe("skipped");

    const callCount =
      (await agentStub.getOnChatMessageCallCount()) as unknown as number;
    expect(callCount).toBe(0);
  });

  it("should skip when messages are empty", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    const result = (await agentStub.callContinueLastTurn()) as {
      status: string;
    };
    expect(result.status).toBe("skipped");
  });

  it("should preserve the original assistant message ID", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant-keep-id",
        role: "assistant",
        parts: [{ type: "text", text: "Original response" }]
      }
    ] as ChatMessage[]);

    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].id).toBe("assistant-keep-id");
  });

  it("should work end-to-end with interrupted stream recovery", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    // Disable automatic continuation so we control the flow
    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Tell me a story" }]
      }
    ] as ChatMessage[]);

    // Simulate interrupted stream
    await agentStub.insertInterruptedStream("test-stream", "test-request", [
      {
        body: JSON.stringify({
          type: "start",
          messageId: "assistant-partial"
        }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({
          type: "text-delta",
          delta: "Once upon a "
        }),
        index: 2
      },
      {
        body: JSON.stringify({
          type: "text-delta",
          delta: "time there was"
        }),
        index: 3
      }
    ]);
    await agentStub.triggerInterruptedStreamCheck();

    // Partial is persisted (persist defaults to true)
    let messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    let assistantMessages = messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].id).toBe("assistant-partial");

    // Now manually continue — appends to the same message
    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    assistantMessages = messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].id).toBe("assistant-partial");

    const userMessages = messages.filter((m: ChatMessage) => m.role === "user");
    expect(userMessages).toHaveLength(1);

    const allText = assistantMessages[0].parts
      .filter((p: ChatMessage["parts"][number]) => p.type === "text")
      .map((p: { type: string; text?: string }) => p.text ?? "")
      .join("");
    expect(allText).toContain("Once upon a time there was");
    expect(allText).toContain("Continued response.");
  });

  it("should merge text into existing streaming text part (not create a new block)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);
    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Tell me a story" }]
      }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedStream("merge-stream", "merge-req", [
      {
        body: JSON.stringify({ type: "start", messageId: "assistant-merge" }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Beginning" }),
        index: 2
      }
    ]);
    await agentStub.triggerInterruptedStreamCheck();

    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = messages.find(
      (m: ChatMessage) => m.role === "assistant"
    )!;
    const textParts = assistant.parts.filter(
      (p: ChatMessage["parts"][number]) => p.type === "text"
    );

    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe(
      "BeginningContinued response."
    );
  });

  it("should not merge text when existing text part is complete (state done)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant-done",
        role: "assistant",
        parts: [{ type: "text", text: "Complete response." }]
      }
    ] as ChatMessage[]);

    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = messages.find(
      (m: ChatMessage) => m.role === "assistant"
    )!;
    const textParts = assistant.parts.filter(
      (p: ChatMessage["parts"][number]) => p.type === "text"
    );

    expect(textParts).toHaveLength(2);
    expect((textParts[0] as { text: string }).text).toBe("Complete response.");
    expect((textParts[1] as { text: string }).text).toBe("Continued response.");
  });

  it("should merge reasoning into existing reasoning part during continuation", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);
    await agentStub.setRecoveryOverride({ continue: false });
    await agentStub.setIncludeReasoning(true);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Think about this" }]
      }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedStream("reason-stream", "reason-req", [
      {
        body: JSON.stringify({
          type: "start",
          messageId: "assistant-reason"
        }),
        index: 0
      },
      { body: JSON.stringify({ type: "reasoning-start" }), index: 1 },
      {
        body: JSON.stringify({
          type: "reasoning-delta",
          delta: "Original thinking."
        }),
        index: 2
      },
      { body: JSON.stringify({ type: "reasoning-end" }), index: 3 },
      { body: JSON.stringify({ type: "text-start" }), index: 4 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Partial answer" }),
        index: 5
      }
    ]);
    await agentStub.triggerInterruptedStreamCheck();

    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = messages.find(
      (m: ChatMessage) => m.role === "assistant"
    )!;

    const reasoningParts = assistant.parts.filter(
      (p: ChatMessage["parts"][number]) => p.type === "reasoning"
    );
    expect(reasoningParts).toHaveLength(1);
    expect((reasoningParts[0] as { text: string }).text).toContain(
      "Original thinking."
    );
    expect((reasoningParts[0] as { text: string }).text).toContain(
      "Thinking about continuation."
    );

    const textParts = assistant.parts.filter(
      (p: ChatMessage["parts"][number]) => p.type === "text"
    );
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe(
      "Partial answerContinued response."
    );
  });
});
