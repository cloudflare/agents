import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import {
  CHAT_CLEARED,
  chatTurnDefinition,
  chatTurnStreamId
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

  it("gives up on a cut-off turn past its attempt budget", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await cutOff(instance, "run-1");
      const result = await definitionOf(instance, {
        ...instance.host,
        options: { recovery: { maxAttempts: 2 } }
      })({ trigger: "submit-message" }, laterAttempt("run-1", 3));
      expect(result).toMatchObject({ requestId: "run-1", status: "error" });
      expect(instance.calls).toEqual([]);
      expect(
        await instance.streams.status(chatTurnStreamId("run-1"))
      ).toMatchObject({ state: "errored" });
      // What it streamed stays stored.
      const history = await instance.sessions.session("s1").getHistory();
      expect(JSON.stringify(history)).toContain("Hel");
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
});
