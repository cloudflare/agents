import {
  Agent,
  callable,
  getAgentByName,
  type Connection
} from "../../index.ts";
import type {
  AgentToolEvent,
  AgentToolEventMessage,
  AgentToolInterruptedReason,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolRunStatus,
  AgentToolStoredChunk,
  AgentToolTerminalStatus,
  RunAgentToolResult
} from "../../agent-tool-types.ts";

/**
 * Input the parent forwards to {@link TestAgentToolStubChild.startAgentToolRun}
 * when driving a deterministic agent-tool run for the browser replay test.
 */
type StubRunInput = {
  /** JSON-encoded UI message chunk bodies, emitted in order. */
  chunkBodies: string[];
  summary?: string;
  /**
   * Milestones the live tail emits (broadcast-only, never stored as chunks)
   * just before the stored chunk at `beforeChunk`; inspection reports them.
   */
  milestones?: { beforeChunk: number; name: string }[];
  /**
   * Chunks the live tail emits just before the stored chunk at `beforeChunk`
   * but that were too large to store, so replay never includes them.
   */
  unstoredChunks?: { beforeChunk: number; body: string }[];
  /**
   * When set, the run stays `running` and these chunks are stored + streamed
   * by the next tail, which then completes the run — a child that keeps
   * producing output after the parent restarts.
   */
  pendingChunkBodies?: string[];
  /** Stall every inspection for this long (an unresponsive child). */
  inspectDelayMs?: number;
};

/**
 * Private framework internals this fixture drives directly to reproduce the
 * #1630 follow-up bug: the typed interrupted cause (`reason` /
 * `childStillRunning`) must survive a reconnect replay, not just live events.
 * Also used to exercise the detached-run delivery ledger (#1752) directly.
 */
type AgentToolInternals = {
  _updateAgentToolTerminal(
    runId: string,
    result: RunAgentToolResult,
    completedAt?: number
  ): void;
  _readAgentToolRun(runId: string): unknown;
  _resultFromAgentToolRow(row: unknown): RunAgentToolResult;
  _replayAgentToolRuns(connection: Connection): Promise<void>;
  _reconcileAgentToolRuns(): Promise<unknown>;
  _deliverDetachedTerminal(
    runId: string,
    kind: "finish" | "give_up",
    result: RunAgentToolResult,
    options?: { sequence?: number; serialize?: boolean },
    completedAt?: number
  ): Promise<void>;
  _armDetachedBackbone(options?: { resetCadence?: boolean }): Promise<void>;
  _scheduleAgentToolRunRecovery(options?: {
    runIds?: readonly string[];
  }): Promise<void>;
};

type DetachedDeliveryLogEntry = {
  hook: "onAgentToolFinish" | "onDetachedDone";
  runId: string;
  status: AgentToolTerminalStatus;
  reason?: AgentToolInterruptedReason;
};

type DetachedBackboneSchedule = {
  delayInSeconds?: number;
  payload: unknown;
};

/** The child name a seeded run row records. */
function childNameForTest(runId: string): string {
  return `child-${runId}`;
}

export class TestAgentToolReplayAgent extends Agent {
  override onRequest(request: Request): Response {
    return new Response(`parent ${new URL(request.url).pathname}`);
  }

  /** The stub child of a seeded run, an ordinary Durable Object. */
  private _stubChildForTest(runId: string) {
    return getAgentByName(
      this.env.TestAgentToolStubChild,
      childNameForTest(runId)
    );
  }

  private get _agentTool(): AgentToolInternals {
    return this as unknown as AgentToolInternals;
  }

  /**
   * Seed a stranded `interrupted` agent-tool run row through the REAL persist
   * path (`_updateAgentToolTerminal`) — exactly what parent recovery does when
   * it gives up re-attaching to a still-running child (#1630). This is the write
   * side of the round-trip the bug regressed.
   */
  @callable()
  seedInterruptedRunForTest(
    runId: string,
    reason?: AgentToolInterruptedReason,
    childStillRunning?: boolean
  ): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        child_name, run_id, parent_tool_call_id, agent_type, status, display_order, started_at
      ) VALUES (
        ${childNameForTest(runId)}, ${runId}, ${`call-${runId}`}, 'Child', 'starting', 0, ${Date.now()}
      )
    `;
    this._agentTool._updateAgentToolTerminal(runId, {
      runId,
      agentType: "Child",
      status: "interrupted",
      error: "parent recovery gave up re-attaching to the child",
      ...(reason !== undefined ? { reason } : {}),
      ...(childStillRunning !== undefined ? { childStillRunning } : {})
    });
  }

  /**
   * Repair an `interrupted` row to `completed`, exactly as a later re-attach
   * does once the child self-heals. Asserts the persisted cause is CLEARED.
   */
  completeRunForTest(runId: string, summary: string): void {
    this._agentTool._updateAgentToolTerminal(runId, {
      runId,
      agentType: "Child",
      status: "completed",
      summary
    });
  }

  /** Round-trip: re-read the stored row back into a result object. */
  readPersistedResultForTest(runId: string): RunAgentToolResult | null {
    const row = this._agentTool._readAgentToolRun(runId);
    return row ? this._agentTool._resultFromAgentToolRow(row) : null;
  }

  /**
   * Simulate a client reconnect: drive `_replayAgentToolRuns` against a capture
   * connection and return the TERMINAL agent-tool events it would receive — the
   * exact wire frames a reconnecting client sees.
   */
  async captureReplayTerminalEventsForTest(): Promise<AgentToolEvent[]> {
    const captured: AgentToolEvent[] = [];
    const connection = {
      id: "replay-capture",
      send(body: string | ArrayBuffer | ArrayBufferView) {
        if (typeof body !== "string") return;
        try {
          const message = JSON.parse(body) as AgentToolEventMessage;
          if (message.type === "agent-tool-event") {
            captured.push(message.event);
          }
        } catch {
          // Ignore non-JSON frames.
        }
      }
    } as unknown as Connection;
    await this._agentTool._replayAgentToolRuns(connection);
    const terminalKinds = new Set([
      "finished",
      "error",
      "aborted",
      "interrupted"
    ]);
    return captured.filter((event) => terminalKinds.has(event.kind));
  }

  // ── Detached-run delivery ledger (#1752) ──────────────────────────────

  /** Records every delivery so a test can assert exactly-once / two-slot. */
  detachedDeliveryLog: DetachedDeliveryLogEntry[] = [];
  private detachedFailOnceRuns = new Set<string>();

  /** The global metering hook still fires for detached runs. */
  override async onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    this.detachedDeliveryLog.push({
      hook: "onAgentToolFinish",
      runId: run.runId,
      status: result.status,
      ...(result.reason !== undefined ? { reason: result.reason } : {})
    });
  }

  /** The targeted, durable per-run callback wired via `detached.onFinish`. */
  async onDetachedDone(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    this.detachedDeliveryLog.push({
      hook: "onDetachedDone",
      runId: run.runId,
      status: result.status,
      ...(result.reason !== undefined ? { reason: result.reason } : {})
    });
  }

  async onDetachedFailsOnce(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    if (!this.detachedFailOnceRuns.has(run.runId)) {
      this.detachedFailOnceRuns.add(run.runId);
      throw new Error("detached callback failed once");
    }
    await this.onDetachedDone(run, result);
  }

  getDetachedDeliveryLog(): DetachedDeliveryLogEntry[] {
    return this.detachedDeliveryLog;
  }

  /** Seed a `running` detached run row with the `onDetachedDone` hook wired. */
  seedDetachedRunForTest(
    runId: string,
    maxBudgetAt?: number,
    notifySource?: string,
    onFinishName = "onDetachedDone"
  ): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        child_name, run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish, detached_notify_source,
        detached_max_budget_at
      ) VALUES (
        ${childNameForTest(runId)}, ${runId}, ${null}, 'Child', 'running', 0, ${Date.now()}, 1,
        ${onFinishName}, ${notifySource ?? null}, ${maxBudgetAt ?? null}
      )
    `;
  }

  /**
   * Seed a `running` detached run that has reported progress (`lastProgressAt`)
   * and then gone silent, with a resetting no-progress budget but NO absolute
   * ceiling — so the backbone reconcile gives up ONLY on the no-progress window.
   */
  seedDetachedRunWithStaleProgressForTest(
    runId: string,
    noProgressBudgetMs: number,
    lastProgressAt: number
  ): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        child_name, run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish, detached_max_budget_at,
        detached_no_progress_budget_ms, last_progress_at
      ) VALUES (
        ${childNameForTest(runId)}, ${runId}, ${null}, 'Child', 'running', 0, ${Date.now()}, 1,
        'onDetachedDone', ${null}, ${noProgressBudgetMs}, ${lastProgressAt}
      )
    `;
  }

  /** Seed a non-detached `running` row to prove cancel ownership stays awaited. */
  seedAwaitedRunForTest(runId: string): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        child_name, run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached
      ) VALUES (
        ${childNameForTest(runId)}, ${runId}, ${null}, 'TestAgentToolStubChild', 'running', 0,
        ${Date.now()}, 0
      )
    `;
  }

  readRunNotifySourceForTest(runId: string): string | null {
    const row = this._agentTool._readAgentToolRun(runId) as {
      detached_notify_source?: string | null;
    } | null;
    return row?.detached_notify_source ?? null;
  }

  expireDetachedFinishClaimForTest(runId: string): void {
    this.sql`
      UPDATE cf_agent_tool_runs
      SET finish_claimed_at = 0
      WHERE run_id = ${runId}
    `;
  }

  async cancelRunForTest(runId: string): Promise<void> {
    await this.cancelAgentTool(runId);
  }

  /**
   * Capture the TERMINAL `agent-tool-event` frames a detached delivery
   * broadcasts to connected clients. Proves that paths without a tail sequence
   * (explicit cancel, budget give-up) still flip the background-runs tray to
   * its final state live (#1752 fix #1), not just the warm fast path.
   */
  async captureDeliveryTerminalBroadcastsForTest(
    action: "cancel" | "giveUp",
    runId: string
  ): Promise<AgentToolEvent[]> {
    const captured: AgentToolEvent[] = [];
    const self = this as unknown as {
      broadcast: (
        body: string | ArrayBuffer | ArrayBufferView,
        without?: string[]
      ) => void;
    };
    const original = self.broadcast.bind(this);
    self.broadcast = (body, without) => {
      if (typeof body === "string") {
        try {
          const message = JSON.parse(body) as AgentToolEventMessage;
          if (message.type === "agent-tool-event") captured.push(message.event);
        } catch {
          // Ignore non-JSON frames.
        }
      }
      return original(body, without);
    };
    try {
      if (action === "cancel") await this.cancelAgentTool(runId);
      else await this.deliverGiveUpForTest(runId);
    } finally {
      self.broadcast = original;
    }
    const terminalKinds = new Set([
      "finished",
      "error",
      "aborted",
      "interrupted"
    ]);
    return captured.filter((event) => terminalKinds.has(event.kind));
  }

  /**
   * Arm the detached backbone `count` times concurrently (the fan-out a turn
   * dispatching several detached runs at once produces) and return the live
   * backbone schedules. The mutex must collapse them to exactly one.
   */
  async armDetachedBackboneConcurrentlyForTest(
    count: number
  ): Promise<DetachedBackboneSchedule[]> {
    await Promise.all(
      Array.from({ length: count }, () =>
        this._agentTool._armDetachedBackbone({ resetCadence: true })
      )
    );
    return this.detachedBackboneSchedulesForTest();
  }

  async detachedReconcileTickForTest(cadenceIndex?: number): Promise<void> {
    await this._cfDetachedReconcileTick(
      cadenceIndex !== undefined ? { cadenceIndex } : undefined
    );
  }

  async detachedBackboneSchedulesForTest(): Promise<
    DetachedBackboneSchedule[]
  > {
    const schedules = await this.listSchedules();
    return schedules
      .filter((schedule) => schedule.callback === "_cfDetachedReconcileTick")
      .map((schedule) => ({
        delayInSeconds:
          "delayInSeconds" in schedule ? schedule.delayInSeconds : undefined,
        payload: schedule.payload
      }));
  }

  async deliverFinishForTest(
    runId: string,
    status: AgentToolTerminalStatus,
    text: string
  ): Promise<void> {
    await this._agentTool._deliverDetachedTerminal(runId, "finish", {
      runId,
      agentType: "Child",
      status,
      ...(status === "completed" ? { summary: text } : { error: text })
    });
  }

  async deliverFinishCatchingForTest(
    runId: string,
    status: AgentToolTerminalStatus,
    text: string
  ): Promise<string | null> {
    try {
      await this.deliverFinishForTest(runId, status, text);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async deliverGiveUpForTest(runId: string): Promise<void> {
    await this._agentTool._deliverDetachedTerminal(runId, "give_up", {
      runId,
      agentType: "Child",
      status: "interrupted",
      error: "detached run exceeded its budget before completing",
      reason: "budget-exceeded",
      childStillRunning: true
    });
  }

  readRunStatusForTest(runId: string): string | null {
    const row = this._agentTool._readAgentToolRun(runId) as {
      status: string;
    } | null;
    return row ? row.status : null;
  }

  /**
   * Drive a REAL `runAgentTool` against the deterministic, LLM-free
   * {@link TestAgentToolStubChild}. This emits live `started` / `chunk` /
   * `finished` frames to every connected client (the framework numbers them
   * `started`@0, chunks@1..N, terminal@N+1) and persists the run row, so a
   * subsequent reconnect replays the identical wire sequences with
   * `replay: true`. Used by the browser test to prove the client hook dedupes
   * live-vs-replay across a real socket reconnect.
   */
  @callable()
  async runDeterministicAgentToolForTest(options: {
    runId: string;
    parentToolCallId?: string;
    chunkBodies: string[];
    summary?: string;
  }): Promise<RunAgentToolResult> {
    return this.runAgentTool<StubRunInput>(TestAgentToolStubChild, {
      runId: options.runId,
      parentToolCallId: options.parentToolCallId,
      input: {
        chunkBodies: options.chunkBodies,
        summary: options.summary
      }
    });
  }

  /**
   * Seed open runs as an earlier version wrote them, with no child name
   * (their child was a facet), then run startup recovery.
   */
  async recoverFacetEraRunsForTest(ids: {
    awaited: string;
    detached: string;
  }): Promise<{
    rows: Array<{ runId: string; status: string; error: string | null }>;
    events: AgentToolEventMessage[];
  }> {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached
      ) VALUES (
        ${ids.awaited}, ${`call-${ids.awaited}`}, 'TestAgentToolStubChild',
        'running', 0, ${Date.now()}, 0
      )
    `;
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish
      ) VALUES (
        ${ids.detached}, ${null}, 'TestAgentToolStubChild', 'running', 0,
        ${Date.now()}, 1, 'onDetachedDone'
      )
    `;
    const events = await this._captureBroadcastsForTest(() =>
      this._agentTool._scheduleAgentToolRunRecovery()
    );
    const rows = this.sql<{
      run_id: string;
      status: string;
      error_message: string | null;
    }>`
      SELECT run_id, status, error_message FROM cf_agent_tool_runs
      WHERE run_id IN (${ids.awaited}, ${ids.detached})
      ORDER BY run_id
    `.map((row) => ({
      runId: row.run_id,
      status: row.status,
      error: row.error_message
    }));
    return { rows, events };
  }

  /**
   * Put the run table back as schema version 14 left it (no `child_name`),
   * then run the schema migration. Returns whether the column is back.
   */
  migrateRunTableFromVersion14ForTest(): boolean {
    this.ctx.storage.sql.exec(
      "ALTER TABLE cf_agent_tool_runs DROP COLUMN child_name"
    );
    this.ctx.storage.kv.put("cf_agents:schema_version", 14);
    (this as unknown as { _ensureSchema(): void })._ensureSchema();
    return this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(cf_agent_tool_runs)")
      .toArray()
      .some((column) => column.name === "child_name");
  }

  /** Startup recovery with only an `interrupted` run from facet days. */
  async recoverOnlyInterruptedFacetEraRunForTest(
    runId: string
  ): Promise<string | null> {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish
      ) VALUES (
        ${runId}, ${null}, 'TestAgentToolStubChild', 'interrupted', 0,
        ${Date.now()}, 1, 'onDetachedDone'
      )
    `;
    await this._agentTool._scheduleAgentToolRunRecovery({ runIds: [] });
    return this.readRunStatusForTest(runId);
  }

  /**
   * A facet-era detached run whose `onFinish` fails the first time: the
   * backbone delivers it again once the claim's lease has passed.
   */
  async redeliverFacetEraFinishForTest(runId: string): Promise<void> {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish
      ) VALUES (
        ${runId}, ${null}, 'TestAgentToolStubChild', 'running', 0,
        ${Date.now()}, 1, 'onDetachedFailsOnce'
      )
    `;
    await this._agentTool._scheduleAgentToolRunRecovery({ runIds: [] });
    this.expireDetachedFinishClaimForTest(runId);
    await this._cfDetachedReconcileTick();
  }

  /** Clear a run whose own child has run tools: did it ask the child to clear? */
  async clearAsksChildToClearForTest(runId: string): Promise<unknown> {
    await this.runDeterministicAgentToolForTest({ runId, chunkBodies: [] });
    const routed = await this.fetchRunChildForTest(`agent-tool-runs/${runId}/`);
    const childName = routed.body.split(" ")[1];
    await this.clearAgentToolRuns();
    const child = await getAgentByName(
      this.env.TestAgentToolStubChild,
      childName
    );
    return child.clearedRunsForTest();
  }

  /** Clear an `interrupted` run whose child is still working: is it cancelled? */
  async clearCancelsInterruptedRunForTest(
    runId: string
  ): Promise<string | undefined> {
    const child = await this._stubChildForTest(runId);
    await child.startAgentToolRun(
      { chunkBodies: [], pendingChunkBodies: ["x"] },
      { runId }
    );
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        child_name, child_name_minted, run_id, parent_tool_call_id,
        agent_type, status, display_order, started_at, detached
      ) VALUES (
        ${childNameForTest(runId)}, 0, ${runId}, ${null},
        'TestAgentToolStubChild', 'interrupted', 0, ${Date.now()}, 0
      )
    `;
    await this.clearAgentToolRuns();
    const inspection = (await child.inspectAgentToolRun(runId)) as {
      status: string;
    } | null;
    return inspection?.status;
  }

  /** Open a WebSocket to a run's child through this agent's route. */
  async connectRunChildForTest(path: string): Promise<string> {
    const response = await this.fetch(
      new Request(`https://agent.test/${path}`, {
        headers: { Upgrade: "websocket" }
      })
    );
    const socket = response.webSocket;
    if (!socket) return `no socket (${response.status})`;
    socket.accept();
    const first = await new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) =>
        resolve(String(event.data))
      );
    });
    socket.close();
    return first;
  }

  /** Fetch a path under this agent, as the Worker would forward it. */
  async fetchPathForTest(path: string): Promise<{
    status: number;
    body: string;
  }> {
    const response = await this.fetch(
      new Request(`https://agent.test/${path}`)
    );
    return { status: response.status, body: await response.text() };
  }

  /** Re-issue a run id an earlier version left open, with no child name. */
  async reissueFacetEraRunForTest(runId: string): Promise<RunAgentToolResult> {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached
      ) VALUES (
        ${runId}, ${`call-${runId}`}, 'TestAgentToolStubChild', 'running', 0,
        ${Date.now()}, 0
      )
    `;
    return this.runAgentTool<StubRunInput>(TestAgentToolStubChild, {
      runId,
      input: { chunkBodies: [] }
    });
  }

  /** The child a run reached, through the parent's route, as HTTP. */
  async runSharedChildForTest(o: { runId: string; childName: string }) {
    return this.runAgentTool<StubRunInput>(TestAgentToolStubChild, {
      runId: o.runId,
      childName: o.childName,
      input: {
        chunkBodies: [JSON.stringify({ type: "text-start", id: "t" })],
        summary: "done"
      }
    });
  }

  /** A retained facet-era run with its facet child, then clear: is the facet still there? */
  async clearFacetEraRunForTest(runId: string): Promise<boolean> {
    await this.subAgent(TestAgentToolStubChild, runId);
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, completed_at, detached
      ) VALUES (
        ${runId}, ${`call-${runId}`}, 'TestAgentToolStubChild', 'completed', 0,
        ${Date.now()}, ${Date.now()}, 0
      )
    `;
    await this.clearAgentToolRuns();
    return this.hasSubAgent(TestAgentToolStubChild, runId);
  }

  async clearAgentToolRunsForTest(o: { olderThan: number }) {
    await this.clearAgentToolRuns(o);
  }

  async fetchRunChildForTest(path: string): Promise<{
    status: number;
    body: string;
  }> {
    const response = await this.fetch(
      new Request(`https://agent.test/agents/x/y/${path}`)
    );
    return { status: response.status, body: await response.text() };
  }

  /** Run `action` and return every `agent-tool-event` frame it broadcasts. */
  private async _captureBroadcastsForTest(
    action: () => Promise<unknown>
  ): Promise<AgentToolEventMessage[]> {
    const captured: AgentToolEventMessage[] = [];
    const self = this as unknown as {
      broadcast: (
        body: string | ArrayBuffer | ArrayBufferView,
        without?: string[]
      ) => void;
    };
    const original = self.broadcast.bind(this);
    self.broadcast = (body, without) => {
      if (typeof body === "string") {
        try {
          const message = JSON.parse(body) as AgentToolEventMessage;
          if (message.type === "agent-tool-event") captured.push(message);
        } catch {
          // Ignore non-JSON frames.
        }
      }
      return original(body, without);
    };
    try {
      await action();
    } finally {
      self.broadcast = original;
    }
    return captured;
  }

  /** Every `agent-tool-event` frame a reconnecting client receives on replay. */
  private async _captureReplayForTest(): Promise<AgentToolEventMessage[]> {
    const captured: AgentToolEventMessage[] = [];
    const connection = {
      id: "replay-capture",
      send(body: string | ArrayBuffer | ArrayBufferView) {
        if (typeof body !== "string") return;
        const message = JSON.parse(body) as AgentToolEventMessage;
        if (message.type === "agent-tool-event") captured.push(message);
      }
    } as unknown as Connection;
    await this._agentTool._replayAgentToolRuns(connection);
    return captured;
  }

  /**
   * Live frames of a real `runAgentTool` (with mid-stream milestones) plus the
   * frames a client reconnecting afterwards receives on replay (#2364).
   */
  async captureLiveAndReplayForTest(options: {
    runId: string;
    chunkBodies: string[];
    milestones?: { beforeChunk: number; name: string }[];
    unstoredChunks?: { beforeChunk: number; body: string }[];
  }): Promise<{
    live: AgentToolEventMessage[];
    replay: AgentToolEventMessage[];
  }> {
    const live = await this._captureBroadcastsForTest(() =>
      this.runAgentTool<StubRunInput>(TestAgentToolStubChild, {
        runId: options.runId,
        parentToolCallId: `call-${options.runId}`,
        input: {
          chunkBodies: options.chunkBodies,
          milestones: options.milestones,
          unstoredChunks: options.unstoredChunks
        }
      })
    );
    return { live, replay: await this._captureReplayForTest() };
  }

  /**
   * A completed run whose child is then replayed to a connecting client.
   * Returns how long the replay took, the event kinds it sent, and the
   * `reconcile` option of every child inspection it made.
   */
  async captureConnectReplayForTest(options: {
    runId: string;
    chunkBodies: string[];
    inspectDelayMs?: number;
  }): Promise<{
    elapsedMs: number;
    kinds: AgentToolEvent["kind"][];
    inspectReconcile: (boolean | undefined)[];
  }> {
    const child = await this._stubChildForTest(options.runId);
    await child.startAgentToolRun(
      {
        chunkBodies: options.chunkBodies,
        milestones: [{ beforeChunk: 0, name: "begin" }],
        inspectDelayMs: options.inspectDelayMs
      },
      { runId: options.runId }
    );
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        child_name, run_id, parent_tool_call_id, agent_type, status, summary,
        display_order, started_at, completed_at, detached
      ) VALUES (
        ${childNameForTest(options.runId)}, ${options.runId}, ${`call-${options.runId}`}, 'TestAgentToolStubChild',
        'completed', 'done', 0, ${Date.now()}, ${Date.now()}, 0
      )
    `;
    const startedAt = Date.now();
    const replay = await this._captureReplayForTest();
    return {
      elapsedMs: Date.now() - startedAt,
      kinds: replay.map((message) => message.event.kind),
      inspectReconcile: await child.getInspectReconcileLog()
    };
  }

  /**
   * Connect-time replay of two completed runs where resolving the first run's
   * child stalls for `resolveDelayMs`.
   */
  async captureConnectReplayWithStalledResolveForTest(options: {
    stalledRunId: string;
    healthyRunId: string;
    resolveDelayMs: number;
  }): Promise<{ elapsedMs: number; frames: AgentToolEventMessage[] }> {
    const startedAt = Date.now();
    for (const runId of [options.stalledRunId, options.healthyRunId]) {
      const child = await this._stubChildForTest(runId);
      await child.startAgentToolRun(
        { chunkBodies: [JSON.stringify({ type: "text-start", id: "t" })] },
        { runId }
      );
      this.sql`
        INSERT INTO cf_agent_tool_runs (
          child_name, run_id, parent_tool_call_id, agent_type, status, summary,
          display_order, started_at, completed_at, detached
        ) VALUES (
          ${childNameForTest(runId)}, ${runId}, ${`call-${runId}`}, 'TestAgentToolStubChild',
          'completed', 'done', 0, ${startedAt}, ${startedAt}, 0
        )
      `;
    }

    const self = this as unknown as {
      _agentToolChild(agentType: string, runId: string): Promise<unknown>;
    };
    const original = self._agentToolChild.bind(this);
    self._agentToolChild = async (agentType, name) => {
      if (name === options.stalledRunId) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.resolveDelayMs)
        );
      }
      return original(agentType, name);
    };
    const replayStartedAt = Date.now();
    try {
      const frames = await this._captureReplayForTest();
      return { elapsedMs: Date.now() - replayStartedAt, frames };
    } finally {
      self._agentToolChild = original;
    }
  }

  /**
   * A child still running when the parent restarts: a connected client has
   * already seen the stored chunks, then parent recovery re-attaches and
   * forwards the chunks the child produces afterwards.
   */
  async captureRecoveryReattachForTest(options: {
    runId: string;
    storedChunkBodies: string[];
    pendingChunkBodies: string[];
  }): Promise<{
    seen: AgentToolEventMessage[];
    recovery: AgentToolEventMessage[];
  }> {
    const child = await this._stubChildForTest(options.runId);
    await child.startAgentToolRun(
      {
        chunkBodies: options.storedChunkBodies,
        pendingChunkBodies: options.pendingChunkBodies
      },
      { runId: options.runId }
    );
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        child_name, run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached
      ) VALUES (
        ${childNameForTest(options.runId)}, ${options.runId}, ${`call-${options.runId}`}, 'TestAgentToolStubChild',
        'running', 0, ${Date.now()}, 0
      )
    `;
    const seen = await this._captureReplayForTest();
    const recovery = await this._captureBroadcastsForTest(() =>
      this._agentTool._reconcileAgentToolRuns()
    );
    return { seen, recovery };
  }
}

/**
 * A deterministic, LLM-free agent-tool CHILD. A plain `Agent` subclass is a
 * legal agent-tool child: the framework's adapter gate only requires the four
 * methods below (`tailAgentToolRun` is optional; omitting it takes the batch
 * path). Chunks are persisted in SQL — NOT in memory — so a reconnect that
 * wakes a hibernated DO can still replay them via `getAgentToolChunks`.
 */
export class TestAgentToolStubChild extends Agent {
  override async clearAgentToolRuns(options?: {
    olderThan?: number;
    status?: AgentToolRunStatus[];
  }): Promise<void> {
    await this.ctx.storage.put("cleared-runs", true);
    await super.clearAgentToolRuns(options);
  }

  async clearedRunsForTest(): Promise<unknown> {
    return (await this.ctx.storage.get("cleared-runs")) ?? null;
  }

  async destroyPendingForTest(): Promise<unknown> {
    return (await this.ctx.storage.get("cf_agents_destroy_pending")) ?? null;
  }

  override onRequest(request: Request): Response {
    return new Response(`child ${this.name} ${new URL(request.url).pathname}`);
  }

  private _ensureTables(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_test_stub_chunks (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_test_stub_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        summary TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        milestones_json TEXT,
        unstored_json TEXT,
        pending_json TEXT,
        inspect_delay_ms INTEGER
      )
    `;
  }

  /** The `reconcile` option of every `inspectAgentToolRun` call received. */
  inspectReconcileLog: (boolean | undefined)[] = [];

  getInspectReconcileLog(): (boolean | undefined)[] {
    return this.inspectReconcileLog;
  }

  private _storeChunks(runId: string, bodies: string[], offset: number) {
    bodies.forEach((body, index) => {
      this.sql`
        INSERT OR REPLACE INTO cf_test_stub_chunks (run_id, seq, body)
        VALUES (${runId}, ${offset + index}, ${body})
      `;
    });
  }

  private _milestones(runId: string): { beforeChunk: number; name: string }[] {
    const row = this.sql<{ milestones_json: string | null }>`
      SELECT milestones_json FROM cf_test_stub_runs WHERE run_id = ${runId}
    `[0];
    return row?.milestones_json ? JSON.parse(row.milestones_json) : [];
  }

  async startAgentToolRun(
    input: StubRunInput,
    options: { runId: string }
  ): Promise<AgentToolRunInspection> {
    this._ensureTables();
    const startedAt = Date.now();
    const chunkBodies = input?.chunkBodies ?? [];
    this._storeChunks(options.runId, chunkBodies, 0);
    const pending = input?.pendingChunkBodies;
    const status = pending ? "running" : "completed";
    const completedAt = pending ? null : Date.now();
    const summary = input?.summary ?? null;
    const milestonesJson = input?.milestones
      ? JSON.stringify(input.milestones)
      : null;
    const unstoredJson = input?.unstoredChunks
      ? JSON.stringify(input.unstoredChunks)
      : null;
    const pendingJson = pending ? JSON.stringify(pending) : null;
    this.sql`
      INSERT OR REPLACE INTO cf_test_stub_runs
        (run_id, status, summary, error, started_at, completed_at,
         milestones_json, unstored_json, pending_json, inspect_delay_ms)
      VALUES
        (${options.runId}, ${status}, ${summary}, ${null}, ${startedAt},
         ${completedAt}, ${milestonesJson}, ${unstoredJson}, ${pendingJson},
         ${input?.inspectDelayMs ?? null})
    `;
    return {
      runId: options.runId,
      status,
      summary: input?.summary,
      startedAt,
      completedAt: completedAt ?? undefined
    };
  }

  async cancelAgentToolRun(runId: string): Promise<void> {
    this._ensureTables();
    this.sql`
      UPDATE cf_test_stub_runs
      SET status = 'aborted', completed_at = ${Date.now()}
      WHERE run_id = ${runId}
    `;
  }

  async inspectAgentToolRun(
    runId: string,
    options?: { reconcile?: boolean }
  ): Promise<AgentToolRunInspection | null> {
    this._ensureTables();
    this.inspectReconcileLog.push(options?.reconcile);
    const rows = this.sql<{
      status: string;
      summary: string | null;
      error: string | null;
      started_at: number;
      completed_at: number | null;
      inspect_delay_ms: number | null;
    }>`
      SELECT status, summary, error, started_at, completed_at, inspect_delay_ms
      FROM cf_test_stub_runs WHERE run_id = ${runId}
    `;
    const row = rows[0];
    if (!row) return null;
    const inspectDelayMs = row.inspect_delay_ms;
    if (inspectDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, inspectDelayMs));
    }
    const milestones = this._milestones(runId).map((milestone, sequence) => ({
      name: milestone.name,
      sequence,
      at: row.started_at
    }));
    return {
      runId,
      status: row.status as AgentToolRunInspection["status"],
      summary: row.summary ?? undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      ...(milestones.length > 0 ? { milestones } : {})
    };
  }

  async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    this._ensureTables();
    const after = options?.afterSequence ?? -1;
    return this.sql<{ seq: number; body: string }>`
      SELECT seq, body FROM cf_test_stub_chunks
      WHERE run_id = ${runId} AND seq > ${after}
      ORDER BY seq ASC
    `.map((row) => ({ sequence: row.seq, body: row.body }));
  }

  /**
   * Live stream used by `runAgentTool`'s forward path. A facet RPC stub makes
   * EVERY property access truthy, so the parent always takes the
   * `tailAgentToolRun` branch (never the batch fallback) for an RPC child — it
   * must exist. The run is already complete by the time `startAgentToolRun`
   * returns, so this simply replays the persisted chunks as a newline-delimited
   * JSON byte stream (the wire format `_forwardAgentToolStream` decodes) and
   * closes. (`getAgentToolChunks` above still serves the reconnect replay path,
   * which fetches chunks in a batch rather than tailing.)
   */
  async tailAgentToolRun(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>> {
    this._ensureTables();
    const run = this.sql<{ pending_json: string | null }>`
      SELECT pending_json FROM cf_test_stub_runs WHERE run_id = ${runId}
    `[0];
    if (run?.pending_json) {
      const stored = await this.getAgentToolChunks(runId);
      this._storeChunks(runId, JSON.parse(run.pending_json), stored.length);
      this.sql`
        UPDATE cf_test_stub_runs
        SET status = 'completed', completed_at = ${Date.now()},
            pending_json = NULL
        WHERE run_id = ${runId}
      `;
    }
    const chunks = await this.getAgentToolChunks(runId, options);
    const milestones = this._milestones(runId);
    const unstoredRow = this.sql<{ unstored_json: string | null }>`
      SELECT unstored_json FROM cf_test_stub_runs WHERE run_id = ${runId}
    `[0];
    const unstored: { beforeChunk: number; body: string }[] =
      unstoredRow?.unstored_json ? JSON.parse(unstoredRow.unstored_json) : [];
    const frames: AgentToolStoredChunk[] = [];
    for (const chunk of chunks) {
      for (const skipped of unstored) {
        if (skipped.beforeChunk !== chunk.sequence) continue;
        frames.push({
          sequence: chunk.sequence,
          body: skipped.body,
          unstoredId: crypto.randomUUID()
        });
      }
      milestones.forEach((milestone, sequence) => {
        if (milestone.beforeChunk !== chunk.sequence) return;
        frames.push({
          sequence: chunk.sequence,
          body: JSON.stringify({
            type: "data-agent-milestone",
            data: { name: milestone.name, sequence, at: Date.now() }
          })
        });
      });
      frames.push(chunk);
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (options?.signal?.aborted) {
          controller.close();
          return;
        }
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        }
        controller.close();
      }
    });
    return stream as unknown as ReadableStream<AgentToolStoredChunk>;
  }
}
