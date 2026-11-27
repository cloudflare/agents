import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import type { ChatHost, ChatModelCall } from "../../chat/chat-host";
import { submitTurn } from "../../chat/chat-functions";
import {
  agentToolTurnChunks,
  agentToolTurnId,
  agentToolTurnOf,
  cancelAgentToolTurn,
  inspectAgentToolTurn,
  recordAgentToolProgress,
  startAgentToolTurn
} from "../../chat/agent-tool-turns";

const input = {
  id: "in-1",
  role: "user" as const,
  parts: [{ type: "text" as const, text: "do the thing" }]
};

/** The output and summary of a completed turn: the reply's id is enough here. */
const collect = (messageId: string | undefined) => ({
  output: messageId ?? null,
  summary: messageId ? `reply ${messageId}` : null
});

describe("agent-tool runs as chat turns", () => {
  it("runs under its own turn id and is read off that run when it settles", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      await startAgentToolTurn(instance.deps, instance.lane, "run-1", input, {
        startMessageId: null
      });
      const result = await instance.resultFor(agentToolTurnId("run-1"));
      expect(result.status).toBe("completed");
      // The run settles right after it reports.
      await instance.tasks.wait(agentToolTurnId("run-1"));
      expect(agentToolTurnOf(instance.deps, agentToolTurnId("run-1"))).toEqual({
        runId: "run-1",
        startMessageId: null
      });
      expect(
        inspectAgentToolTurn(instance.deps, "run-1", collect)
      ).toMatchObject({
        runId: "run-1",
        status: "completed",
        output: "reply-1",
        summary: "reply reply-1"
      });
    });
  });

  it("reads a live turn's chunks by their place in its stream", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const host = instance.host as { respond: ChatHost["respond"] };
      let sent!: () => void;
      const streamed = new Promise<void>((resolve) => {
        sent = resolve;
      });
      let finish!: () => void;
      host.respond = async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "start", messageId: "reply-live" });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "Hi" });
            sent();
            finish = () => {
              controller.enqueue({ type: "text-end", id: "t1" });
              controller.enqueue({ type: "finish" });
              controller.close();
            };
          }
        });
      await startAgentToolTurn(
        instance.deps,
        instance.lane,
        "run-live",
        input,
        {
          startMessageId: null
        }
      );
      await streamed;
      // The turn records what it read from the model as it goes.
      let chunks = await agentToolTurnChunks(instance.deps, "run-live");
      for (let i = 0; chunks.length < 3 && i < 200; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        chunks = await agentToolTurnChunks(instance.deps, "run-live");
      }
      expect(chunks.map((chunk) => JSON.parse(chunk.body).type)).toEqual([
        "start",
        "text-start",
        "text-delta"
      ]);
      // Numbered by the stream's own positions, in order, one apart.
      const first = chunks[0].sequence;
      expect(chunks.map((chunk) => chunk.sequence)).toEqual([
        first,
        first + 1,
        first + 2
      ]);
      expect(
        (
          await agentToolTurnChunks(instance.deps, "run-live", {
            afterSequence: first
          })
        ).map((chunk) => chunk.sequence)
      ).toEqual([first + 1, first + 2]);
      finish();
      await instance.tasks.wait(agentToolTurnId("run-live"));
    });
  });

  it("keeps its progress and milestones after it settles", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const host = instance.host as { respond: ChatHost["respond"] };
      const respond = host.respond;
      host.respond = async (call: ChatModelCall) => {
        recordAgentToolProgress(instance.deps, call.requestId, {
          kind: "milestone",
          milestone: { name: "found", sequence: 0, at: 1 }
        });
        recordAgentToolProgress(instance.deps, call.requestId, {
          kind: "progress",
          snapshot: { at: 2, message: "half way" }
        });
        return respond(call);
      };
      await startAgentToolTurn(instance.deps, instance.lane, "run-2", input, {
        startMessageId: null
      });
      await instance.tasks.wait(agentToolTurnId("run-2"));
      expect(
        inspectAgentToolTurn(instance.deps, "run-2", collect)
      ).toMatchObject({
        status: "completed",
        progress: { at: 2, message: "half way" },
        milestones: [{ name: "found", at: 1 }]
      });
    });
  });

  it("ends aborted with the parent's reason when cancelled", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const host = instance.host as { respond: ChatHost["respond"] };
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      host.respond = async (call: ChatModelCall) =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "start", messageId: "reply-slow" });
            started();
            call.signal.addEventListener("abort", () => controller.close());
          }
        });
      await startAgentToolTurn(instance.deps, instance.lane, "run-3", input, {
        startMessageId: null
      });
      await running;
      expect(
        await cancelAgentToolTurn(instance.deps, "run-3", "the parent stopped")
      ).toBe(true);
      expect(
        inspectAgentToolTurn(instance.deps, "run-3", collect)
      ).toMatchObject({ status: "aborted", error: "the parent stopped" });
    });
  });

  it("has nothing for a run id the child never took, and no agent-tool turn for a plain one", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      expect(inspectAgentToolTurn(instance.deps, "never", collect)).toBeNull();
      expect(await agentToolTurnChunks(instance.deps, "never")).toEqual([]);
      const { requestId } = await submitTurn(instance.deps, instance.lane, {
        trigger: "server"
      });
      await instance.resultFor(requestId);
      expect(agentToolTurnOf(instance.deps, requestId)).toBeUndefined();
      expect(
        recordAgentToolProgress(instance.deps, requestId, {
          kind: "progress",
          snapshot: { at: 1 }
        })
      ).toBe(false);
    });
  });
});
