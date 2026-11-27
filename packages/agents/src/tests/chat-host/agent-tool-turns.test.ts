import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import {
  chatTurnStreamId,
  type ChatHost,
  type ChatModelCall
} from "../../chat/chat-host";
import { submitTurn } from "../../chat/chat-functions";
import {
  agentToolTurnChunks,
  agentToolTurnId,
  agentToolTurnOf,
  cancelAgentToolTurn,
  carryForwardAgentToolRuns,
  inspectAgentToolTurn,
  recordAgentToolProgress,
  releasedAgentToolRunOfRequest,
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
        startMessageId: null,
        inputMessageId: "in-1"
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

  it("keeps a settled turn's stream until the next agent-tool turn starts", async () => {
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
      // The turn kept its stream: a later reader gets the live chunks, by
      // the same positions.
      const streamId = chatTurnStreamId(agentToolTurnId("run-done"));
      expect(await instance.streams.status(streamId)).toMatchObject({
        state: "completed"
      });
      const kept = await agentToolTurnChunks(instance.deps, "run-done");
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.map((chunk) => chunk.sequence)).toEqual(
        kept.map((_, index) => index)
      );
      expect(
        await agentToolTurnChunks(instance.deps, "run-done", {
          afterSequence: kept.length - 2
        })
      ).toEqual([kept[kept.length - 1]]);
      // The child's next agent-tool turn reclaims it.
      await startAgentToolTurn(
        instance.deps,
        instance.lane,
        "run-next",
        input,
        {
          startMessageId: null
        }
      );
      expect(await instance.streams.status(streamId)).toBeNull();
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

  it("lets a released run whose turn the upgrade carried on carry on, with what its row kept", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: ChatTurnHostObject, state) => {
        await instance.lifecycle.start();
        const host = instance.host as { respond: ChatHost["respond"] };
        let started!: () => void;
        const running = new Promise<void>((resolve) => {
          started = resolve;
        });
        host.respond = async (call: ChatModelCall) =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "reply-on" });
              started();
              call.signal.addEventListener("abort", () => controller.close());
            }
          });
        const sql = state.storage.sql;
        sql.exec(
          "CREATE TABLE released_runs (run_id TEXT PRIMARY KEY, request_id TEXT, status TEXT NOT NULL, input_json TEXT, output_json TEXT, summary TEXT, error_message TEXT, started_at INTEGER NOT NULL, completed_at INTEGER, progress_json TEXT, last_signal_at INTEGER, event_delivery TEXT)"
        );
        sql.exec(
          "CREATE TABLE released_milestones (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, name TEXT NOT NULL, data_json TEXT, at INTEGER NOT NULL, PRIMARY KEY (run_id, sequence))"
        );
        sql.exec(
          "INSERT INTO released_runs (run_id, request_id, status, started_at) VALUES ('released-run', 'released-req', 'running', ?)",
          Date.now()
        );
        sql.exec(
          "INSERT INTO released_milestones (run_id, sequence, name, at) VALUES ('released-run', 0, 'found', 1)"
        );
        // The upgrade step finds the run its released turn belongs to, and
        // carries the turn on under the run's id.
        expect(
          releasedAgentToolRunOfRequest(sql, "released_runs", "released-req")
        ).toEqual({ runId: "released-run", terminalOnly: false });
        await startAgentToolTurn(
          instance.deps,
          instance.lane,
          "released-run",
          input,
          { startMessageId: null }
        );
        await running;
        await carryForwardAgentToolRuns(
          instance.deps,
          sql,
          { runs: "released_runs", milestones: "released_milestones" },
          "chat"
        );
        // It carries on, with the milestone its row kept.
        expect(
          inspectAgentToolTurn(instance.deps, "released-run", collect)
        ).toMatchObject({
          status: "running",
          milestones: [{ name: "found", sequence: 0 }]
        });
        expect(
          releasedAgentToolRunOfRequest(sql, "released_runs", "released-req")
        ).toBeNull();
      }
    );
  });

  it("in a facet, empties the released tables instead of dropping them", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: ChatTurnHostObject, state) => {
        await instance.lifecycle.start();
        const sql = state.storage.sql;
        sql.exec(
          "CREATE TABLE released_runs (run_id TEXT PRIMARY KEY, request_id TEXT, status TEXT NOT NULL, input_json TEXT, output_json TEXT, summary TEXT, error_message TEXT, started_at INTEGER NOT NULL, completed_at INTEGER, progress_json TEXT, last_signal_at INTEGER, event_delivery TEXT)"
        );
        sql.exec(
          "CREATE INDEX idx_released_request ON released_runs(request_id)"
        );
        sql.exec(
          "INSERT INTO released_runs (run_id, request_id, status, summary, started_at, completed_at) VALUES ('done-run', 'r1', 'completed', 'done', 1, 2)"
        );
        const carry = () =>
          carryForwardAgentToolRuns(
            instance.deps,
            sql,
            { runs: "released_runs", milestones: "released_milestones" },
            "chat",
            () => false,
            () => false
          );
        await carry();
        expect(
          inspectAgentToolTurn(instance.deps, "done-run", collect)
        ).toMatchObject({ status: "completed", summary: "done" });
        // The table stays, empty; the next start finds nothing to carry.
        const left = sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'released_runs'"
          )
          .toArray();
        expect(left).toHaveLength(1);
        expect(sql.exec("SELECT * FROM released_runs").toArray()).toEqual([]);
        await carry();
      }
    );
  });

  it("carries a released run too large for run metadata with its summary, and the others whole", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: ChatTurnHostObject, state) => {
        await instance.lifecycle.start();
        const sql = state.storage.sql;
        sql.exec(
          "CREATE TABLE released_runs (run_id TEXT PRIMARY KEY, request_id TEXT, status TEXT NOT NULL, input_json TEXT, output_json TEXT, summary TEXT, error_message TEXT, started_at INTEGER NOT NULL, completed_at INTEGER, progress_json TEXT, last_signal_at INTEGER, event_delivery TEXT)"
        );
        sql.exec(
          "INSERT INTO released_runs (run_id, request_id, status, summary, output_json, started_at, completed_at) VALUES ('huge', 'r1', 'completed', 'big one', ?, 1, 2)",
          JSON.stringify("x".repeat(2_000_000))
        );
        sql.exec(
          "INSERT INTO released_runs (run_id, request_id, status, summary, progress_json, last_signal_at, started_at, completed_at) VALUES ('small', 'r2', 'completed', 'done', '{\"fraction\":0.5}', 42, 1, 2)"
        );
        await carryForwardAgentToolRuns(
          instance.deps,
          sql,
          { runs: "released_runs", milestones: "released_milestones" },
          "chat"
        );
        expect(
          inspectAgentToolTurn(instance.deps, "huge", collect)
        ).toMatchObject({ status: "completed", summary: "big one" });
        // Carried after it, whole, its progress with the time it was sent.
        expect(
          inspectAgentToolTurn(instance.deps, "small", collect)
        ).toMatchObject({
          status: "completed",
          summary: "done",
          progress: { fraction: 0.5, at: 42 }
        });
      }
    );
  });

  it("does not replay what a recovery declined to keep", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      await startAgentToolTurn(instance.deps, instance.lane, "run-d", input, {
        startMessageId: null
      });
      await instance.tasks.wait(agentToolTurnId("run-d"));
      const all = await agentToolTurnChunks(instance.deps, "run-d");
      expect(all.length).toBeGreaterThan(2);
      // The first two were an attempt the app chose not to keep.
      instance.tasks.patchMetadata(agentToolTurnId("run-d"), "agentTool", {
        discarded: 2
      });
      const kept = await agentToolTurnChunks(instance.deps, "run-d");
      expect(kept.map((chunk) => chunk.sequence)).toEqual(
        all.slice(2).map((chunk) => chunk.sequence)
      );
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
