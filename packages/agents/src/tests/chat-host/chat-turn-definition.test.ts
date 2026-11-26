import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import { chatTurnDefinition, chatTurnStreamId } from "../../chat/chat-host";
import type { TaskStep } from "../../tasks/types";

/** A later attempt of run `id`, as Tasks hands it after a reset. */
function laterAttempt(id: string): TaskStep {
  return {
    id,
    attempt: 2,
    signal: new AbortController().signal,
    local: undefined,
    interrupted: null,
    do: async (_name: string, fn: () => unknown) => fn()
  } as unknown as TaskStep;
}

async function runTurn(instance: ChatTurnHostObject, input: unknown) {
  await instance.lifecycle.start();
  const receipt = await instance.tasks.run("turn", input as never, {
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
      expect(
        await instance.streams.status(chatTurnStreamId(runId))
      ).toMatchObject({ state: "completed" });
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
      ).toMatchObject({ state: "completed" });
    });
  });
});
