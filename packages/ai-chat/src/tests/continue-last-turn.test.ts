import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 25
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await delay(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

interface ChatRecoveryTestStub {
  persistMessages(messages: unknown[]): Promise<void>;
  getPersistedMessages(): Promise<unknown[]>;
  callContinueLastTurn(body?: Record<string, unknown>): Promise<{
    requestId: string;
    status: string;
  }>;
  waitForIdleForTest(): Promise<void>;
  getOnChatMessageCallCount(): Promise<number>;
  setRecoveryOverride(options: {
    persist?: boolean;
    continue?: boolean;
  }): Promise<void>;
  setIncludeReasoning(value: boolean): Promise<void>;
  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    ageMs?: number
  ): Promise<void>;
  triggerInterruptedStreamCheck(): Promise<void>;
  insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
  triggerFiberRecovery(): Promise<void>;
  getRecoveryContexts(): Promise<unknown[]>;
  getActiveFibers(): Promise<Array<{ id: string; name: string }>>;
}

async function getTestAgent(room: string): Promise<ChatRecoveryTestStub> {
  const stub = await getAgentByName(env.ChatRecoveryTestAgent, room);
  return stub as unknown as ChatRecoveryTestStub;
}

describe("continueLastTurn", () => {
  it("should append to the last assistant message without creating a user message", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

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
    const agentStub = await getTestAgent(room);

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
    const agentStub = await getTestAgent(room);

    const result = (await agentStub.callContinueLastTurn()) as {
      status: string;
    };
    expect(result.status).toBe("skipped");
  });

  it("should preserve the original assistant message ID", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

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
    const agentStub = await getTestAgent(room);

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
    const agentStub = await getTestAgent(room);
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
    const agentStub = await getTestAgent(room);

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
    const agentStub = await getTestAgent(room);
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

  it("should wrap continuation in a fiber when chatRecovery is true", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there" }]
      }
    ] as ChatMessage[]);

    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    // After successful completion, the fiber row should be cleaned up
    const fibers = (await agentStub.getActiveFibers()) as Array<{
      id: string;
      name: string;
    }>;
    expect(fibers).toHaveLength(0);

    // But the continuation should have produced content
    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = messages.find(
      (m: ChatMessage) => m.role === "assistant"
    )!;
    const allText = assistant.parts
      .filter((p: ChatMessage["parts"][number]) => p.type === "text")
      .map((p: { type: string; text?: string }) => p.text ?? "")
      .join("");
    expect(allText).toContain("Continued response.");
  });

  it("should recover from an interrupted continuation via fiber recovery", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    // Disable automatic continuation so we control each step
    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Tell me a story" }]
      }
    ] as ChatMessage[]);

    // Step 1: Simulate an initial interrupted stream
    await agentStub.insertInterruptedStream("stream-1", "req-1", [
      {
        body: JSON.stringify({ type: "start", messageId: "assistant-1" }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "First part. " }),
        index: 2
      }
    ]);
    await agentStub.triggerInterruptedStreamCheck();

    // Verify initial partial is persisted
    let messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(
      messages.filter((m: ChatMessage) => m.role === "assistant")
    ).toHaveLength(1);

    // Step 2: Continue, producing more content
    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    let assistant = messages.find((m: ChatMessage) => m.role === "assistant")!;
    const textAfterFirstContinue = assistant.parts
      .filter((p: ChatMessage["parts"][number]) => p.type === "text")
      .map((p: { type: string; text?: string }) => p.text ?? "")
      .join("");
    expect(textAfterFirstContinue).toContain("First part. ");
    expect(textAfterFirstContinue).toContain("Continued response.");

    // Step 3: Simulate that continuation was ALSO interrupted —
    // insert a new interrupted stream for the continuation's output
    // and a fiber row as if the DO was evicted mid-continuation
    await agentStub.insertInterruptedStream("stream-2", "req-2", [
      { body: JSON.stringify({ type: "text-start" }), index: 0 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Second part. " }),
        index: 1
      }
    ]);
    await agentStub.insertInterruptedFiber("__cf_internal_chat_turn:req-2");

    // Step 4: Trigger fiber recovery — should persist the second partial
    await agentStub.triggerFiberRecovery();

    // Verify recovery detected the second interruption
    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      streamId: string;
      partialText: string;
    }>;
    expect(contexts.length).toBeGreaterThanOrEqual(1);
    const lastCtx = contexts[contexts.length - 1];
    expect(lastCtx.partialText).toBe("Second part. ");

    // Step 5: Continue again
    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    assistant = messages.find((m: ChatMessage) => m.role === "assistant")!;
    const finalText = assistant.parts
      .filter((p: ChatMessage["parts"][number]) => p.type === "text")
      .map((p: { type: string; text?: string }) => p.text ?? "")
      .join("");

    // Should contain content from all iterations
    expect(finalText).toContain("First part. ");
    expect(finalText).toContain("Continued response.");
    expect(finalText).toContain("Second part. ");

    // Only one assistant message throughout
    expect(
      messages.filter((m: ChatMessage) => m.role === "assistant")
    ).toHaveLength(1);
  });

  it("should not recurse infinitely — recovery converges", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      }
    ] as ChatMessage[]);

    // Simulate interrupted stream
    await agentStub.insertInterruptedStream("conv-stream", "conv-req", [
      {
        body: JSON.stringify({ type: "start", messageId: "assistant-conv" }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Partial. " }),
        index: 2
      }
    ]);

    // Insert fiber row to trigger full fiber-based recovery with default
    // options (persist: true, continue: true)
    await agentStub.insertInterruptedFiber("__cf_internal_chat_turn:conv-req");

    // Trigger recovery — default options will persist + continue
    // This should: persist partial, schedule _chatRecoveryContinue,
    // which calls continueLastTurn, which completes and cleans up.
    await agentStub.triggerFiberRecovery();
    await agentStub.waitForIdleForTest();

    await waitUntil(async () => {
      const messages =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      const assistantMessages = messages.filter(
        (m: ChatMessage) => m.role === "assistant"
      );
      const allText = assistantMessages[0]?.parts
        .filter((p: ChatMessage["parts"][number]) => p.type === "text")
        .map((p: { type: string; text?: string }) => p.text ?? "")
        .join("");
      const fibers = await agentStub.getActiveFibers();
      const callCount = await agentStub.getOnChatMessageCallCount();

      return (
        assistantMessages.length === 1 &&
        allText?.includes("Partial. ") === true &&
        allText.includes("Continued response.") &&
        fibers.length === 0 &&
        callCount === 1
      );
    });

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );

    // Should have exactly 1 assistant message (no duplication)
    expect(assistantMessages).toHaveLength(1);

    // Should contain both partial and continuation
    const allText = assistantMessages[0].parts
      .filter((p: ChatMessage["parts"][number]) => p.type === "text")
      .map((p: { type: string; text?: string }) => p.text ?? "")
      .join("");
    expect(allText).toContain("Partial. ");
    expect(allText).toContain("Continued response.");

    // No leftover fibers — the continuation completed cleanly
    const fibers = (await agentStub.getActiveFibers()) as Array<{
      id: string;
      name: string;
    }>;
    expect(fibers).toHaveLength(0);

    // onChatMessage was called exactly once (by the continuation, not
    // repeatedly by recursive recovery)
    const callCount =
      (await agentStub.getOnChatMessageCallCount()) as unknown as number;
    expect(callCount).toBe(1);
  });
});
