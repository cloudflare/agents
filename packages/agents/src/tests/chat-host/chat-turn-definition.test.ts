import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import { chatTurnStreamId } from "../../chat/chat-host";

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
});
