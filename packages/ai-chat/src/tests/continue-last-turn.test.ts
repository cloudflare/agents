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
  getRequestContextForTest(): Promise<{
    body: Record<string, unknown> | undefined;
    clientTools: unknown[] | undefined;
  }>;
  setRequestContextForTest(
    body: Record<string, unknown> | undefined,
    clientTools: Array<{ name: string }>
  ): Promise<void>;
  setIncludeReasoning(value: boolean): Promise<void>;
  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    ageMs?: number
  ): Promise<void>;
  triggerInterruptedStreamCheck(): Promise<void>;
  runRecoveryContinueForTest(options?: {
    targetAssistantId?: string;
    originMessageIds?: string[];
    incidentId?: string;
    originalRequestId?: string;
  }): Promise<void>;
  throwFromNextTurnForTest(message: string | null): Promise<void>;
  seedIncidentForTest(incident: Record<string, unknown>): Promise<void>;
  getChatRecoveryIncidentsForTest(): Promise<unknown[]>;
  probeToolCallDurabilityForTest(): Promise<{
    beforeCall: number;
    afterCall: number;
  }>;
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
      reason?: string;
    };
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("nothing-to-continue");

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

  it("stores a tool call before the tool runs, so a reset mid-run leaves a record of it", async () => {
    const agentStub = await getTestAgent(crypto.randomUUID());

    const { beforeCall, afterCall } =
      await agentStub.probeToolCallDurabilityForTest();

    // The first reasoning delta is stored at once, the second waits in the
    // buffer (D121). The call brings it to storage.
    expect(beforeCall).toBe(1);
    expect(afterCall).toBeGreaterThan(beforeCall);
  });

  it("keeps a server tool call cut off mid-run, settled as an error that says it may have run", async () => {
    const agentStub = await getTestAgent(crypto.randomUUID());
    await agentStub.setRecoveryOverride({ continue: false });
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Weather?" }]
      }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedStream(
      "tool-stream",
      "tool-request",
      [
        { type: "start", messageId: "assistant-tool" },
        { type: "start-step" },
        { type: "reasoning-start" },
        { type: "reasoning-delta", delta: "Let me look." },
        { type: "reasoning-end" },
        { type: "tool-input-start", toolCallId: "tc1", toolName: "getWeather" },
        {
          type: "tool-input-available",
          toolCallId: "tc1",
          toolName: "getWeather",
          input: { city: "Paris" }
        }
      ].map((chunk, index) => ({ body: JSON.stringify(chunk), index }))
    );
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const call = messages
      .find((message) => message.id === "assistant-tool")
      ?.parts.find((part) => part.type === "tool-getWeather");
    expect(call).toMatchObject({
      state: "output-error",
      errorText:
        "The tool call was interrupted before a result was recorded. The tool may still have run."
    });
  });

  // A reply left with nothing a client can show and nothing a model request
  // can carry is not stored, and one that is stored is removed.
  describe("a reply that holds nothing", () => {
    const question = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Think about it" }]
    } as ChatMessage;
    const reasoningOnly = {
      id: "assistant-reasoning",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "Let me think", state: "streaming" }
      ]
    } as ChatMessage;
    const reasoningChunks = [
      { type: "start", messageId: "assistant-partial" },
      { type: "start-step" },
      { type: "reasoning-start" },
      { type: "reasoning-delta", delta: "Let me think" }
    ];
    const asStream = (chunks: Array<Record<string, unknown>>) =>
      chunks.map((chunk, index) => ({ body: JSON.stringify(chunk), index }));

    it("does not store a reply cut off while the model was still reasoning", async () => {
      const agentStub = await getTestAgent(crypto.randomUUID());
      await agentStub.setRecoveryOverride({ continue: false });
      await agentStub.persistMessages([question]);

      await agentStub.insertInterruptedStream(
        "reasoning-stream",
        "reasoning-request",
        asStream(reasoningChunks)
      );
      await agentStub.triggerInterruptedStreamCheck();

      const messages =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(messages.map((message) => message.id)).toEqual(["user-1"]);
    });

    it("does not store a reply cut off right after its text part opened", async () => {
      const agentStub = await getTestAgent(crypto.randomUUID());
      await agentStub.setRecoveryOverride({ continue: false });
      await agentStub.persistMessages([question]);

      // An empty text part is not content. Stored, a continuation would
      // write its answer into it, in front of its own reasoning.
      await agentStub.insertInterruptedStream(
        "empty-text-stream",
        "empty-text-request",
        asStream([
          ...reasoningChunks,
          { type: "reasoning-end" },
          { type: "text-start" }
        ])
      );
      await agentStub.triggerInterruptedStreamCheck();

      const messages =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(messages.map((message) => message.id)).toEqual(["user-1"]);
    });

    it("continueLastTurn over a stored reply that is only reasoning removes it and answers the question", async () => {
      const agentStub = await getTestAgent(crypto.randomUUID());
      // The previous release stored a reply stopped in its reasoning.
      await agentStub.persistMessages([question, reasoningOnly]);

      const result = await agentStub.callContinueLastTurn();
      await agentStub.waitForIdleForTest();

      expect(result.status).toBe("completed");
      expect(await agentStub.getOnChatMessageCallCount()).toBe(1);
      const messages =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
      expect(messages[1].id).not.toBe("assistant-reasoning");
      expect(JSON.stringify(messages[1].parts)).toContain(
        "Continued response."
      );
    });

    it("a second run of the same continue attempt answers the question", async () => {
      const agentStub = await getTestAgent(crypto.randomUUID());
      await agentStub.persistMessages([question, reasoningOnly]);
      // The first attempt removes the empty reply, then its turn fails with
      // a platform transient (a deploy reset).
      await agentStub.throwFromNextTurnForTest("Network connection lost.");
      await agentStub
        .runRecoveryContinueForTest({
          targetAssistantId: "assistant-reasoning"
        })
        .catch(() => {});
      await agentStub.waitForIdleForTest();
      expect(
        ((await agentStub.getPersistedMessages()) as ChatMessage[]).map(
          (message) => message.id
        )
      ).toEqual(["user-1"]);

      // The Task delivers the same continue payload again.
      await agentStub.runRecoveryContinueForTest({
        targetAssistantId: "assistant-reasoning"
      });
      await agentStub.waitForIdleForTest();

      const messages =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
    });

    it("records the removal on the incident, so a second delivery of the payload retries", async () => {
      const agentStub = await getTestAgent(crypto.randomUUID());
      await agentStub.persistMessages([question, reasoningOnly]);
      await agentStub.seedIncidentForTest({
        incidentId: "inc-removed",
        requestId: "req-removed",
        recoveryKind: "continue",
        attempt: 1,
        maxAttempts: 6,
        status: "scheduled",
        firstSeenAt: Date.now(),
        lastAttemptAt: Date.now()
      });
      const payload = {
        incidentId: "inc-removed",
        originalRequestId: "req-removed",
        targetAssistantId: "assistant-reasoning"
      };
      // The first run removes the empty reply, then its retry turn fails
      // with a platform transient.
      await agentStub.throwFromNextTurnForTest("Network connection lost.");
      await agentStub.runRecoveryContinueForTest(payload).catch(() => {});
      await agentStub.waitForIdleForTest();
      expect(await agentStub.getChatRecoveryIncidentsForTest()).toEqual([
        expect.objectContaining({ replyRemoved: true })
      ]);

      await agentStub.runRecoveryContinueForTest(payload);
      await agentStub.waitForIdleForTest();

      const messages =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
    });

    it("a continue attempt whose reply is gone leaves a newer question alone", async () => {
      const agentStub = await getTestAgent(crypto.randomUUID());
      // The reply is gone and the latest message is another question, not
      // the one the interrupted request came from.
      await agentStub.persistMessages([
        question,
        {
          id: "user-2",
          role: "user",
          parts: [{ type: "text", text: "Something else" }]
        }
      ] as ChatMessage[]);

      await agentStub.runRecoveryContinueForTest({
        targetAssistantId: "assistant-reasoning",
        originMessageIds: ["user-1"]
      });
      await agentStub.waitForIdleForTest();

      expect(await agentStub.getOnChatMessageCallCount()).toBe(0);
    });

    it("a recovery that would continue it removes it and answers the question again", async () => {
      const agentStub = await getTestAgent(crypto.randomUUID());
      await agentStub.persistMessages([question, reasoningOnly]);

      await agentStub.runRecoveryContinueForTest({
        targetAssistantId: "assistant-reasoning"
      });
      await agentStub.waitForIdleForTest();

      expect(await agentStub.getOnChatMessageCallCount()).toBe(1);
      const messages =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
      expect(messages[1].id).not.toBe("assistant-reasoning");
      expect(JSON.stringify(messages[1].parts)).toContain(
        "Continued response."
      );
    });
  });

  it("opens a new text part after the one the interruption cut off", async () => {
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

    // The cut-off part is closed and kept. The continuation writes its own.
    expect(textParts).toEqual([
      { type: "text", text: "Beginning", state: "done" },
      { type: "text", text: "Continued response.", state: "done" }
    ]);
  });

  it("puts a continuation's reasoning after the cut-off text, and its text after that", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setIncludeReasoning(true);
    // Cut off after some text, with no reasoning before it. The continuation
    // reasons first. Its text used to be written into the old part, which
    // left the reply as text, then reasoning.
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Tell me a story" }]
      },
      {
        id: "assistant-cut-off",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "Partial ", state: "streaming" }
        ]
      }
    ] as ChatMessage[]);

    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = messages.find(
      (m: ChatMessage) => m.id === "assistant-cut-off"
    )!;
    expect(
      assistant.parts.map((part) => [
        part.type,
        (part as { text?: string }).text
      ])
    ).toEqual([
      ["step-start", undefined],
      ["text", "Partial "],
      ["reasoning", "Thinking about continuation."],
      ["text", "Continued response."]
    ]);
    expect(assistant.parts.at(-1)?.type).not.toBe("reasoning");
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

  it("keeps a cut-off reply's reasoning and text, and appends the continuation's after them", async () => {
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

    expect(
      assistant.parts.map((part) => [
        part.type,
        (part as { text?: string }).text
      ])
    ).toEqual([
      ["reasoning", "Original thinking."],
      ["text", "Partial answer"],
      ["reasoning", "Thinking about continuation."],
      ["text", "Continued response."]
    ]);
  });

  it("should preserve orphaned continuation reasoning as a new part after completed reasoning", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Approve this" }]
      },
      {
        id: "assistant-orphan-reasoning",
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "Initial completed thinking.",
            state: "done"
          },
          {
            type: "tool-changeBackgroundColor",
            toolCallId: "call-orphan-reasoning",
            state: "output-available",
            input: { color: "blue" },
            output: { success: true }
          }
        ] as ChatMessage["parts"]
      }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedStream("orphan-reasoning", "orphan-req", [
      { body: JSON.stringify({ type: "start" }), index: 0 },
      { body: JSON.stringify({ type: "reasoning-start" }), index: 1 },
      {
        body: JSON.stringify({
          type: "reasoning-delta",
          delta: "Recovered continuation thinking."
        }),
        index: 2
      },
      { body: JSON.stringify({ type: "reasoning-end" }), index: 3 },
      { body: JSON.stringify({ type: "text-start" }), index: 4 },
      {
        body: JSON.stringify({
          type: "text-delta",
          delta: "Recovered continuation answer."
        }),
        index: 5
      },
      { body: JSON.stringify({ type: "text-end" }), index: 6 },
      { body: JSON.stringify({ type: "finish" }), index: 7 }
    ]);
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = messages.find(
      (m: ChatMessage) => m.id === "assistant-orphan-reasoning"
    )!;

    const reasoningParts = assistant.parts.filter(
      (p: ChatMessage["parts"][number]) => p.type === "reasoning"
    );
    expect(reasoningParts).toHaveLength(2);
    expect(reasoningParts[0]).toMatchObject({
      text: "Initial completed thinking.",
      state: "done"
    });
    expect(reasoningParts[1]).toMatchObject({
      text: "Recovered continuation thinking.",
      state: "done"
    });

    const textParts = assistant.parts.filter(
      (p: ChatMessage["parts"][number]) => p.type === "text"
    );
    expect(textParts).toHaveLength(1);
    expect(textParts[0]).toMatchObject({
      text: "Recovered continuation answer.",
      state: "done"
    });
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

  it("repairs a dead server-tool orphan before continuing (pre-inference chokepoint, no recovery callback)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    // Seed an assistant turn that was cut off mid-flight: a SERVER tool left at
    // `input-available` (its `execute()` died with the isolate, nothing will
    // resolve it). `previewTool` is NOT a client tool and no clientTools are set
    // for this agent, so `hasPendingClientInteraction()` is false — the repair
    // guard lets it through. This drives `continueLastTurn` DIRECTLY (not via a
    // chat-recovery callback), proving the repair runs at the pre-inference
    // chokepoint, so the next `convertToModelMessages` won't 400 with
    // `AI_MissingToolResultsError`. Mirrors `@cloudflare/think` repairing before
    // every inference, independent of `chatRecovery`.
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Preview it" }]
      },
      {
        id: "assistant-orphan",
        role: "assistant",
        parts: [
          { type: "text", text: "Working on it" },
          {
            type: "tool-previewTool",
            toolCallId: "call_assistant-orphan",
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ] as ChatMessage[]);

    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const orphan = messages.find((m) => m.id === "assistant-orphan")!;
    const toolPart = orphan.parts.find(
      (p) =>
        "toolCallId" in p &&
        (p as { toolCallId?: string }).toolCallId === "call_assistant-orphan"
    ) as { state?: string } | undefined;
    // The dead orphan was flipped to a settled (errored) result.
    expect(toolPart?.state).toBe("output-error");

    // It actually CONTINUED (ran inference once) rather than wedging on the
    // dangling tool call.
    expect(await agentStub.getOnChatMessageCallCount()).toBe(1);
  });

  it("does NOT repair a pending CLIENT-tool interaction on continue, and does not call the model over it", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    // A CLIENT tool genuinely awaiting the user must NOT be repaired — flipping
    // it to an error would clobber a result the client may still replay. Mark
    // `chooseOption` as a registered client tool, then leave it at
    // `input-available`: the shared `shouldRepair` skip leaves that part verbatim
    // so it stays pending.
    await agentStub.setRequestContextForTest({ model: "stored" }, [
      { name: "chooseOption" }
    ]);
    await agentStub.persistMessages([
      {
        id: "user-0",
        role: "user",
        parts: [{ type: "text", text: "Earlier" }]
      },
      {
        id: "assistant-earlier",
        role: "assistant",
        parts: [
          {
            type: "tool-previewTool",
            toolCallId: "call_earlier",
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      },
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Pick one" }]
      },
      {
        id: "assistant-client",
        role: "assistant",
        parts: [
          {
            type: "tool-chooseOption",
            toolCallId: "call_assistant-client",
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ] as ChatMessage[]);

    // The reply still waits on the client, so there is nothing to continue
    // yet: the turn is skipped and the model is never called. A request built
    // from this transcript would hold a tool call with no result.
    const result = (await agentStub.callContinueLastTurn({
      model: "from the skipped call"
    })) as { requestId: string; status: string; reason?: string };
    // The result says why, so the app can wait for the answer or settle the
    // call itself, and it names no request: nothing ran.
    expect(result).toEqual({
      requestId: "",
      status: "skipped",
      reason: "awaiting-client"
    });
    await agentStub.waitForIdleForTest();
    expect(await agentStub.getOnChatMessageCallCount()).toBe(0);
    // A skipped call leaves the chat as it found it: the stored body is not
    // replaced by the body of a call that did nothing, and nothing is
    // repaired, not even in the reply the chat moved past.
    expect((await agentStub.getRequestContextForTest()).body).toEqual({
      model: "stored"
    });
    expect(
      ((await agentStub.getPersistedMessages()) as ChatMessage[])
        .find((m) => m.id === "assistant-earlier")
        ?.parts.at(0)
    ).toMatchObject({ state: "input-available" });

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = messages.find((m) => m.id === "assistant-client")!;
    const toolPart = assistant.parts.find(
      (p) =>
        "toolCallId" in p &&
        (p as { toolCallId?: string }).toolCallId === "call_assistant-client"
    ) as { state?: string } | undefined;
    // Still pending — the per-part skip left the client interaction untouched.
    expect(toolPart?.state).toBe("input-available");
  });

  it("removes the reasoning a cut-off reply ends in before it continues it", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    // The reply ran a server tool and was cut off right after the model's
    // reasoning for the next step. Sent as it is, Anthropic rejects the
    // request: the assistant message's final block is a thinking block.
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Preview it" }]
      },
      {
        id: "assistant-reasoning",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-previewTool",
            toolCallId: "call_preview",
            state: "output-available",
            input: {},
            output: { ok: true }
          },
          { type: "step-start" },
          {
            type: "reasoning",
            text: "The preview worked, so",
            state: "done",
            providerMetadata: { anthropic: { signature: "sig" } }
          }
        ] as ChatMessage["parts"]
      }
    ] as ChatMessage[]);

    const result = await agentStub.callContinueLastTurn();
    expect(result.status).toBe("completed");
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const reply = messages.find((m) => m.id === "assistant-reasoning")!;
    // The cut-off reasoning is gone, the tool result stays, and the
    // continuation's answer follows it.
    expect(reply.parts.some((part) => part.type === "reasoning")).toBe(false);
    expect(reply.parts[1]).toMatchObject({ state: "output-available" });
    expect(reply.parts.at(-1)).toMatchObject({ type: "text" });
  });

  it("settles an approved call that never ran in a reply the chat moved past", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    // The user approved a call, then the conversation moved on without a
    // continuation running it. The AI SDK runs an approval only in the last
    // message, so a continuation of the later reply can never run it, and
    // the provider would get a tool call with no result.
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Delete it" }]
      },
      {
        id: "assistant-approved",
        role: "assistant",
        parts: [
          {
            type: "tool-deleteFile",
            toolCallId: "call_approved",
            state: "approval-responded",
            input: {},
            approval: { id: "approval-1", approved: true }
          }
        ] as ChatMessage["parts"]
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Something else" }]
      },
      {
        id: "assistant-leaf",
        role: "assistant",
        parts: [{ type: "text", text: "Partial answer" }]
      }
    ] as ChatMessage[]);

    const result = await agentStub.callContinueLastTurn();
    expect(result.status).toBe("completed");
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(
      messages.find((m) => m.id === "assistant-approved")?.parts[0]
    ).toMatchObject({
      state: "output-error",
      errorText:
        "The tool call was approved but did not run before the next turn started."
    });
  });

  it("settles an abandoned client orphan in a reply the chat moved past, and the leaf server orphan", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    // `chooseOption` is a registered client tool; `previewTool` is not (server).
    // An EARLIER assistant message holds an abandoned client orphan
    // (`input-available` chooseOption), and the LEAF assistant holds a fresh dead
    // SERVER orphan. The conversation moved past the earlier reply, so its call
    // is settled too: the provider rejects a request that holds a call with no
    // result, whoever owns it.
    await agentStub.setRequestContextForTest(undefined, [
      { name: "chooseOption" }
    ]);
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "First" }]
      },
      {
        id: "assistant-buried-client",
        role: "assistant",
        parts: [
          {
            type: "tool-chooseOption",
            toolCallId: "call_buried-client",
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Second" }]
      },
      {
        id: "assistant-leaf-server",
        role: "assistant",
        parts: [
          {
            type: "tool-previewTool",
            toolCallId: "call_leaf-server",
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ] as ChatMessage[]);

    await agentStub.callContinueLastTurn();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const partState = (messageId: string, toolCallId: string) => {
      const m = messages.find((msg) => msg.id === messageId)!;
      const p = m.parts.find(
        (part) =>
          "toolCallId" in part &&
          (part as { toolCallId?: string }).toolCallId === toolCallId
      ) as { state?: string } | undefined;
      return p?.state;
    };

    // Both are settled.
    expect(partState("assistant-buried-client", "call_buried-client")).toBe(
      "output-error"
    );
    expect(partState("assistant-leaf-server", "call_leaf-server")).toBe(
      "output-error"
    );
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
