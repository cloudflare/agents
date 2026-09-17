import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { AgentToolStoredChunk } from "../agent-tool-types";
import { AgentToolsChild } from "../agent-tools/child";
import {
  setAgentToolsChildHost,
  type AgentToolsChildHost,
  type ChildTurnOutcome
} from "../agent-tools/child-host";
import { withCapabilityHarness } from "./shared/capability-harness";

const CHUNKS = [
  '{"type":"text-delta","id":"t0","delta":"he"}',
  '{"type":"text-delta","id":"t0","delta":"llo"}'
];

/**
 * Stand-in for the chat harness (`Think` / `AIChatAgent`) behind the child
 * capability: it runs a "turn" that emits two stored chunks through the
 * explicit tap, records the frames the capability broadcasts, and answers the
 * transcript/stream questions the capability asks.
 */
class FakeChildHost implements AgentToolsChildHost {
  /** Stored chunks per stream id, as a resumable stream would hold them. */
  readonly stored = new Map<string, AgentToolStoredChunk[]>();
  /** Every frame body the capability asked to broadcast. */
  readonly broadcasts: Array<{ requestId: string; body: string }> = [];
  /** Transcript the fake turn appends to. */
  messageList: UIMessage[] = [];
  /** The keep-alive work started by the last `startAgentToolRun`. */
  pending: Promise<unknown> = Promise.resolve();
  /** Runs the fake turn was asked to abort outside its own controller. */
  readonly aborted: string[] = [];

  #child: AgentToolsChild | undefined;
  #activeRequestId: string | undefined;
  #duringTurn: (() => Promise<void>) | undefined;

  bind(child: AgentToolsChild, duringTurn?: () => Promise<void>): void {
    this.#child = child;
    this.#duringTurn = duringTurn;
  }

  async runTurn(input: {
    runId: string;
    requestId: string;
    message: UIMessage;
    signal: AbortSignal;
  }): Promise<ChildTurnOutcome> {
    const child = this.#child;
    if (!child) throw new Error("bind() first");
    this.#activeRequestId = input.requestId;
    const streamId = `stream-${input.requestId}`;
    const stored: AgentToolStoredChunk[] = [];
    this.stored.set(streamId, stored);
    for (const body of CHUNKS) {
      // A real harness stores the chunk and taps the same frame it broadcasts,
      // which is why stored index and tap sequence stay on one line.
      stored.push({ sequence: stored.length, body });
      child.observeChunk(input.requestId, body);
    }
    await this.#duringTurn?.();
    this.messageList = [
      ...this.messageList,
      {
        id: `assistant-${input.runId}`,
        role: "assistant",
        parts: [{ type: "text", text: "hello" }]
      }
    ];
    this.#activeRequestId = undefined;
    return { status: "completed", requestId: input.requestId };
  }

  abortRun(runId: string): void {
    this.aborted.push(runId);
  }

  streamIdForRequest(requestId: string): string | undefined {
    const streamId = `stream-${requestId}`;
    return this.stored.has(streamId) ? streamId : undefined;
  }

  readChunks(streamId: string, afterIndex?: number): AgentToolStoredChunk[] {
    return (this.stored.get(streamId) ?? []).filter(
      (chunk) => chunk.sequence > (afterIndex ?? -1)
    );
  }

  flushChunks(): void {}

  hasActiveStream(): boolean {
    return false;
  }

  messages(): readonly UIMessage[] {
    return this.messageList;
  }

  formatInput(input: unknown, context: { runId: string }): UIMessage {
    return {
      id: `input-${context.runId}`,
      role: "user",
      parts: [{ type: "text", text: JSON.stringify(input) }]
    };
  }

  output(_runId: string, messagesAfterStart: readonly UIMessage[]): unknown {
    return latestAssistantText(messagesAfterStart);
  }

  summary(
    _runId: string,
    output: unknown,
    messagesAfterStart: readonly UIMessage[]
  ): string {
    if (typeof output === "string") return output;
    return latestAssistantText(messagesAfterStart) ?? "";
  }

  broadcastChunk(requestId: string, body: string): void {
    this.broadcasts.push({ requestId, body });
    // Progress frames ride the same wire type, so a harness taps them too.
    this.#child?.observeChunk(requestId, body);
  }

  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    const work = fn();
    this.pending = work;
    return work;
  }

  activeRequestId(): string | undefined {
    return this.#activeRequestId;
  }
}

function latestAssistantText(
  messages: readonly UIMessage[]
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    if (text.length > 0) return text;
  }
  return undefined;
}

const decoder = new TextDecoder();

/** Read a tail stream back into the chunk records it encodes. */
async function readTail(
  stream: ReadableStream<AgentToolStoredChunk>
): Promise<AgentToolStoredChunk[]> {
  const bytes = stream as unknown as ReadableStream<Uint8Array>;
  const reader = bytes.getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentToolStoredChunk);
}

describe("AgentToolsChild capability", () => {
  it("runs a child turn, replays its chunks, and records progress", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const child = new AgentToolsChild();
      const host = new FakeChildHost();
      const { lifecycle } = install(child);
      setAgentToolsChildHost(child, host);
      host.bind(child, async () => {
        await child.reportProgress({ fraction: 0.5, message: "half way" });
        await child.reportProgress({ milestone: "indexed", data: { rows: 4 } });
      });
      await lifecycle.start();

      const started = await child.startAgentToolRun(
        { prompt: "hi" },
        { runId: "run-1" }
      );
      expect(started).toMatchObject({ runId: "run-1", status: "running" });
      await host.pending;

      const inspection = await child.inspectAgentToolRun("run-1");
      expect(inspection).toMatchObject({
        runId: "run-1",
        status: "completed",
        summary: "hello",
        output: "hello"
      });
      expect(inspection?.streamId).toBeDefined();
      expect(inspection?.progress).toMatchObject({
        fraction: 0.5,
        message: "half way"
      });
      expect(inspection?.milestones).toMatchObject([
        { name: "indexed", sequence: 0, data: { rows: 4 } }
      ]);

      // Only the stored frames are replayable; the progress/milestone frames
      // rode the same tap on the live sequence but persist out of band.
      const chunks = await child.getAgentToolChunks("run-1");
      expect(chunks).toEqual([
        { sequence: 0, body: CHUNKS[0] },
        { sequence: 1, body: CHUNKS[1] }
      ]);
      expect(
        await child.getAgentToolChunks("run-1", { afterSequence: 0 })
      ).toEqual([{ sequence: 1, body: CHUNKS[1] }]);
      expect(host.broadcasts).toHaveLength(2);

      // A terminal run's tail replays the backlog and closes on its own.
      const tail = await child.tailAgentToolRun("run-1");
      expect(await readTail(tail)).toEqual(chunks);
    });
  });

  it("folds a legacy ai-chat run table that predates the newer columns", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const child = new AgentToolsChild();
      const host = new FakeChildHost();
      const { lifecycle } = install(child);
      setAgentToolsChildHost(child, host);
      host.bind(child);

      // An `ai-chat` deployment from before the progress work: the legacy table
      // has only the base columns (`summary` / `input_json` / `output_json` /
      // `progress_json` / `last_signal_at` were added by later ALTERs). Naming
      // the missing ones in the fold used to throw in `onStart`, leaving the
      // agent unable to start after the upgrade.
      storage.sql.exec(`
        CREATE TABLE cf_ai_chat_agent_tool_runs (
          run_id TEXT PRIMARY KEY,
          request_id TEXT,
          status TEXT NOT NULL,
          error_message TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER
        )
      `);
      storage.sql.exec(
        `INSERT INTO cf_ai_chat_agent_tool_runs
           (run_id, request_id, status, error_message, started_at, completed_at)
         VALUES ('legacy-1', 'req-1', 'completed', NULL, 10, 20)`
      );
      storage.sql.exec(`
        CREATE TABLE cf_ai_chat_agent_tool_milestones (
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          name TEXT NOT NULL,
          data_json TEXT,
          at INTEGER NOT NULL,
          PRIMARY KEY (run_id, sequence)
        )
      `);
      storage.sql.exec(
        `INSERT INTO cf_ai_chat_agent_tool_milestones
           (run_id, sequence, name, data_json, at)
         VALUES ('legacy-1', 0, 'indexed', '{"rows":4}', 15)`
      );

      await lifecycle.start();

      expect(await child.inspectAgentToolRun("legacy-1")).toMatchObject({
        runId: "legacy-1",
        status: "completed",
        requestId: "req-1",
        startedAt: 10,
        completedAt: 20,
        milestones: [{ name: "indexed", sequence: 0, data: { rows: 4 } }]
      });

      const remaining = [
        ...storage.sql.exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table'
             AND name LIKE 'cf_ai_chat_agent_tool_%'`
        )
      ];
      expect(remaining).toEqual([]);
    });
  });

  it("seals a stale running row left behind by an evicted isolate", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const child = new AgentToolsChild();
      const host = new FakeChildHost();
      const { lifecycle } = install(child);
      setAgentToolsChildHost(child, host);
      host.bind(child);
      await lifecycle.start();

      storage.sql.exec(
        `INSERT INTO cf_agent_tool_child_runs (run_id, status, started_at)
         VALUES ('stale-1', 'running', ?)`,
        Date.now() - 60_000
      );

      await child.reconcileStaleRuns();

      expect(await child.inspectAgentToolRun("stale-1")).toMatchObject({
        runId: "stale-1",
        status: "error",
        error: "Agent tool run was interrupted before the child could finish."
      });
    });
  });
});
