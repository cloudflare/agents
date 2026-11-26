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
});
