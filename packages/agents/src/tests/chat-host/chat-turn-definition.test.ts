import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import {
  CHAT_CLEARED,
  chatTurnDefinition,
  chatTurnStreamId,
  runningChatTurn
} from "../../chat/chat-host";
import type { TaskStep } from "../../tasks/types";
import { TaskSettlement } from "../../tasks/settlement";
import { TaskCancellation } from "../../tasks/replay";
import type { ChatHost } from "../../chat/chat-host";

/** A later attempt of run `id`, as Tasks hands it after a reset. */
function laterAttempt(
  id: string,
  attempt = 2,
  signal: AbortSignal = new AbortController().signal,
  checkpoint = new Map<string, unknown>()
): TaskStep {
  return {
    id,
    attempt,
    checkpoint: {
      get: (key: string) => checkpoint.get(key),
      set: (key: string, value: unknown) => void checkpoint.set(key, value)
    },
    createdAt: 0,
    sleep: async () => {},
    signal,
    local: undefined,
    interrupted: null,
    do: async (_name: string, fn: () => unknown) => fn()
  } as unknown as TaskStep;
}

async function runTurn(instance: ChatTurnHostObject, input: unknown) {
  await instance.lifecycle.start();
  const receipt = await instance.tasks.run("__cf_chat_turn", input as never, {
    start: "now"
  });
  return receipt.runId;
}

describe("chatTurnDefinition", () => {
  it("calls respond with the transcript, streams the reply and stores it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      await instance.sessions.session("s1").appendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Hi" }]
      } as never);

      const runId = await runTurn(instance, {
        trigger: "submit-message",
        questionId: "u1",
        body: { model: "m" }
      });

      expect(instance.calls).toHaveLength(1);
      expect(instance.calls[0]).toMatchObject({
        session: "s1",
        requestId: runId,
        attempt: 1,
        mode: "answer",
        trigger: "submit-message",
        questionId: "u1",
        body: { model: "m" }
      });
      expect(instance.calls[0].messages.map((m) => m.id)).toEqual(["u1"]);
      const history = await instance.sessions.session("s1").getHistory();
      expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(history[1])).toContain("Hello");
      // The cutover dropped the stream with the reply stored.
      expect(await instance.streams.status(chatTurnStreamId(runId))).toBeNull();
      expect(instance.results).toEqual([
        { requestId: runId, status: "completed", messageId: history[1].id }
      ]);
    });
  });

  it("runs a step of the call once across attempts", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      let ran = 0;
      const respond = instance.host.respond;
      instance.host.respond = async (call) => {
        await call.step("tool-1", async () => ++ran);
        await call.step("tool-1", async () => ++ran);
        return respond(call);
      };
      await runTurn(instance, { trigger: "server" });
      expect(ran).toBe(1);
    });
  });

  it("stores nothing and reports skipped when respond answers nothing", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      instance.reply = null;
      const runId = await runTurn(instance, { trigger: "server" });
      expect(await instance.sessions.session("s1").getHistory()).toEqual([]);
      expect(instance.results).toEqual([
        { requestId: runId, status: "skipped" }
      ]);
    });
  });

  it("continues the reply an earlier attempt was cut off in, settling its cut-off tool", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Hi" }]
      } as never);
      // The earlier attempt streamed some text and a tool call, then the
      // object reset: the stream is still open.
      const cut = await instance.streams.open(chatTurnStreamId("run-1"), {
        tag: "run-1"
      });
      for (const chunk of [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hel" },
        { type: "text-end", id: "t1" },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "x",
          input: {}
        }
      ]) {
        cut.append(chunk as never);
      }
      instance.reply = [
        { type: "start", messageId: "other" },
        { type: "text-start", id: "t2" },
        { type: "text-delta", id: "t2", delta: "lo" },
        { type: "text-end", id: "t2" },
        { type: "finish" }
      ];

      const result = await chatTurnDefinition(
        {
          tasks: instance.tasks,
          streams: instance.streams,
          sessions: instance.sessions,
          session: "s1"
        },
        instance.host
      )({ trigger: "submit-message" }, laterAttempt("run-1"));

      expect(instance.calls[0]).toMatchObject({
        mode: "continue",
        replyId: "a1",
        attempt: 2
      });
      // The model sees the cut-off reply, its tool call settled.
      const sent = instance.calls[0].messages.at(-1);
      expect(sent?.id).toBe("a1");
      expect(JSON.stringify(sent)).toContain("output-error");
      const history = await session.getHistory();
      expect(history.map((m) => m.id)).toEqual(["u1", "a1"]);
      expect(JSON.stringify(history[1])).toContain("Hel");
      expect(JSON.stringify(history[1])).toContain("lo");
      // The text the cut left mid-stream is stored finished.
      expect(JSON.stringify(history[1])).not.toContain('"state":"streaming"');
      expect(result).toEqual({
        requestId: "run-1",
        status: "completed",
        messageId: "a1"
      });
      expect(
        await instance.streams.status(chatTurnStreamId("run-1"))
      ).toBeNull();
    });
  });

  it("a tool-answer turn continues the reply that asked for the tool", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Where am I?" }]
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-locate",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: { city: "Lisbon" }
          }
        ]
      } as never);

      await runTurn(instance, { trigger: "tool-answer" });
      expect(instance.calls[0]).toMatchObject({
        mode: "continue",
        replyId: "a1"
      });
      const history = await session.getHistory();
      expect(history.map((m) => m.id)).toEqual(["u1", "a1"]);
      expect(JSON.stringify(history[1])).toContain("Lisbon");
      expect(JSON.stringify(history[1])).toContain("Hello");
    });
  });

  const definitionOf = (instance: ChatTurnHostObject, host: ChatHost) =>
    chatTurnDefinition(
      {
        tasks: instance.tasks,
        streams: instance.streams,
        sessions: instance.sessions,
        session: "s1"
      },
      host
    );

  async function cutOff(instance: ChatTurnHostObject, runId: string) {
    await instance.lifecycle.start();
    const cut = await instance.streams.open(chatTurnStreamId(runId), {
      tag: runId
    });
    for (const chunk of [
      { type: "start", messageId: "a1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hel" }
    ]) {
      cut.append(chunk as never);
    }
  }

  it("gives up on a cut-off turn past its attempt budget, with the app's message and reason", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await cutOff(instance, "run-1");
      const exhausted: Array<{ reason: string; attempt: number }> = [];
      // Two attempts were made before, the last a minute ago, and none has
      // streamed more since the first was counted.
      const counted = new Map<string, unknown>([
        [
          "chat:incident",
          {
            incidentId: "run-1",
            requestId: "run-1",
            recoveryKind: "continue",
            attempt: 2,
            maxAttempts: 2,
            status: "attempting",
            firstSeenAt: Date.now() - 120_000,
            lastAttemptAt: Date.now() - 60_000,
            lastProgressAt: Date.now() - 120_000,
            progress: 1_000,
            workBaseline: 0
          }
        ]
      ]);
      const result = await definitionOf(instance, {
        ...instance.host,
        options: {
          recovery: {
            maxAttempts: 2,
            terminalMessage: "Sorry, that did not work.",
            onExhausted: (context) => {
              exhausted.push({
                reason: context.reason,
                attempt: context.attempt
              });
            }
          }
        }
      })(
        { trigger: "submit-message" },
        laterAttempt("run-1", 3, undefined, counted)
      );
      expect(result).toMatchObject({
        requestId: "run-1",
        status: "error",
        error: "Sorry, that did not work."
      });
      expect(exhausted).toEqual([
        { reason: "max_attempts_exceeded", attempt: 3 }
      ]);
      expect(instance.calls).toEqual([]);
      expect(
        await instance.streams.status(chatTurnStreamId("run-1"))
      ).toMatchObject({ state: "errored" });
      // What it streamed stays stored.
      const history = await instance.sessions.session("s1").getHistory();
      expect(JSON.stringify(history)).toContain("Hel");
    });
  });

  it("continues a turn cut off for the fourth time: the budget is ten attempts without progress", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await cutOff(instance, "run-1");
      const recoveries: number[] = [];
      const result = await definitionOf(instance, {
        ...instance.host,
        hooks: {
          ...instance.host.hooks,
          onRecovery: (context) => void recoveries.push(context.attempt)
        }
      })({ trigger: "submit-message" }, laterAttempt("run-1", 4));
      expect(result).toMatchObject({ requestId: "run-1", status: "completed" });
      // The first recovery of the turn, whatever the run's attempt number.
      expect(recoveries).toEqual([1]);
    });
  });

  it("ends a recovery the app declines with the failure that led to it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await cutOff(instance, "run-1");
      // The attempt before failed with a provider's transient error.
      const kept = new Map<string, unknown>([
        ["chat:failed", { text: "Network connection lost.", retries: 0 }]
      ]);
      const result = await definitionOf(instance, {
        ...instance.host,
        hooks: {
          ...instance.host.hooks,
          onRecovery: () => ({ continue: false })
        }
      })(
        { trigger: "submit-message" },
        laterAttempt("run-1", 2, undefined, kept)
      );
      expect(result).toMatchObject({
        requestId: "run-1",
        status: "error",
        error: "Network connection lost."
      });
      expect(instance.calls).toEqual([]);
    });
  });

  it("bounds recovery attempts that keep failing the same way by maxAttempts, however fast they come", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await cutOff(instance, "run-1");
      const reasons: string[] = [];
      // One attempt was counted a moment ago, and two recovery attempts
      // have failed with a transient error since.
      const kept = new Map<string, unknown>([
        [
          "chat:incident",
          {
            incidentId: "run-1",
            requestId: "run-1",
            recoveryKind: "continue",
            attempt: 1,
            maxAttempts: 2,
            status: "attempting",
            firstSeenAt: Date.now() - 2_000,
            lastAttemptAt: Date.now() - 1_000,
            progress: 1_000,
            workBaseline: 0
          }
        ],
        ["chat:failed", { text: "Network connection lost.", retries: 2 }]
      ]);
      const result = await definitionOf(instance, {
        ...instance.host,
        options: {
          recovery: {
            maxAttempts: 2,
            onExhausted: (context) => void reasons.push(context.reason)
          }
        }
      })(
        { trigger: "submit-message" },
        laterAttempt("run-1", 4, undefined, kept)
      );
      expect(result).toMatchObject({ requestId: "run-1", status: "error" });
      expect(reasons).toEqual(["max_attempts_exceeded"]);
      expect(instance.calls).toEqual([]);
    });
  });

  it("starts the attempt count again when the cut-off attempt streamed more", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await cutOff(instance, "run-1");
      // Two attempts were counted when nothing had been streamed yet.
      const counted = new Map<string, unknown>([
        [
          "chat:incident",
          {
            incidentId: "run-1",
            requestId: "run-1",
            recoveryKind: "retry",
            attempt: 2,
            maxAttempts: 2,
            status: "attempting",
            firstSeenAt: Date.now() - 120_000,
            lastAttemptAt: Date.now() - 60_000,
            progress: 0,
            workBaseline: 0
          }
        ]
      ]);
      const result = await definitionOf(instance, {
        ...instance.host,
        options: { recovery: { maxAttempts: 2 } }
      })(
        { trigger: "submit-message" },
        laterAttempt("run-1", 3, undefined, counted)
      );
      expect(result).toMatchObject({ requestId: "run-1", status: "completed" });
      expect(counted.get("chat:incident")).toMatchObject({ attempt: 1 });
    });
  });

  it("gives up when onRecovery says not to continue", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await cutOff(instance, "run-1");
      const result = await definitionOf(instance, {
        ...instance.host,
        hooks: { onRecovery: () => ({ continue: false }) }
      })({ trigger: "submit-message" }, laterAttempt("run-1", 2));
      expect(result).toMatchObject({ status: "error" });
      expect(instance.calls).toEqual([]);
    });
  });

  it("treats a stream that stalls as interrupted, to retry after a backoff", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const result = await definitionOf(instance, {
        respond: async () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "a1" });
              // Then nothing.
            }
          }),
        options: { recovery: { stallTimeoutMs: 20 } }
      })({ trigger: "server" }, laterAttempt("run-2", 1));
      expect(result).toBeInstanceOf(TaskSettlement);
      // The stream stays open for the next attempt to continue.
      expect(
        await instance.streams.status(chatTurnStreamId("run-2"))
      ).toMatchObject({ state: "streaming" });
    });
  });

  it("names the running turn to what respond starts, each time it is called, and to nothing else", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const seen: Array<string | undefined> = [];
      let calls = 0;
      expect(runningChatTurn()).toBeUndefined();
      const result = await definitionOf(instance, {
        respond: async (call) => {
          calls++;
          seen.push(runningChatTurn());
          // Still there after the call has waited on something.
          await Promise.resolve();
          await instance.sessions.session("s1").getHistory();
          seen.push(runningChatTurn());
          if (calls === 1) {
            // The first reply overflows: respond is called again.
            return new ReadableStream({
              start(controller) {
                controller.error(new Error("context too long"));
              }
            });
          }
          return instance.host.respond(call);
        },
        hooks: {
          classifyError: () => "overflow",
          onContextOverflow: async () => {
            // The hook is not part of the reply.
            seen.push(runningChatTurn());
            return true;
          }
        }
      })({ trigger: "server" }, laterAttempt("run-ctx", 1));
      expect(result).toMatchObject({ status: "completed" });
      expect(seen).toEqual([
        "run-ctx",
        "run-ctx",
        undefined,
        "run-ctx",
        "run-ctx"
      ]);
      expect(runningChatTurn()).toBeUndefined();
    });
  });

  it.each([
    "a stream",
    "an async iterable",
    "a response",
    "an object with toUIMessageStream"
  ] as const)(
    "names the running turn to a reply produced as it is read: %s",
    async (kind) => {
      const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
        await instance.lifecycle.start();
        const seen: Array<string | undefined> = [];
        let made: ReadableStream | undefined;
        const chunks = [
          { type: "start", messageId: "a1" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Hi" },
          { type: "text-end", id: "t1" },
          { type: "finish" }
        ];
        const result = await definitionOf(instance, {
          respond: async () => {
            if (kind === "a stream") {
              let next = 0;
              return (made = new ReadableStream({
                // Each chunk is made when it is asked for.
                pull(controller) {
                  seen.push(runningChatTurn());
                  if (next < chunks.length) {
                    controller.enqueue(chunks[next++] as never);
                  } else controller.close();
                }
              }));
            }
            if (kind === "a response") {
              const encoder = new TextEncoder();
              let next = 0;
              return new Response(
                new ReadableStream({
                  pull(controller) {
                    seen.push(runningChatTurn());
                    if (next < chunks.length) {
                      controller.enqueue(
                        encoder.encode(
                          `data: ${JSON.stringify(chunks[next++])}\n\n`
                        )
                      );
                    } else controller.close();
                  }
                }),
                { headers: { "content-type": "text/event-stream" } }
              );
            }
            const iterable = (async function* () {
              for (const chunk of chunks) {
                seen.push(runningChatTurn());
                yield chunk as never;
              }
            })();
            if (kind === "an async iterable") return iterable;
            // An iterator that says something else: it must not be read.
            const other = (async function* () {
              yield { type: "start", messageId: "a1" } as never;
              yield { type: "text-start", id: "t1" } as never;
              yield { type: "text-delta", id: "t1", delta: "Wrong" } as never;
              yield { type: "text-end", id: "t1" } as never;
              yield { type: "finish" } as never;
            })();
            // Both shapes at once: the method is the one that is read.
            return Object.assign(other, {
              toUIMessageStream: () => {
                seen.push(runningChatTurn());
                let next = 0;
                return new ReadableStream({
                  pull(controller) {
                    seen.push(runningChatTurn());
                    if (next < chunks.length) {
                      controller.enqueue(chunks[next++] as never);
                    } else controller.close();
                  }
                });
              }
            });
          }
        })({ trigger: "server" }, laterAttempt(`run-read-${kind}`, 1));
        expect(result).toMatchObject({ status: "completed" });
        const stored = await instance.sessions.session("s1").getHistory();
        expect(JSON.stringify(stored.at(-1))).toContain("Hi");
        expect(JSON.stringify(stored.at(-1))).not.toContain("Wrong");
        // The host's own stream is not left locked once it was read.
        if (kind === "a stream") expect(made?.locked).toBe(false);
        expect(seen.length).toBeGreaterThanOrEqual(chunks.length);
        expect(new Set(seen)).toEqual(new Set([`run-read-${kind}`]));
      });
    }
  );

  it.each([
    { name: "retry-after", headers: { "retry-after": "7" }, seconds: 7 },
    {
      name: "retry-after-ms",
      headers: { "retry-after-ms": "4200" },
      seconds: 5
    },
    {
      name: "a wait past the cap",
      headers: { "retry-after": "600" },
      seconds: 60
    }
  ])(
    "waits as long as the provider asked before the next attempt: $name",
    async ({ headers, seconds }) => {
      const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
        await instance.lifecycle.start();
        const before = Date.now();
        const result = await definitionOf(instance, {
          respond: async () =>
            new ReadableStream({
              start(controller) {
                controller.error(
                  Object.assign(new Error("Rate limit reached"), {
                    responseHeaders: headers
                  })
                );
              }
            }),
          hooks: { classifyError: () => "transient" }
        })({ trigger: "server" }, laterAttempt("run-2", 1));
        const after = Date.now();
        expect(result).toBeInstanceOf(TaskSettlement);
        const wakeAt = (result as TaskSettlement).wakeAt ?? 0;
        expect(wakeAt).toBeGreaterThanOrEqual(before + seconds * 1000);
        expect(wakeAt).toBeLessThanOrEqual(after + seconds * 1000);
      });
    }
  );

  it("asks the model again once after making room for a context overflow", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let calls = 0;
      let madeRoom = 0;
      const result = await definitionOf(instance, {
        respond: async (call) => {
          calls++;
          if (calls === 1) {
            return new ReadableStream({
              start(controller) {
                controller.error(new Error("context too long"));
              }
            });
          }
          return instance.host.respond(call);
        },
        hooks: {
          classifyError: () => "overflow",
          onContextOverflow: async () => {
            madeRoom++;
            return true;
          }
        }
      })({ trigger: "server" }, laterAttempt("run-3", 1));
      expect(madeRoom).toBe(1);
      expect(calls).toBe(2);
      expect(result).toMatchObject({ status: "completed" });
    });
  });

  it("sends every chunk and the end to the tabs", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      const tab = {
        id: "tab-1",
        readyState: 1,
        send: (text: string) => sent.push(JSON.parse(text))
      };
      await chatTurnDefinition(
        {
          tasks: instance.tasks,
          streams: instance.streams,
          sessions: instance.sessions,
          session: "s1",
          webSockets: { getConnections: () => [tab] } as never
        },
        instance.host
      )({ trigger: "server" }, laterAttempt("run-4", 1));
      expect(sent.map((frame) => frame.done)).toEqual([
        false,
        false,
        false,
        false,
        false,
        true
      ]);
      expect(sent[2]).toMatchObject({
        type: "cf_agent_use_chat_response",
        id: "run-4",
        body: JSON.stringify({ type: "text-delta", id: "t1", delta: "Hello" })
      });
      expect(sent.at(-1)).toMatchObject({ done: true, outcome: "completed" });
    });
  });

  it("reads a Response from respond: an event stream as UI chunks, plain text as one text part", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sse = [
        { type: "start", messageId: "sse-1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "From SSE" },
        { type: "text-end", id: "t1" }
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("");
      await definitionOf(instance, {
        respond: async () =>
          new Response(sse, {
            headers: { "content-type": "text/event-stream" }
          })
      })({ trigger: "server" }, laterAttempt("run-5", 1));
      await definitionOf(instance, {
        respond: async () => new Response("Plain words")
      })({ trigger: "server" }, laterAttempt("run-6", 1));
      const text = JSON.stringify(
        await instance.sessions.session("s1").getHistory()
      );
      expect(text).toContain("From SSE");
      expect(text).toContain("Plain words");
    });
  });

  it("a replay after the cutover does not answer again", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const checkpoint = new Map<string, unknown>();
      const signal = new AbortController().signal;
      const run = definitionOf(instance, instance.host);
      await run(
        { trigger: "server" },
        laterAttempt("run-7", 1, signal, checkpoint)
      );
      // A reset after the cutover, before the run returned: it runs again.
      const again = await run(
        { trigger: "server" },
        laterAttempt("run-7", 2, signal, checkpoint)
      );
      expect(instance.calls).toHaveLength(1);
      const replies = (
        await instance.sessions.session("s1").getHistory()
      ).filter((m) => m.role === "assistant");
      expect(replies).toHaveLength(1);
      expect(again).toMatchObject({
        status: "completed",
        messageId: replies[0].id
      });
    });
  });

  it("continues after a transient in-band error, which is not stored in the reply", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let calls = 0;
      const host: ChatHost = {
        respond: async () => {
          calls++;
          const chunks =
            calls === 1
              ? [
                  { type: "start", messageId: "a1" },
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "Hel" },
                  { type: "error", errorText: "overloaded" }
                ]
              : [
                  { type: "text-start", id: "t2" },
                  { type: "text-delta", id: "t2", delta: "lo" },
                  { type: "text-end", id: "t2" }
                ];
          return new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk as never);
              controller.close();
            }
          });
        },
        hooks: { classifyError: () => "transient" }
      };
      const first = await definitionOf(instance, host)(
        { trigger: "server" },
        laterAttempt("run-8", 1)
      );
      expect(first).toBeInstanceOf(TaskSettlement);
      const second = await definitionOf(instance, host)(
        { trigger: "server" },
        laterAttempt("run-8", 2)
      );
      expect(second).toMatchObject({ status: "completed", messageId: "a1" });
      const text = JSON.stringify(
        await instance.sessions.session("s1").getHistory()
      );
      expect(text).toContain("Hel");
      expect(text).toContain("lo");
      expect(text).not.toContain("overloaded");
    });
  });

  it("a stopped turn keeps what it streamed", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const stop = new AbortController();
      let passed!: () => void;
      const deltaPassed = new Promise<void>((resolve) => (passed = resolve));
      const result = await definitionOf(instance, {
        respond: async () =>
          new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: "start", messageId: "a1" });
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta: "Part"
              });
              // The user stops once the delta was stored.
              await deltaPassed;
              stop.abort();
              controller.error(new Error("stopped"));
            }
          }),
        hooks: {
          transformChunk: (chunk) => {
            if (chunk.type === "text-delta") passed();
            return chunk;
          }
        }
      })({ trigger: "server" }, laterAttempt("run-9", 1, stop.signal));
      expect(result).toMatchObject({ status: "aborted", messageId: "a1" });
      const history = await instance.sessions.session("s1").getHistory();
      expect(JSON.stringify(history)).toContain("Part");
    });
  });

  const stream = (chunks: unknown[]) =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk as never);
        controller.close();
      }
    });

  it("gives every plain-text reply its own message", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let n = 0;
      const host: ChatHost = {
        respond: async () => new Response(++n === 1 ? "First" : "Second")
      };
      await definitionOf(instance, host)(
        { trigger: "server" },
        laterAttempt("p1", 1)
      );
      await definitionOf(instance, host)(
        { trigger: "server" },
        laterAttempt("p2", 1)
      );
      const replies = (
        await instance.sessions.session("s1").getHistory()
      ).filter((m) => m.role === "assistant");
      expect(replies).toHaveLength(2);
      expect(JSON.stringify(replies)).toContain("First");
      expect(JSON.stringify(replies)).toContain("Second");
    });
  });

  it("a tool-answer turn cut off and continued keeps the answered tool and earlier text", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Where am I?" }]
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-locate",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: { city: "Lisbon" }
          }
        ]
      } as never);
      const checkpoint = new Map<string, unknown>();
      const signal = new AbortController().signal;
      let calls = 0;
      const host: ChatHost = {
        respond: async () =>
          ++calls === 1
            ? stream([
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", delta: "You are in" },
                { type: "error", errorText: "overloaded" }
              ])
            : stream([
                { type: "text-start", id: "t2" },
                { type: "text-delta", id: "t2", delta: " Lisbon." },
                { type: "text-end", id: "t2" }
              ]),
        hooks: { classifyError: () => "transient" }
      };
      const first = await definitionOf(instance, host)(
        { trigger: "tool-answer" },
        laterAttempt("ta-1", 1, signal, checkpoint)
      );
      expect(first).toBeInstanceOf(TaskSettlement);
      await definitionOf(instance, host)(
        { trigger: "tool-answer" },
        laterAttempt("ta-1", 2, signal, checkpoint)
      );
      const reply = JSON.stringify(
        (await session.getHistory()).find((m) => m.id === "a1")
      );
      expect(reply).toContain('"city":"Lisbon"');
      expect(reply).toContain("You are in");
      expect(reply).toContain(" Lisbon.");
    });
  });

  it("a turn whose model stream closes on a stop ends stopped, not completed", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const stop = new AbortController();
      const result = await definitionOf(instance, {
        respond: async () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "a1" });
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta: "The answer is"
              });
              stop.abort();
              // The model honours the signal by closing, not throwing.
              controller.close();
            }
          })
      })({ trigger: "server" }, laterAttempt("c-1", 1, stop.signal));
      expect(result).toMatchObject({ status: "aborted" });
    });
  });

  it("asks again after an overflow with the transcript the hook shortened", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      for (const id of ["u1", "u2", "u3"]) {
        await session.appendMessage({
          id,
          role: "user",
          parts: [{ type: "text", text: id }]
        } as never);
      }
      const seen: string[][] = [];
      await definitionOf(instance, {
        respond: async (call) => {
          seen.push(call.messages.map((m) => m.id));
          if (seen.length === 1) {
            return new ReadableStream({
              start(controller) {
                controller.error(new Error("too long"));
              }
            });
          }
          return instance.host.respond(call);
        },
        hooks: {
          classifyError: () => "overflow",
          onContextOverflow: async () => {
            await session.deleteMessages(["u1"]);
            return true;
          }
        }
      })({ trigger: "server" }, laterAttempt("o-1", 1));
      expect(seen[0]).toEqual(["u1", "u2", "u3"]);
      expect(seen[1]).toEqual(["u2", "u3"]);
    });
  });

  it("a regenerate of an older question sees nothing after it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: []
      } as never);
      await session.appendMessage({
        id: "u2",
        role: "user",
        parts: []
      } as never);
      await definitionOf(instance, instance.host)(
        { trigger: "regenerate-message", questionId: "u1" },
        laterAttempt("g-1", 1)
      );
      expect(instance.calls[0].messages.map((m) => m.id)).toEqual(["u1"]);
    });
  });

  it("continues without the partial when onRecovery keeps going but says not to keep it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await cutOff(instance, "run-p");
      await definitionOf(instance, {
        ...instance.host,
        hooks: { onRecovery: () => ({ continue: true, persist: false }) }
      })({ trigger: "submit-message" }, laterAttempt("run-p", 2));
      // The cut-off reply is gone before the model is asked again.
      expect(instance.calls[0]).toMatchObject({ mode: "answer" });
      expect(instance.calls[0].messages.map((m) => m.id)).not.toContain("a1");
    });
  });

  it("a stopped turn settles its server tool call and leaves a client tool call waiting", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const stop = new AbortController();
      let passed!: () => void;
      const bothPassed = new Promise<void>((resolve) => (passed = resolve));
      let count = 0;
      await definitionOf(instance, {
        respond: async () =>
          new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: "start", messageId: "a1" });
              controller.enqueue({
                type: "tool-input-available",
                toolCallId: "s1",
                toolName: "lookupOrder",
                input: {}
              });
              controller.enqueue({
                type: "tool-input-available",
                toolCallId: "c1",
                toolName: "askUser",
                input: {}
              });
              await bothPassed;
              stop.abort();
              controller.error(new Error("stopped"));
            }
          }),
        hooks: {
          transformChunk: (chunk) => {
            if (chunk.type === "tool-input-available" && ++count === 2)
              passed();
            return chunk;
          }
        }
      })(
        { trigger: "server", clientTools: [{ name: "askUser" }] },
        laterAttempt("st-1", 1, stop.signal)
      );
      const reply = (await instance.sessions.session("s1").getHistory()).find(
        (m) => m.id === "a1"
      ) as unknown as { parts: Array<{ toolCallId?: string; state?: string }> };
      expect(reply.parts.find((p) => p.toolCallId === "s1")?.state).toBe(
        "output-error"
      );
      expect(reply.parts.find((p) => p.toolCallId === "c1")?.state).toBe(
        "input-available"
      );
    });
  });

  it("a reply continued after a reset stores the cut text part finished", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await cutOff(instance, "run-s");
      await definitionOf(instance, instance.host)(
        { trigger: "submit-message" },
        laterAttempt("run-s", 2)
      );
      const text = JSON.stringify(
        await instance.sessions.session("s1").getHistory()
      );
      expect(text).toContain("Hel");
      expect(text).not.toContain('"state":"streaming"');
    });
  });

  it("a regenerated reply is a new branch under its question, in the run's own session", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("other");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "old",
        role: "assistant",
        parts: [{ type: "text", text: "Old" }]
      } as never);
      await definitionOf(instance, instance.host)(
        { trigger: "regenerate-message", questionId: "u1", session: "other" },
        laterAttempt("rg-1", 1)
      );
      expect(instance.calls[0].session).toBe("other");
      const branches = await session.getBranches("u1");
      expect(branches).toHaveLength(2);
      expect(branches.map((m) => m.id)).toContain("old");
    });
  });

  it("a tool-answer turn that recovery restarts without its partial keeps the tool answer", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-locate",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: { city: "Lisbon" }
          }
        ]
      } as never);
      // The first attempt continued a1, then the object reset.
      const checkpoint = new Map<string, unknown>([
        ["chat:base", { id: "a1", parts: 1 }]
      ]);
      const cut = await instance.streams.open(chatTurnStreamId("ta-2"), {
        tag: "ta-2"
      });
      for (const chunk of [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "You are in" }
      ]) {
        cut.append(chunk as never);
      }
      await definitionOf(instance, {
        ...instance.host,
        hooks: { onRecovery: () => ({ continue: true, persist: false }) }
      })(
        { trigger: "tool-answer" },
        laterAttempt("ta-2", 2, new AbortController().signal, checkpoint)
      );
      const reply = JSON.stringify(await session.getMessage("a1"));
      expect(reply).toContain('"city":"Lisbon"');
      expect(reply).not.toContain("You are in");
    });
  });

  it("text recovery discarded does not come back when the next attempt is cut off too", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await cutOff(instance, "run-d");
      const checkpoint = new Map<string, unknown>();
      const signal = new AbortController().signal;
      let recoveries = 0;
      let calls = 0;
      const host: ChatHost = {
        respond: async () =>
          ++calls === 1
            ? stream([
                { type: "start", messageId: "b1" },
                { type: "text-start", id: "t2" },
                { type: "text-delta", id: "t2", delta: "Option B" },
                { type: "error", errorText: "overloaded" }
              ])
            : stream([
                { type: "text-start", id: "t3" },
                { type: "text-delta", id: "t3", delta: " done" },
                { type: "text-end", id: "t3" }
              ]),
        hooks: {
          classifyError: () => "transient",
          onRecovery: () =>
            ++recoveries === 1
              ? { continue: true, persist: false }
              : { continue: true }
        }
      };
      const second = await definitionOf(instance, host)(
        { trigger: "submit-message" },
        laterAttempt("run-d", 2, signal, checkpoint)
      );
      expect(second).toBeInstanceOf(TaskSettlement);
      await definitionOf(instance, host)(
        { trigger: "submit-message" },
        laterAttempt("run-d", 3, signal, checkpoint)
      );
      const history = JSON.stringify(
        await instance.sessions.session("s1").getHistory()
      );
      expect(history).toContain("Option B");
      expect(history).not.toContain("Hel");
    });
  });

  it("a chat clear delivered through Tasks keeps nothing of the turn", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const stop = new AbortController();
      let passed!: () => void;
      const deltaPassed = new Promise<void>((resolve) => (passed = resolve));
      const result = await definitionOf(instance, {
        respond: async () =>
          new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: "start", messageId: "a1" });
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta: "Part"
              });
              await deltaPassed;
              // How Tasks.cancel aborts a live attempt.
              stop.abort(new TaskCancellation(CHAT_CLEARED));
              controller.error(new Error("stopped"));
            }
          }),
        hooks: {
          transformChunk: (chunk) => {
            if (chunk.type === "text-delta") passed();
            return chunk;
          }
        }
      })({ trigger: "server" }, laterAttempt("clr-1", 1, stop.signal));
      expect(result).toMatchObject({ status: "aborted" });
      expect(await instance.sessions.session("s1").getHistory()).toEqual([]);
    });
  });

  it("a regenerate continued after a reset stays on its question's new branch", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "old",
        role: "assistant",
        parts: [{ type: "text", text: "Old" }]
      } as never);
      await cutOff(instance, "rg-2");
      await definitionOf(instance, instance.host)(
        { trigger: "regenerate-message", questionId: "u1" },
        laterAttempt("rg-2", 2)
      );
      const branches = await session.getBranches("u1");
      expect(branches.map((m) => m.id).sort()).toEqual(["a1", "old"]);
    });
  });

  it("a client tool call cut off before its input finished is settled, not left waiting", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const cut = await instance.streams.open(chatTurnStreamId("ct-1"), {
        tag: "ct-1"
      });
      for (const chunk of [
        { type: "start", messageId: "a1" },
        { type: "tool-input-start", toolCallId: "c1", toolName: "askUser" },
        { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"q' }
      ]) {
        cut.append(chunk as never);
      }
      await definitionOf(instance, instance.host)(
        { trigger: "server", clientTools: [{ name: "askUser" }] },
        laterAttempt("ct-1", 2)
      );
      const reply = (await instance.sessions
        .session("s1")
        .getMessage("a1")) as unknown as {
        parts: Array<{ toolCallId?: string; state?: string }>;
      };
      expect(reply.parts.find((p) => p.toolCallId === "c1")?.state).toBe(
        "output-error"
      );
    });
  });

  it("marks the first frame of a continuation that sent no start as a continuation", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Asked" }]
      } as never);
      const sent: Array<Record<string, unknown>> = [];
      const tab = {
        id: "tab-1",
        readyState: 1,
        send: (text: string) => sent.push(JSON.parse(text))
      };
      await chatTurnDefinition(
        {
          tasks: instance.tasks,
          streams: instance.streams,
          sessions: instance.sessions,
          session: "s1",
          webSockets: { getConnections: () => [tab] } as never
        },
        {
          respond: async () =>
            stream([
              { type: "text-start", id: "t2" },
              { type: "text-delta", id: "t2", delta: " more" },
              { type: "text-end", id: "t2" }
            ])
        }
      )({ trigger: "tool-answer" }, laterAttempt("cf-1", 1));
      expect(sent[0]).toMatchObject({ continuation: true });
      expect(JSON.parse(String(sent[0].body))).toMatchObject({
        type: "start",
        messageId: "a1"
      });
    });
  });

  it("a server tool that runs longer than the stall timeout is not a stall", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const result = await definitionOf(instance, {
        respond: async () =>
          new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: "start", messageId: "a1" });
              controller.enqueue({
                type: "tool-input-available",
                toolCallId: "c1",
                toolName: "slow",
                input: {}
              });
              // The tool runs for five stall timeouts.
              await new Promise((resolve) => setTimeout(resolve, 100));
              controller.enqueue({
                type: "tool-output-available",
                toolCallId: "c1",
                output: "done"
              });
              controller.close();
            }
          }),
        options: { recovery: { stallTimeoutMs: 20 } }
      })({ trigger: "server" }, laterAttempt("slow-1", 1));
      expect(result).toMatchObject({ status: "completed" });
      const reply = (await instance.sessions
        .session("s1")
        .getMessage("a1")) as unknown as {
        parts: Array<{ toolCallId?: string; state?: string }>;
      };
      expect(reply.parts.find((p) => p.toolCallId === "c1")?.state).toBe(
        "output-available"
      );
    });
  });

  it("an approved tool cut off by a reset is reported interrupted, not run again", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-gate",
            toolCallId: "c1",
            state: "approval-responded",
            input: {},
            approval: { id: "ap1", approved: true }
          }
        ]
      } as never);
      // The tool-answer turn that runs the approved tool was cut off.
      const checkpoint = new Map<string, unknown>([
        ["chat:base", { id: "a1", parts: 1 }]
      ]);
      const cut = await instance.streams.open(chatTurnStreamId("ap-1"), {
        tag: "ap-1"
      });
      cut.append({ type: "start", messageId: "a1" } as never);
      await definitionOf(instance, instance.host)(
        { trigger: "tool-answer" },
        laterAttempt("ap-1", 2, new AbortController().signal, checkpoint)
      );
      const part = (
        instance.calls[0].messages.find((m) => m.id === "a1") as unknown as {
          parts: Array<{ toolCallId?: string; state?: string }>;
        }
      ).parts.find((p) => p.toolCallId === "c1");
      expect(part?.state).toBe("output-error");
    });
  });

  async function approvedReply(instance: ChatTurnHostObject, tool: string) {
    const session = instance.sessions.session("s1");
    await session.appendMessage({ id: "u1", role: "user", parts: [] } as never);
    await session.appendMessage({
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: `tool-${tool}`,
          toolCallId: "c1",
          state: "approval-responded",
          input: {},
          approval: { id: "ap1", approved: true }
        }
      ]
    } as never);
  }

  it("an approved tool that runs longer than the stall timeout in its continuation is not a stall", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      await approvedReply(instance, "gate");
      const result = await definitionOf(instance, {
        respond: async () =>
          new ReadableStream({
            async start(controller) {
              // The approved tool runs for five stall timeouts, announcing
              // nothing before its output.
              await new Promise((resolve) => setTimeout(resolve, 100));
              controller.enqueue({
                type: "tool-output-available",
                toolCallId: "c1",
                output: "ran"
              });
              controller.close();
            }
          }),
        options: { recovery: { stallTimeoutMs: 20 } }
      })({ trigger: "tool-answer" }, laterAttempt("ap-2", 1));
      expect(result).toMatchObject({ status: "completed" });
    });
  });

  it("a call waiting for approval does not hold the stall watchdog off", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const result = await definitionOf(instance, {
        respond: async () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "a1" });
              controller.enqueue({
                type: "tool-input-available",
                toolCallId: "c1",
                toolName: "gate",
                input: {}
              });
              controller.enqueue({
                type: "tool-approval-request",
                toolCallId: "c1",
                approvalId: "ap1"
              });
              // Then the model goes silent without closing.
            }
          }),
        options: { recovery: { stallTimeoutMs: 20 } }
      })({ trigger: "server" }, laterAttempt("ap-3", 1));
      expect(result).toBeInstanceOf(TaskSettlement);
    });
  });

  it("a tool's progress output does not end its run for the stall watchdog", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const result = await definitionOf(instance, {
        respond: async () =>
          new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: "start", messageId: "a1" });
              controller.enqueue({
                type: "tool-input-available",
                toolCallId: "c1",
                toolName: "slow",
                input: {}
              });
              controller.enqueue({
                type: "tool-output-available",
                toolCallId: "c1",
                output: "half",
                preliminary: true
              });
              await new Promise((resolve) => setTimeout(resolve, 100));
              controller.enqueue({
                type: "tool-output-available",
                toolCallId: "c1",
                output: "done"
              });
              controller.close();
            }
          }),
        options: { recovery: { stallTimeoutMs: 20 } }
      })({ trigger: "server" }, laterAttempt("pr-1", 1));
      expect(result).toMatchObject({ status: "completed" });
    });
  });

  it("an approved client tool cut off by a reset still waits for the tab's result", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      await approvedReply(instance, "ask");
      const checkpoint = new Map<string, unknown>([
        ["chat:base", { id: "a1", parts: 1 }]
      ]);
      const cut = await instance.streams.open(chatTurnStreamId("ap-4"), {
        tag: "ap-4"
      });
      cut.append({ type: "start", messageId: "a1" } as never);
      await definitionOf(instance, instance.host)(
        { trigger: "tool-answer", clientTools: [{ name: "ask" }] },
        laterAttempt("ap-4", 2, new AbortController().signal, checkpoint)
      );
      const part = (
        instance.calls[0].messages.find((m) => m.id === "a1") as unknown as {
          parts: Array<{ toolCallId?: string; state?: string }>;
        }
      ).parts.find((p) => p.toolCallId === "c1");
      expect(part?.state).toBe("approval-responded");
    });
  });

  /**
   * Run a turn whose model streams `chunks`, then waits until the returned
   * `release` is called. `stored()` reads the turn's stream as a reset would
   * find it: the rows, without flushing what is buffered.
   */
  async function heldTurn(instance: ChatTurnHostObject, chunks: unknown[]) {
    await instance.lifecycle.start();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const allSent = new Promise<void>((resolve) => (reached = resolve));
    let count = 0;
    const done = definitionOf(instance, {
      respond: async () =>
        new ReadableStream({
          async start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk as never);
            await released;
            controller.close();
          }
        }),
      hooks: {
        transformChunk: (chunk) => {
          if (++count === chunks.length) reached();
          return chunk;
        }
      }
    })({ trigger: "server" }, laterAttempt("held-1", 1));
    await allSent;
    const stored = async () => {
      const stop = new AbortController();
      const types: string[] = [];
      try {
        for await (const batch of instance.streams.readBatches(
          chatTurnStreamId("held-1"),
          { signal: stop.signal, onUpToDate: () => stop.abort() }
        )) {
          for (const item of batch) {
            types.push((item.chunk as { type: string }).type);
          }
          if (stop.signal.aborted) break;
        }
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
      return types;
    };
    return {
      stored,
      finish: async () => {
        release();
        await done;
      }
    };
  }

  it("a server tool's call is written before the tool runs, so a reset while it runs keeps it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      const turn = await heldTurn(instance, [
        { type: "start", messageId: "a1" },
        { type: "start-step" },
        { type: "tool-input-start", toolCallId: "s1", toolName: "lookup" },
        {
          type: "tool-input-available",
          toolCallId: "s1",
          toolName: "lookup",
          input: {}
        }
      ]);
      expect(await turn.stored()).toContain("tool-input-available");
      await turn.finish();
    });
  });

  it("a part's first delta is written at once", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      const turn = await heldTurn(instance, [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hi" }
      ]);
      expect(await turn.stored()).toContain("text-delta");
      await turn.finish();
    });
  });

  it("a finished step is written at once", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      // After the first delta (written at once), the rest of the step is
      // batched until the step ends.
      const turn = await heldTurn(instance, [
        { type: "start", messageId: "a1" },
        { type: "start-step" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "a" },
        { type: "text-delta", id: "t1", delta: "b" },
        { type: "text-end", id: "t1" },
        { type: "finish-step" }
      ]);
      expect(await turn.stored()).toContain("finish-step");
      await turn.finish();
    });
  });

  it("a part id used again in a later step has its first delta written at once", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      const turn = await heldTurn(instance, [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "one" },
        { type: "text-end", id: "t" },
        {
          type: "tool-input-available",
          toolCallId: "s1",
          toolName: "lookup",
          input: {}
        },
        { type: "tool-output-available", toolCallId: "s1", output: 1 },
        // The next call reuses the part id.
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "two" }
      ]);
      const types = await turn.stored();
      expect(types.filter((t) => t === "text-delta")).toHaveLength(2);
      await turn.finish();
    });
  });

  it("what the model sent is written when it pauses, while the turn is still live", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      const turn = await heldTurn(instance, [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "a" },
        { type: "text-delta", id: "t1", delta: "b" },
        { type: "text-delta", id: "t1", delta: "c" }
      ]);
      // The model is quiet now: after it, everything it sent is stored.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        (await turn.stored()).filter((t) => t === "text-delta")
      ).toHaveLength(3);
      await turn.finish();
    });
  });

  it("a new reply's stream starts at seq 0", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      const turn = await heldTurn(instance, [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "a" }
      ]);
      const stop = new AbortController();
      const seqs: number[] = [];
      try {
        for await (const batch of instance.streams.readBatches(
          chatTurnStreamId("held-1"),
          { signal: stop.signal, onUpToDate: () => stop.abort() }
        )) {
          for (const item of batch) seqs.push((item as { seq: number }).seq);
          if (stop.signal.aborted) break;
        }
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
      expect(seqs[0]).toBe(0);
      await turn.finish();
    });
  });

  it("a reply's other chunks are written in batches, not one row write each", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      // After the first delta (written at once), four more in one burst.
      const turn = await heldTurn(instance, [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "a" },
        { type: "text-delta", id: "t1", delta: "b" },
        { type: "text-delta", id: "t1", delta: "c" },
        { type: "text-delta", id: "t1", delta: "d" },
        { type: "text-delta", id: "t1", delta: "e" }
      ]);
      expect((await turn.stored()).length).toBeLessThan(7);
      await turn.finish();
    });
  });

  it("a chunk over the capability's chunk limit is refused, not buffered", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const result = await definitionOf(instance, {
        respond: async () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "a1" });
              controller.enqueue({ type: "text-start", id: "t1" });
              // Over the default 1 MiB chunk limit, under the row budget.
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta: "x".repeat(1_100_000)
              });
              controller.close();
            }
          })
      })({ trigger: "server" }, laterAttempt("big-1", 1));
      expect(result).toMatchObject({ status: "error" });
    });
  });

  it("a tool cut off after only progress output is reported interrupted, not given the progress as its result", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const cut = await instance.streams.open(chatTurnStreamId("pg-1"), {
        tag: "pg-1"
      });
      for (const chunk of [
        { type: "start", messageId: "a1" },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "slow",
          input: {}
        },
        {
          type: "tool-output-available",
          toolCallId: "c1",
          output: "half",
          preliminary: true
        }
      ]) {
        cut.append(chunk as never);
      }
      await definitionOf(instance, instance.host)(
        { trigger: "server" },
        laterAttempt("pg-1", 2)
      );
      const part = (
        instance.calls[0].messages.find((m) => m.id === "a1") as unknown as {
          parts: Array<{ toolCallId?: string; state?: string }>;
        }
      ).parts.find((p) => p.toolCallId === "c1");
      expect(part?.state).toBe("output-error");
    });
  });
});
