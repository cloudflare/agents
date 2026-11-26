import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import { chatTurnDefinition, chatTurnStreamId } from "../../chat/chat-host";
import type { TaskStep } from "../../tasks/types";
import { TaskSettlement } from "../../tasks/settlement";
import type { ChatHost } from "../../chat/chat-host";

/** A later attempt of run `id`, as Tasks hands it after a reset. */
function laterAttempt(id: string, attempt = 2): TaskStep {
  return {
    id,
    attempt,
    createdAt: 0,
    sleep: async () => {},
    signal: new AbortController().signal,
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
});
