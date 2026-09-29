import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { tool, type UIMessage } from "ai";
import { subscribe } from "agents/observability";
import {
  createMockModel,
  createToolCallingMockModel,
  type MockModelCallOptions,
  type ThinkProgrammaticTestAgent
} from "./agents/think-session";
import type {
  ChatResponseResult,
  SaveMessagesOptions,
  SaveMessagesResult,
  SubmitMessagesResult,
  TurnResult
} from "../think";
import { z } from "zod";

function textPart(message: { parts?: Array<{ type: string; text?: string }> }) {
  return message.parts?.find((part) => part.type === "text");
}

async function freshProgrammaticAgent(name: string) {
  return getAgentByName(
    env.ThinkProgrammaticTestAgent as unknown as DurableObjectNamespace<ThinkProgrammaticTestAgent>,
    `${name}-${crypto.randomUUID()}`
  );
}

async function runInProgrammaticAgent<T>(
  name: string,
  callback: (instance: ThinkProgrammaticTestAgent) => Promise<T>
): Promise<T> {
  const stub = await freshProgrammaticAgent(name);
  return runInDurableObject(stub, callback);
}

async function withOwnOverrides<T>(
  target: object,
  overrides: Readonly<Record<string, unknown>>,
  callback: () => Promise<T>
): Promise<T> {
  const originals = Object.keys(overrides).map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(target, key)
  }));
  for (const { key } of originals) {
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value: overrides[key]
    });
  }
  try {
    return await callback();
  } finally {
    for (const { key, descriptor } of originals.reverse()) {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        Reflect.deleteProperty(target, key);
      }
    }
  }
}

function lastUserPromptText(options: MockModelCallOptions): string {
  const prompt = options.prompt ?? [];
  for (let index = prompt.length - 1; index >= 0; index--) {
    const item = prompt[index];
    if (item?.role !== "user") continue;
    if (typeof item.content === "string") return item.content;
    return (item.content ?? [])
      .filter(
        (part): part is { type?: string; text: string } =>
          part.type === "text" && typeof part.text === "string"
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

type TurnObservabilityEvent = {
  type: string;
  name?: string;
  payload: {
    requestId?: string;
    trigger?: string;
    admission?: string;
    continuation?: boolean;
    status?: string;
    durationMs?: number;
    error?: string;
  };
};

function captureTurnEvents(name: string) {
  const events: TurnObservabilityEvent[] = [];
  const unsubscribe = subscribe("chat", (event) => {
    if (
      event.name?.startsWith(name) &&
      (event.type === "chat:turn:start" || event.type === "chat:turn:finish")
    ) {
      events.push(event as TurnObservabilityEvent);
    }
  });
  return { events, unsubscribe };
}

function expectTurnPair(
  events: TurnObservabilityEvent[],
  start: Record<string, unknown>,
  finish: Record<string, unknown>
) {
  expect(events.map((event) => event.type)).toEqual([
    "chat:turn:start",
    "chat:turn:finish"
  ]);
  expect(events[0].payload).toMatchObject(start);
  expect(events[1].payload).toMatchObject(finish);
  expect(events[0].payload.requestId).toBe(events[1].payload.requestId);
  expect(typeof events[1].payload.durationMs).toBe("number");
}

describe("Think — runTurn", () => {
  it("wait mode returns TurnResult equivalent to saveMessages", async () => {
    const agent = await freshProgrammaticAgent("runturn-wait-parity");
    await agent.setProgrammaticResponseForTest("RunTurn wait reply");

    const result = (await agent.testRunTurnWaitString(
      "Hello via runTurn"
    )) as TurnResult;

    expect(result.status).toBe("completed");
    expect(result.continuation).toBe(false);
    expect(result.requestId).toBeTruthy();
    expect(result.message?.role).toBe("assistant");
    expect(textPart(result.message ?? {})).toMatchObject({
      type: "text",
      text: "RunTurn wait reply"
    });

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("emits a minimal chat:turn start/finish pair for wait mode", async () => {
    const name = `runturn-events-wait-${crypto.randomUUID()}`;
    const agent = await freshProgrammaticAgent(name);
    await agent.setProgrammaticResponseForTest("Observed reply");
    const events: Array<{
      type: string;
      name?: string;
      payload: {
        requestId?: string;
        trigger?: string;
        admission?: string;
        continuation?: boolean;
        status?: string;
        durationMs?: number;
      };
    }> = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (
        event.name?.startsWith(name) &&
        (event.type === "chat:turn:start" || event.type === "chat:turn:finish")
      ) {
        events.push(event);
      }
    });

    let result: TurnResult;
    try {
      result = await agent.testRunTurnWaitString("observe wait");
    } finally {
      unsubscribe();
    }

    expect(events.map((event) => event.type)).toEqual([
      "chat:turn:start",
      "chat:turn:finish"
    ]);
    expect(events[0].payload).toMatchObject({
      requestId: result.requestId,
      trigger: "programmatic",
      admission: "queue",
      continuation: false
    });
    expect(events[1].payload).toMatchObject({
      requestId: result.requestId,
      trigger: "programmatic",
      admission: "queue",
      continuation: false,
      status: "completed"
    });
    expect(typeof events[1].payload.durationMs).toBe("number");
  });

  it("emits chat:turn metadata for continuation mode", async () => {
    const name = `runturn-events-continuation-${crypto.randomUUID()}`;
    const agent = await freshProgrammaticAgent(name);
    await agent.setProgrammaticResponseForTest("First answer");
    await agent.testRunTurnWaitString("Start");
    await agent.setProgrammaticResponseForTest("Continued answer");
    const { events, unsubscribe } = captureTurnEvents(name);

    let result: TurnResult;
    try {
      result = (await agent.testRunTurnContinuation()) as TurnResult;
    } finally {
      unsubscribe();
    }

    expectTurnPair(
      events,
      {
        requestId: result.requestId,
        trigger: "programmatic",
        admission: "queue",
        continuation: true
      },
      {
        requestId: result.requestId,
        trigger: "programmatic",
        admission: "queue",
        continuation: true,
        status: "completed"
      }
    );
  });

  it("emits chat:turn metadata for RPC chat", async () => {
    const name = `runturn-events-rpc-${crypto.randomUUID()}`;
    const agent = await freshProgrammaticAgent(name);
    await agent.setProgrammaticResponseForTest("RPC reply");
    const { events, unsubscribe } = captureTurnEvents(name);

    try {
      await agent.testChat("via rpc");
    } finally {
      unsubscribe();
    }

    expectTurnPair(
      events,
      {
        trigger: "rpc",
        admission: "queue",
        continuation: false
      },
      {
        trigger: "rpc",
        admission: "queue",
        continuation: false,
        status: "completed"
      }
    );
  });

  it("emits no chat:turn metadata for skipped empty wait input", async () => {
    const name = `runturn-events-empty-${crypto.randomUUID()}`;
    const agent = await freshProgrammaticAgent(name);
    const { events, unsubscribe } = captureTurnEvents(name);

    try {
      await agent.testRunTurnWait({ mode: "wait", input: "" });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(0);
  });

  it("emits ordered chat:turn pairs for sequential turns", async () => {
    const name = `runturn-events-sequential-${crypto.randomUUID()}`;
    const agent = await freshProgrammaticAgent(name);
    await agent.setProgrammaticResponseForTest("First reply");
    const { events, unsubscribe } = captureTurnEvents(name);

    try {
      await agent.testRunTurnWaitString("one");
      await agent.setProgrammaticResponseForTest("Second reply");
      await agent.testRunTurnWaitString("two");
    } finally {
      unsubscribe();
    }

    expect(events.map((event) => event.type)).toEqual([
      "chat:turn:start",
      "chat:turn:finish",
      "chat:turn:start",
      "chat:turn:finish"
    ]);
    expect(events[0].payload.requestId).toBe(events[1].payload.requestId);
    expect(events[2].payload.requestId).toBe(events[3].payload.requestId);
    expect(events[0].payload.requestId).not.toBe(events[2].payload.requestId);
  });

  it("does not expose channel on chat:turn metadata", async () => {
    const name = `runturn-events-channel-${crypto.randomUUID()}`;
    const agent = await freshProgrammaticAgent(name);
    await agent.setProgrammaticResponseForTest("Channel reply");
    const { events, unsubscribe } = captureTurnEvents(name);

    try {
      await agent.testRunTurnWait({
        mode: "wait",
        input: "via channel",
        channel: "web"
      });
    } finally {
      unsubscribe();
    }

    expectTurnPair(
      events,
      {
        trigger: "programmatic",
        admission: "queue",
        continuation: false
      },
      {
        trigger: "programmatic",
        admission: "queue",
        continuation: false,
        status: "completed"
      }
    );
    expect(Object.hasOwn(events[0].payload, "channel")).toBe(false);
    expect(Object.hasOwn(events[1].payload, "channel")).toBe(false);
  });

  it("wait mode supports array input", async () => {
    const agent = await freshProgrammaticAgent("runturn-wait-array");
    await agent.setProgrammaticResponseForTest("Array reply");

    const result = (await agent.testRunTurnWait({
      input: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "Array input" }]
        }
      ]
    })) as TurnResult;
    expect(result.status).toBe("completed");
    expect((await agent.getStoredMessages()) as UIMessage[]).toHaveLength(2);
  });

  it("wait mode supports function input", async () => {
    const agent = await freshProgrammaticAgent("runturn-wait-fn");
    await agent.testChat("Seed history");
    await agent.setProgrammaticResponseForTest("Function reply");

    const fnResult = (await agent.testRunTurnWaitWithFn(
      "Function input"
    )) as TurnResult;
    expect(fnResult.status).toBe("completed");
    expect(textPart(fnResult.message ?? {})).toMatchObject({
      type: "text",
      text: "Function reply"
    });

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
  });

  it("wait mode skips empty string and empty array without running a turn", async () => {
    const agent = await freshProgrammaticAgent("runturn-wait-empty");

    const emptyString = (await agent.testRunTurnWait({
      input: ""
    })) as TurnResult;
    expect(emptyString).toEqual({
      requestId: "",
      status: "skipped",
      continuation: false
    });

    const emptyArray = (await agent.testRunTurnWait({
      input: [] as UIMessage[]
    })) as TurnResult;
    expect(emptyArray).toEqual({
      requestId: "",
      status: "skipped",
      continuation: false
    });

    expect(await agent.getStoredMessages()).toHaveLength(0);
  });

  it("characterizes existing saveMessages empty-input behavior", async () => {
    const agent = await freshProgrammaticAgent("runturn-save-empty");
    await agent.setProgrammaticResponseForTest("Seed reply");
    await agent.testRunTurnWaitString("seed");
    await agent.setProgrammaticResponseForTest("Empty reply");

    const emptyArray = await agent.testSaveMessages([]);
    expect(emptyArray.status).toBe("completed");
    expect(Object.hasOwn(emptyArray, "messageId")).toBe(false);
    expect((await agent.getStoredMessages()) as UIMessage[]).toHaveLength(3);

    await agent.setProgrammaticResponseForTest("Empty function reply");
    const emptyFunction = await agent.testSaveMessagesEmptyFunction();
    expect(emptyFunction.status).toBe("completed");
    expect((await agent.getStoredMessages()) as UIMessage[]).toHaveLength(4);
  });

  it("continuation mode delegates to continueLastTurn", async () => {
    const agent = await freshProgrammaticAgent("runturn-continuation");
    await agent.setProgrammaticResponseForTest("First answer");

    await agent.testRunTurnWaitString("Start");
    await agent.setProgrammaticResponseForTest("Continued answer");

    const result = (await agent.testRunTurnContinuation()) as TurnResult;
    expect(result.status).toBe("completed");
    expect(result.continuation).toBe(true);
    expect(textPart(result.message ?? {})).toMatchObject({
      type: "text",
      text: "Continued answer"
    });

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant"
    ]);
  });

  it("returns the continuation message through a compatible legacy override", async () => {
    const agent = await freshProgrammaticAgent("runturn-continuation-override");
    await agent.setProgrammaticResponseForTest("Seed answer");
    await agent.testRunTurnWaitString("Seed question");
    await agent.setProgrammaticResponseForTest("Override continuation");

    const result = (await agent.testRunTurnContinuation()) as TurnResult;

    expect(result.status).toBe("completed");
    expect(textPart(result.message ?? {})).toMatchObject({
      type: "text",
      text: "Override continuation"
    });
  });

  it("continuation skips when latest leaf is not assistant", async () => {
    const agent = await freshProgrammaticAgent("runturn-continuation-skip");
    const result = (await agent.testRunTurnContinuation()) as TurnResult;
    expect(result).toMatchObject({
      requestId: "",
      status: "skipped",
      continuation: true
    });
    expect(result.message).toBeUndefined();
  });

  it("returns a queued continuation's own message before a follow-up turn", async () => {
    await runInProgrammaticAgent(
      "runturn-queued-continuation",
      async (instance) => {
        await instance.setProgrammaticResponseForTest("Seed answer");
        await instance.runTurn({ mode: "wait", input: "Seed question" });

        const baseBeforeTurn = instance.beforeTurn.bind(instance);
        const responses = ["Continuation answer", "Follow-up answer"];
        let responseIndex = 0;
        let markStarted = () => {};
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        let releaseTurn = () => {};
        const release = new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        let blockNextTurn = true;
        const getModel: ThinkProgrammaticTestAgent["getModel"] = () =>
          createMockModel(responses[responseIndex++] ?? "Unexpected answer");
        const beforeTurn: ThinkProgrammaticTestAgent["beforeTurn"] = async (
          context
        ) => {
          await baseBeforeTurn(context);
          if (!blockNextTurn) return;
          blockNextTurn = false;
          markStarted();
          await release;
        };
        await withOwnOverrides(instance, { getModel, beforeTurn }, async () => {
          try {
            const continuationPromise = instance.runTurn({
              mode: "wait",
              continuation: true
            });
            await started;
            const followUpPromise = instance.runTurn({
              mode: "wait",
              input: "Follow-up question"
            });
            releaseTurn();
            const [continuation, followUp] = await Promise.all([
              continuationPromise,
              followUpPromise
            ]);

            expect(continuation).toMatchObject({
              status: "completed",
              continuation: true
            });
            expect(textPart(continuation.message ?? {})).toMatchObject({
              type: "text",
              text: "Continuation answer"
            });
            expect(followUp).toMatchObject({
              status: "completed",
              continuation: false
            });
            expect(textPart(followUp.message ?? {})).toMatchObject({
              type: "text",
              text: "Follow-up answer"
            });
          } finally {
            releaseTurn();
          }
        });
      }
    );
  });

  it("returns persisted content when the response hook mutates history", async () => {
    await runInProgrammaticAgent(
      "runturn-response-hook-history",
      async (instance) => {
        const getModel: ThinkProgrammaticTestAgent["getModel"] = () =>
          createMockModel("Persisted answer");
        const onChatResponse: ThinkProgrammaticTestAgent["onChatResponse"] =
          async (response) => {
            const text = response.message.parts.find(
              (part) => part.type === "text"
            );
            if (text?.type === "text") text.text = "Mutated by response hook";
            await instance.addMessages([
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text: "Hook follow-up" }]
              }
            ]);
          };
        await withOwnOverrides(
          instance,
          { getModel, onChatResponse },
          async () => {
            const result = await instance.runTurn({
              mode: "wait",
              input: "Hook question"
            });

            expect(result.status).toBe("completed");
            expect(textPart(result.message ?? {})).toMatchObject({
              type: "text",
              text: "Persisted answer"
            });
            const messages = await instance.getStoredMessages();
            expect(textPart(messages.at(-1) ?? {})).toMatchObject({
              type: "text",
              text: "Hook follow-up"
            });
          }
        );
      }
    );
  });

  it("returns stored tool output with toJSON without suppressing the response hook", async () => {
    await runInProgrammaticAgent("runturn-to-json-output", async (instance) => {
      let responseHookCalls = 0;
      const getModel: ThinkProgrammaticTestAgent["getModel"] = () =>
        createToolCallingMockModel();
      const getTools: ThinkProgrammaticTestAgent["getTools"] = () => ({
        echo: tool({
          description: "Return an object serialized through its own toJSON",
          inputSchema: z.object({ message: z.string() }),
          execute: () => ({
            answer: 42,
            toJSON() {
              return { answer: 42 };
            }
          }),
          toModelOutput: ({ output }) => ({
            type: "text",
            value: JSON.stringify(output)
          })
        })
      });
      const onChatResponse: (result: ChatResponseResult) => void = () => {
        responseHookCalls++;
      };
      await withOwnOverrides(
        instance,
        { getModel, getTools, onChatResponse },
        async () => {
          const result = await instance.runTurn({
            mode: "wait",
            input: "Run the serialization tool"
          });
          const output = result.message?.parts.find((part) =>
            part.type.startsWith("tool-")
          )?.output;

          expect(result.status).toBe("completed");
          expect(textPart(result.message ?? {})).toMatchObject({
            type: "text",
            text: "Done with tools"
          });
          expect(output).toEqual({ answer: 42 });
          expect(responseHookCalls).toBe(1);
        }
      );
    });
  });

  it("does not borrow an old assistant when a continuation persists no content", async () => {
    const agent = await freshProgrammaticAgent("runturn-stripped-answer");
    await agent.setProgrammaticResponseForTest("Seed answer");
    await agent.testRunTurnWaitString("Seed question");
    await agent.setFinalAnswerResponseForTest({ answer: "Structured only" });

    const result = (await agent.testRunTurnContinuation()) as TurnResult;

    expect(result.status).toBe("completed");
    expect(result.message).toBeUndefined();
    expect((await agent.getStoredMessages()) as UIMessage[]).toHaveLength(2);
  });

  it("keeps the continuation's message when a later turn inherits its context", async () => {
    await runInProgrammaticAgent(
      "runturn-inherited-persist",
      async (instance) => {
        await instance.setProgrammaticResponseForTest("Seed answer");
        await instance.runTurn({ mode: "wait", input: "Seed question" });

        // `continueLastTurn` is protected; the override below replaces it the
        // way a subclass would.
        type ContinueLastTurn = (
          body?: Record<string, unknown>,
          options?: SaveMessagesOptions
        ) => Promise<SaveMessagesResult>;
        const baseContinueLastTurn = (
          instance as unknown as { continueLastTurn: ContinueLastTurn }
        ).continueLastTurn.bind(instance);
        const getModel: ThinkProgrammaticTestAgent["getModel"] = () =>
          createMockModel((options) =>
            lastUserPromptText(options) === "Side question"
              ? "Side answer"
              : "Continuation answer"
          );
        // A legacy override that runs a second turn after its continuation:
        // that turn persists inside this runTurn call's async context.
        const continueLastTurn: ContinueLastTurn = async (body, options) => {
          const result = await baseContinueLastTurn(body, options);
          await instance.saveMessages([
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "Side question" }]
            }
          ]);
          return result;
        };
        await withOwnOverrides(
          instance,
          { getModel, continueLastTurn },
          async () => {
            const result = await instance.runTurn({
              mode: "wait",
              continuation: true
            });

            expect(result.status).toBe("completed");
            expect(textPart(result.message ?? {})).toMatchObject({
              type: "text",
              text: "Continuation answer"
            });
            const messages = await instance.getStoredMessages();
            expect(textPart(messages.at(-1) ?? {})).toMatchObject({
              type: "text",
              text: "Side answer"
            });
          }
        );
      }
    );
  });

  it("omits a persisted partial message from an aborted turn result", async () => {
    await runInProgrammaticAgent("runturn-aborted-result", async (instance) => {
      await instance.setDelayedChunkResponse(["Partial", " answer"], 40);
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new Error("mid-stream runTurn abort")),
        60
      );

      const result = await instance.runTurn({
        mode: "wait",
        input: "Abort me",
        signal: controller.signal
      });

      expect(result.status).toBe("aborted");
      expect(result.message).toBeUndefined();
      expect(await instance.getStoredMessages()).toHaveLength(2);
    });
  });

  it("submit mode returns SubmitMessagesResult equivalent to submitMessages", async () => {
    const agent = await freshProgrammaticAgent("runturn-submit-parity");

    const result = (await agent.testRunTurnSubmit("Queued prompt", {
      submissionId: "sub-runturn-1",
      metadata: { source: "runTurn" }
    })) as SubmitMessagesResult;

    expect(result.accepted).toBe(true);
    expect(result.submissionId).toBe("sub-runturn-1");
    expect(result.status).toBe("pending");
    expect(result.metadata).toEqual({ source: "runTurn" });
  });

  it("emits chat:turn events when a durable submission drains, not when accepted", async () => {
    const name = `runturn-events-submit-${crypto.randomUUID()}`;
    const agent = await freshProgrammaticAgent(name);
    await agent.setDelayedChunkResponse(["submission ", "reply"], 50);
    const events: Array<{
      type: string;
      name?: string;
      payload: {
        requestId?: string;
        trigger?: string;
        admission?: string;
        continuation?: boolean;
        status?: string;
      };
    }> = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (
        event.name?.startsWith(name) &&
        (event.type === "chat:turn:start" || event.type === "chat:turn:finish")
      ) {
        events.push(event);
      }
    });

    try {
      const accepted = (await agent.testRunTurnSubmit("Queued prompt", {
        submissionId: "sub-runturn-events"
      })) as SubmitMessagesResult;
      expect(accepted.accepted).toBe(true);
      expect(events.some((event) => event.payload.admission === "submit")).toBe(
        false
      );

      await waitFor(() =>
        events.some((event) => event.type === "chat:turn:finish")
      );
    } finally {
      unsubscribe();
    }

    expect(events.map((event) => event.type)).toEqual([
      "chat:turn:start",
      "chat:turn:finish"
    ]);
    expect(events[0].payload).toMatchObject({
      requestId: "sub-runturn-events",
      trigger: "submission",
      admission: "queue",
      continuation: false
    });
    expect(events[1].payload).toMatchObject({
      requestId: "sub-runturn-events",
      trigger: "submission",
      admission: "queue",
      continuation: false,
      status: "completed"
    });
  });

  it("stream mode drives callback and resolves void like chat", async () => {
    const agent = await freshProgrammaticAgent("runturn-stream-parity");
    await agent.setProgrammaticResponseForTest("Streamed via runTurn");

    const result = await agent.testRunTurnStream("Stream me");
    expect(result.done).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.events.length).toBeGreaterThan(0);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(textPart(messages[1] ?? {})).toMatchObject({
      type: "text",
      text: "Streamed via runTurn"
    });
  });

  it("stream mode supports array input", async () => {
    const agent = await freshProgrammaticAgent("runturn-stream-array");
    await agent.setProgrammaticResponseForTest("Array streamed");

    const result = await agent.testRunTurnStreamArray([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Array one" }]
      },
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Array two" }]
      }
    ]);
    expect(result.done).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.events.length).toBeGreaterThan(0);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant"
    ]);
    expect(textPart(messages[2] ?? {})).toMatchObject({
      type: "text",
      text: "Array streamed"
    });
  });

  it("stream mode supports function input evaluated inside the turn", async () => {
    const agent = await freshProgrammaticAgent("runturn-stream-fn");
    await agent.testChat("Seed history");
    await agent.setProgrammaticResponseForTest("Function streamed");

    const result = await agent.testRunTurnStreamWithFn("Function stream input");
    expect(result.done).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.events.length).toBeGreaterThan(0);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
    expect(textPart(messages[2] ?? {})).toMatchObject({
      type: "text",
      text: "Function stream input"
    });
    expect(textPart(messages[3] ?? {})).toMatchObject({
      type: "text",
      text: "Function streamed"
    });
  });

  it("stream mode completes static empty input without running inference", async () => {
    const agent = await freshProgrammaticAgent("runturn-stream-empty-static");

    const emptyString = await agent.testRunTurnStreamEmpty("");
    expect(emptyString.requestId).toBeTruthy();
    expect(emptyString.done).toBe(true);
    expect(emptyString.error).toBeUndefined();
    expect(emptyString.events).toHaveLength(0);

    const emptyArray = await agent.testRunTurnStreamEmpty([]);
    expect(emptyArray.requestId).toBeTruthy();
    expect(emptyArray.done).toBe(true);
    expect(emptyArray.error).toBeUndefined();
    expect(emptyArray.events).toHaveLength(0);

    expect(await agent.getStoredMessages()).toHaveLength(0);
  });

  it("stream mode preserves function-returning-empty behavior", async () => {
    const agent = await freshProgrammaticAgent("runturn-stream-empty-fn");
    await agent.testChat("Seed history");
    await agent.setProgrammaticResponseForTest("Empty function streamed");

    const result = await agent.testRunTurnStreamEmpty(() => []);
    expect(result.error).toBeUndefined();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(3);
    expect(textPart(messages[2] ?? {})).toMatchObject({
      type: "text",
      text: "Empty function streamed"
    });
  });

  it("stream mode stamps channel metadata on array input", async () => {
    const agent = await freshProgrammaticAgent("runturn-stream-array-channel");
    await agent.setProgrammaticResponseForTest("Channel streamed");

    await agent.testRunTurnStreamArray(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "Channel one" }]
        },
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "Channel two" }]
        }
      ],
      "web"
    );

    const messages = (await agent.getStoredMessages()) as Array<
      UIMessage & { metadata?: { channel?: string } }
    >;
    expect(messages[0]?.metadata?.channel).toBe("web");
    expect(messages[1]?.metadata?.channel).toBe("web");
  });

  it("validates input vs continuation for wait mode", async () => {
    const agent = await freshProgrammaticAgent("runturn-validate-wait");

    const invalidMode = await agent.testRunTurnExpectError({
      mode: "bogus",
      input: "hi"
    });
    expect(invalidMode?.name).toBe("TypeError");
    expect(invalidMode?.message).toContain("mode must be");

    const neither = await agent.testRunTurnExpectError({ mode: "wait" });
    expect(neither?.name).toBe("TypeError");
    expect(neither?.message).toContain("either input or continuation");

    const both = await agent.testRunTurnExpectError({
      mode: "wait",
      input: "hi",
      continuation: true
    });
    expect(both?.name).toBe("TypeError");
    expect(both?.message).toContain("not both");
  });

  it("validates submit and stream require input", async () => {
    const agent = await freshProgrammaticAgent("runturn-validate-input");

    const submitMissing = await agent.testRunTurnExpectError({
      mode: "submit"
    });
    expect(submitMissing?.name).toBe("TypeError");
    expect(submitMissing?.message).toContain('mode "submit" requires input');

    const streamMissing = await agent.testRunTurnExpectError({
      mode: "stream",
      callback: {
        onStart() {},
        onEvent() {},
        onDone() {},
        onError() {}
      }
    });
    expect(streamMissing?.name).toBe("TypeError");
    expect(streamMissing?.message).toContain('mode "stream" requires input');
  });

  it("validates stream requires callback and disallows continuation", async () => {
    const agent = await freshProgrammaticAgent("runturn-validate-stream");

    const noCallback = await agent.testRunTurnExpectError({
      mode: "stream",
      input: "hi"
    });
    expect(noCallback?.name).toBe("TypeError");
    expect(noCallback?.message).toContain('mode "stream" requires callback');

    const continuationOnStream = await agent.testRunTurnExpectError({
      mode: "stream",
      input: "hi",
      continuation: true,
      callback: {
        onStart() {},
        onEvent() {},
        onDone() {},
        onError() {}
      }
    });
    expect(continuationOnStream?.name).toBe("TypeError");
    expect(continuationOnStream?.message).toContain("continuation");

    const fnSubmit = await agent.testRunTurnSubmitWithFunction();
    expect(fnSubmit?.message).toContain("function input");
  });

  it("returns each queued wait turn's own assistant message", async () => {
    await runInProgrammaticAgent("runturn-queued-results", async (instance) => {
      const getModel: ThinkProgrammaticTestAgent["getModel"] = () =>
        createMockModel((options) => {
          const prompt = lastUserPromptText(options);
          if (prompt === "First question") return "First answer";
          if (prompt === "Second question") return "Second answer";
          throw new Error(`Unexpected final user prompt: ${prompt}`);
        });
      await withOwnOverrides(instance, { getModel }, async () => {
        const [first, second] = await Promise.all([
          instance.runTurn({ mode: "wait", input: "First question" }),
          instance.runTurn({ mode: "wait", input: "Second question" })
        ]);

        expect(first.status).toBe("completed");
        expect(textPart(first.message ?? {})).toMatchObject({
          type: "text",
          text: "First answer"
        });
        expect(second.status).toBe("completed");
        expect(textPart(second.message ?? {})).toMatchObject({
          type: "text",
          text: "Second answer"
        });
        expect(first.message?.id).not.toBe(second.message?.id);

        const storedAssistantIds = (await instance.getStoredMessages())
          .filter((message) => message.role === "assistant")
          .map((message) => message.id);
        expect(storedAssistantIds).toHaveLength(2);
        expect(storedAssistantIds).toContain(first.message?.id);
        expect(storedAssistantIds).toContain(second.message?.id);
      });
    });
  });

  it("concurrent non-nested wait enqueues behind an active turn", async () => {
    const agent = await freshProgrammaticAgent("runturn-concurrent-wait");
    await agent.setDelayedChunkResponse(
      ["active ", "turn ", "still ", "running"],
      50
    );
    await agent.setProgrammaticResponseForTest("Queued wait reply");

    const activeTurn = agent.testChat("active turn");
    for (let attempt = 0; attempt < 80; attempt++) {
      const messages = (await agent.getStoredMessages()) as UIMessage[];
      if (
        messages.some(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) => part.type === "text" && part.text === "active turn"
            )
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const queued = (await agent.testRunTurnWaitString(
      "queued wait"
    )) as TurnResult;
    expect(queued.status).toBe("completed");
    expect(queued.continuation).toBe(false);

    await activeTurn;

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.length).toBeGreaterThanOrEqual(4);
  });

  it("throws for nested blocking admissions but allows submit and addMessages", async () => {
    const agent = await freshProgrammaticAgent("runturn-nested-admission");

    for (const mode of ["wait", "continuation", "stream"] as const) {
      const result = await agent.runNestedAdmissionScenario(mode);
      expect(result.attempted).toBe(true);
      expect(result.succeeded).toBe(false);
      expect(result.error).toContain("cannot be called from inside");
    }

    const submit = await agent.runNestedAdmissionScenario("submit");
    expect(submit).toMatchObject({
      attempted: true,
      succeeded: true,
      error: null
    });

    const addMessages = await agent.runNestedAdmissionScenario("addMessages");
    expect(addMessages).toMatchObject({
      attempted: true,
      succeeded: true,
      error: null
    });
  });
});
