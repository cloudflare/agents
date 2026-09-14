import { describe, expect, it } from "vitest";
import type {
  AgentToolChildAdapter,
  AgentToolEventMessage,
  AgentToolRunInfo,
  AgentToolStoredChunk
} from "../agent-tool-types";
import { AgentTools } from "../agent-tools/agent-tools";
import { setAgentToolsHost, type AgentToolsHost } from "../agent-tools/host";
import type { AgentToolsOptions } from "../agent-tools/options";
import type { Connection } from "../lifecycle/types";
import { withCapabilityHarness } from "./shared/capability-harness";

/** A child whose stored chunks are `chunkCount` numbered frames. */
function storedChunkChild(chunkCount: number): AgentToolChildAdapter {
  const chunks: AgentToolStoredChunk[] = Array.from(
    { length: chunkCount },
    (_, index) => ({ sequence: index, body: `chunk-${index}` })
  );
  return {
    startAgentToolRun: async (_input, options) => ({
      runId: options.runId,
      status: "completed",
      startedAt: 0,
      completedAt: 1
    }),
    cancelAgentToolRun: async () => {},
    inspectAgentToolRun: async (runId) => ({
      runId,
      status: "completed",
      startedAt: 0,
      completedAt: 1
    }),
    getAgentToolChunks: async (_runId, options) =>
      chunks.filter((chunk) => chunk.sequence > (options?.afterSequence ?? -1))
  };
}

/** The host bindings a bare parent capability needs, all inert but resolveChild. */
function inertHost(child: AgentToolChildAdapter): AgentToolsHost {
  return {
    resolveChild: async () => child,
    deleteChild: async () => {},
    broadcast: () => {},
    onAgentToolStart: async (_run: AgentToolRunInfo) => {},
    onAgentToolFinish: async () => {},
    onProgress: async () => {},
    onError: async () => {},
    resolveCallback: () => undefined,
    runDetachedDelivery: async (invoke) => {
      await invoke();
    },
    onStreamProgress: async () => {},
    deliverDetachedMilestone: async () => {},
    waitUntil: () => {}
  };
}

/** A connection that records the agent-tool frames replayed to it. */
function captureConnection(): {
  connection: Connection;
  frames: AgentToolEventMessage[];
} {
  const frames: AgentToolEventMessage[] = [];
  const connection = {
    id: "replay-capture",
    send(body: string | ArrayBuffer | ArrayBufferView) {
      if (typeof body !== "string") return;
      const message = JSON.parse(body) as AgentToolEventMessage;
      if (message.type === "agent-tool-event") frames.push(message);
    }
    // SAFETY: replay only ever calls `send` on the connection it is given.
  } as unknown as Connection;
  return { connection, frames };
}

/**
 * Install a parent capability over real storage with `runs` completed runs
 * seeded oldest-first, then replay to one fresh connection.
 */
async function replayFrames(
  options: AgentToolsOptions,
  runs: string[],
  chunksPerRun: number
): Promise<AgentToolEventMessage[]> {
  return withCapabilityHarness(async ({ install, storage }) => {
    const agentTools = new AgentTools(options);
    const { lifecycle } = install(agentTools);
    setAgentToolsHost(agentTools, inertHost(storedChunkChild(chunksPerRun)));
    await lifecycle.start();

    runs.forEach((runId, index) => {
      storage.sql.exec(
        `INSERT INTO cf_agent_tool_runs
           (run_id, parent_tool_call_id, agent_type, status, summary,
            display_order, started_at, completed_at)
         VALUES (?, 'call-1', 'Child', 'completed', ?, 0, ?, ?)`,
        runId,
        `${runId} done`,
        1_000 + index,
        2_000 + index
      );
    });

    const { connection, frames } = captureConnection();
    await agentTools.replayToConnection(connection);
    return frames;
  });
}

describe("agent-tool replay caps on connect", () => {
  it("replays every run with every chunk by default", async () => {
    const frames = await replayFrames({}, ["run-a", "run-b", "run-c"], 3);

    expect(
      frames
        .filter((frame) => frame.event.kind === "started")
        .map((frame) => frame.event.runId)
    ).toEqual(["run-a", "run-b", "run-c"]);
    expect(frames.filter((frame) => frame.event.kind === "chunk")).toHaveLength(
      9
    );
  });

  it("replays only the newest runs when maxRuns is set", async () => {
    const frames = await replayFrames(
      { replayOnConnect: { maxRuns: 2 } },
      ["run-a", "run-b", "run-c"],
      2
    );

    // The oldest run is cut entirely — no started, chunk, or terminal frame —
    // and the survivors are still emitted oldest-first.
    const runIds = frames.map((frame) =>
      "runId" in frame.event ? frame.event.runId : undefined
    );
    expect(new Set(runIds)).toEqual(new Set(["run-b", "run-c"]));
    expect(
      frames
        .filter((frame) => frame.event.kind === "started")
        .map((frame) => frame.event.runId)
    ).toEqual(["run-b", "run-c"]);
    expect(
      frames.filter((frame) => frame.event.kind === "finished")
    ).toHaveLength(2);
  });

  it("replays the TAIL of each run's chunks, keeping their sequences", async () => {
    const capped = await replayFrames(
      { replayOnConnect: { maxChunksPerRun: 2 } },
      ["run-a"],
      5
    );
    const uncapped = await replayFrames({}, ["run-a"], 5);

    const bodies = capped
      .filter((frame) => frame.event.kind === "chunk")
      .map((frame) => (frame.event.kind === "chunk" ? frame.event.body : ""));
    expect(bodies).toEqual(["chunk-3", "chunk-4"]);

    // Each retained frame carries the sequence an uncapped replay gave it, so a
    // client that dedupes live-vs-replay by sequence is unaffected.
    const sequenceOf = (
      frames: AgentToolEventMessage[],
      body: string
    ): number | undefined =>
      frames.find(
        (frame) => frame.event.kind === "chunk" && frame.event.body === body
      )?.sequence;
    expect(sequenceOf(capped, "chunk-3")).toBe(sequenceOf(uncapped, "chunk-3"));
    expect(sequenceOf(capped, "chunk-4")).toBe(sequenceOf(uncapped, "chunk-4"));
    expect(capped.at(-1)?.sequence).toBe(uncapped.at(-1)?.sequence);
    expect(capped.at(-1)?.event.kind).toBe("finished");
  });

  it("replays nothing when maxRuns is zero", async () => {
    expect(
      await replayFrames({ replayOnConnect: { maxRuns: 0 } }, ["run-a"], 2)
    ).toEqual([]);
  });
});
