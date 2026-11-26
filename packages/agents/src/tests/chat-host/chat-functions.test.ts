import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Connection } from "agents";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import { chatDispatch } from "../../chat/chat-functions";

const tab = { id: "tab-1", send: () => {} } as unknown as Connection;

function chatRequest(id: string, text: string) {
  return JSON.stringify({
    type: "cf_agent_use_chat_request",
    id,
    init: {
      method: "POST",
      body: JSON.stringify({
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text }] }],
        model: "m"
      })
    }
  });
}

describe("chat functions over a minimal host", () => {
  it("a chat request frame stores the question and runs a turn that stores the reply", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const done = instance.nextResult();
      expect(
        await chatDispatch(
          instance.deps,
          instance.lane,
          tab,
          chatRequest("r1", "Hi")
        )
      ).toBe(true);
      expect(await done).toMatchObject({
        requestId: "r1",
        status: "completed"
      });
      expect(instance.calls[0]).toMatchObject({
        trigger: "submit-message",
        questionId: "u1",
        body: { model: "m" }
      });
      const history = await instance.sessions.session("s1").getHistory();
      expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    });
  });

  it("a clear frame empties the transcript", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await done;
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({ type: "cf_agent_chat_clear" })
      );
      expect(await instance.sessions.session("s1").getHistory()).toEqual([]);
    });
  });

  it("a tool result stores the answer and, with autoContinue, continues the reply", async () => {
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
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({
          type: "cf_agent_tool_result",
          toolCallId: "c1",
          toolName: "locate",
          output: { city: "Lisbon" },
          autoContinue: true
        })
      );
      await done;
      expect(instance.calls[0].trigger).toBe("tool-answer");
      const answered = (await session.getHistory()).find((m) => m.id === "a1");
      expect(JSON.stringify(answered)).toContain("output-available");
      expect(JSON.stringify(answered)).toContain("Lisbon");
    });
  });

  it("a resume request is offered the streaming turn, and its ack replays what it streamed", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      const reconnected = {
        id: "tab-2",
        readyState: 1,
        send: (text: string) => sent.push(JSON.parse(text))
      } as unknown as Connection;

      // Nothing streams yet.
      await chatDispatch(
        instance.deps,
        instance.lane,
        reconnected,
        JSON.stringify({ type: "cf_agent_stream_resume_request" })
      );
      expect(sent.at(-1)).toMatchObject({
        type: "cf_agent_stream_resume_none"
      });

      // A turn streams one chunk, then waits until the test lets it end.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let streaming!: () => void;
      const started = new Promise<void>((resolve) => (streaming = resolve));
      const respond = instance.host.respond;
      instance.host.respond = async () =>
        new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "start", messageId: "reply-1" });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "Hel" });
            await released;
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.close();
          }
        });
      // The turn has stored the delta once the hook sees it pass.
      const hooks = instance.host.hooks as {
        transformChunk?: (chunk: { type: string }) => unknown;
      };
      hooks.transformChunk = (chunk) => {
        if (chunk.type === "text-delta") streaming();
        return chunk;
      };
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await started;

      await chatDispatch(
        instance.deps,
        instance.lane,
        reconnected,
        JSON.stringify({ type: "cf_agent_stream_resume_request" })
      );
      expect(sent.at(-1)).toMatchObject({
        type: "cf_agent_stream_resuming",
        id: "r1"
      });
      await chatDispatch(
        instance.deps,
        instance.lane,
        reconnected,
        JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "r1" })
      );
      const replayed = sent.filter((frame) => frame.replay === true);
      expect(
        replayed.map((frame) => JSON.parse(frame.body as string).type)
      ).toContain("text-delta");
      release();
      await done;
      instance.host.respond = respond;
      delete hooks.transformChunk;
    });
  });

  it("a resume while a turn is accepted but not streaming keeps the tab waiting, then offers the stream", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let called!: () => void;
      const inRespond = new Promise<void>((resolve) => (called = resolve));
      const respond = instance.host.respond;
      instance.host.respond = async (call) => {
        called();
        await released;
        return respond(call);
      };
      const sent: Array<Record<string, unknown>> = [];
      const waiting = {
        id: "tab-w",
        readyState: 1,
        send: (text: string) => sent.push(JSON.parse(text))
      } as unknown as Connection;
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await inRespond;
      await chatDispatch(
        instance.deps,
        instance.lane,
        waiting,
        JSON.stringify({ type: "cf_agent_stream_resume_request" })
      );
      expect(sent[0]).toMatchObject({
        type: "cf_agent_stream_pending",
        id: "r1"
      });
      release();
      await done;
      expect(sent[1]).toMatchObject({
        type: "cf_agent_stream_resuming",
        id: "r1"
      });
      instance.host.respond = respond;
    });
  });

  it("a chat request without messages ends at once with the reason", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      await chatDispatch(
        instance.deps,
        instance.lane,
        {
          id: "tab-e",
          readyState: 1,
          send: (text: string) => sent.push(JSON.parse(text))
        } as unknown as Connection,
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: "bad",
          init: { method: "POST", body: JSON.stringify({ model: "m" }) }
        })
      );
      expect(sent[0]).toMatchObject({ id: "bad", done: true, error: true });
      expect(instance.calls).toEqual([]);
    });
  });
});
