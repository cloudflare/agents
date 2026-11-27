import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import type { ChatHost, ChatModelCall } from "../../chat/chat-host";
import { submitTurn } from "../../chat/chat-functions";
import { applyChunkToParts } from "../../chat/message-builder";
import type { UIMessage } from "ai";
import {
  agentToolTurnChunks,
  agentToolTurnId,
  agentToolTurnOf,
  chunksOfMessage,
  cancelAgentToolTurn,
  carryForwardAgentToolRuns,
  inspectAgentToolTurn,
  recordAgentToolProgress,
  remainingChunks,
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
  it("turns a stored reply into chunks that build the same parts", () => {
    const message = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "thinking", state: "done" },
        { type: "text", text: "Looking.", state: "done" },
        {
          type: "tool-search",
          toolName: "search",
          toolCallId: "c1",
          state: "output-available",
          input: { q: "x" },
          output: { hits: 2 }
        },
        {
          type: "tool-fetch",
          toolName: "fetch",
          toolCallId: "c2",
          state: "output-error",
          input: { url: "u" },
          errorText: "404"
        },
        {
          type: "data-agent-milestone",
          data: { name: "found", sequence: 0, at: 1 }
        },
        { type: "step-start" },
        { type: "text", text: "Done.", state: "done" }
      ],
      metadata: { model: "m" }
    } as unknown as UIMessage;
    const chunks = chunksOfMessage(message);
    const parts: UIMessage["parts"] = [];
    for (const chunk of chunks) {
      applyChunkToParts(parts, chunk as never);
    }
    // The accumulator a tab uses makes the stored parts, exactly.
    expect(parts).toEqual(message.parts);
    // Each step opened and closed, the milestone once in its place, and
    // the finish carries the message's metadata.
    const types = chunks.map((chunk) => chunk.type);
    expect(types.filter((type) => type === "start-step")).toHaveLength(2);
    expect(types.filter((type) => type === "finish-step")).toHaveLength(2);
    expect(
      types.filter((type) => type === "data-agent-milestone")
    ).toHaveLength(1);
    expect(chunks.at(-1)).toEqual({
      type: "finish",
      messageMetadata: { model: "m" }
    });
  });

  it("finishes a tail cut short as the turn ended, from the stored reply", () => {
    const stored = {
      id: "m2",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "One two", state: "done" },
        {
          type: "tool-search",
          toolName: "search",
          toolCallId: "c1",
          state: "output-available",
          input: { q: "x" },
          output: { hits: 2 }
        },
        { type: "step-start" },
        { type: "text", text: "Three", state: "done" }
      ],
      metadata: { model: "m" }
    } as unknown as UIMessage;
    // What a tail had read when the stream went: mid-text, mid-tool.
    const sent = [
      { type: "start", messageId: "m2" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "One" }
    ] as never[];
    const rest = remainingChunks(sent, stored);
    const parts: UIMessage["parts"] = [];
    for (const chunk of [...sent, ...rest]) {
      applyChunkToParts(parts, chunk as never);
    }
    expect(parts).toEqual(stored.parts);
    // The open text part goes on under its own id; the finish closes it.
    expect(rest[0]).toEqual({ type: "text-delta", id: "t1", delta: " two" });
    expect(rest.at(-1)).toEqual({
      type: "finish",
      messageMetadata: { model: "m" }
    });
  });

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

  it("replays a settled turn from its stored reply", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      await startAgentToolTurn(
        instance.deps,
        instance.lane,
        "run-done",
        input,
        {
          startMessageId: null
        }
      );
      await instance.tasks.wait(agentToolTurnId("run-done"));
      const chunks = await agentToolTurnChunks(instance.deps, "run-done");
      expect(chunks.map((chunk) => JSON.parse(chunk.body))).toEqual([
        { type: "start", messageId: "reply-1" },
        { type: "text-start", id: "reply-1-0" },
        { type: "text-delta", id: "reply-1-0", delta: "Hello" },
        { type: "text-end", id: "reply-1-0" },
        { type: "finish" }
      ]);
      // A reader with a position pages through the replay.
      expect(
        await agentToolTurnChunks(instance.deps, "run-done", {
          afterSequence: 3
        })
      ).toEqual([{ sequence: 4, body: JSON.stringify({ type: "finish" }) }]);
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

  it("stops the carried turn of a released run it carries as interrupted", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: ChatTurnHostObject, state) => {
        await instance.lifecycle.start();
        const host = instance.host as { respond: ChatHost["respond"] };
        let started!: () => void;
        let modelCall: AbortSignal | undefined;
        const running = new Promise<void>((resolve) => {
          started = resolve;
        });
        // The released run's turn, carried on under its request id and
        // still generating.
        host.respond = async (call: ChatModelCall) =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "reply-carried" });
              modelCall = call.signal;
              started();
              call.signal.addEventListener("abort", () => controller.close());
            }
          });
        await submitTurn(
          instance.deps,
          instance.lane,
          { trigger: "server" },
          { requestId: "released-req" }
        );
        await running;
        const sql = state.storage.sql;
        sql.exec(
          "CREATE TABLE released_runs (run_id TEXT PRIMARY KEY, request_id TEXT, status TEXT NOT NULL, input_json TEXT, output_json TEXT, summary TEXT, error_message TEXT, started_at INTEGER NOT NULL, completed_at INTEGER, progress_json TEXT, last_signal_at INTEGER, event_delivery TEXT)"
        );
        sql.exec(
          "INSERT INTO released_runs (run_id, request_id, status, started_at) VALUES ('released-run', 'released-req', 'running', ?)",
          Date.now()
        );
        await carryForwardAgentToolRuns(
          instance.deps,
          sql,
          { runs: "released_runs", milestones: "released_milestones" },
          "chat"
        );
        expect(
          inspectAgentToolTurn(instance.deps, "released-run", collect)
        ).toMatchObject({
          status: "error",
          error: "Agent tool run was interrupted by an upgrade."
        });
        // Its turn stopped: no model work for a run its parent sees ended.
        expect(modelCall?.aborted).toBe(true);
      }
    );
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
