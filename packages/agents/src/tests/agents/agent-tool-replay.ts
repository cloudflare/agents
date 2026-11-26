import { Agent, callable, type Connection } from "../../index.ts";
import { TaskSettlement } from "../../tasks/settlement.ts";
import type { TaskJson } from "../../tasks/types.ts";
import type {
  AgentToolEvent,
  AgentToolEventMessage,
  AgentToolInterruptedReason,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunInspection,
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
  /** The run's structured output, reported by inspection once completed. */
  output?: unknown;
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
  /** The run stays `running` and its tail never sends or closes. */
  tailHangs?: boolean;
  /** The run stays `running` until a test ends it; its tail closes at once. */
  staysRunning?: boolean;
  /** Every cancel throws (a teardown the parent cannot confirm). */
  cancelFails?: boolean;
};

/**
 * Private framework internals this fixture drives directly to reproduce the
 * #1630 follow-up bug: the typed interrupted cause (`reason` /
 * `childStillRunning`) must survive a reconnect replay, not just live events.
 * Also used to exercise the detached-run delivery ledger (#1752) directly.
 */
type AgentToolInternals = {
  _readAgentToolRun(runId: string): unknown;
  _resultFromAgentToolRow(row: unknown): RunAgentToolResult;
  _replayAgentToolRuns(connection: Connection): Promise<void>;
  _carryForwardAgentToolRuns(): Promise<void>;
  _listAgentToolRuns(): Array<{ run_id: string; status: string }>;
};

type DetachedDeliveryLogEntry = {
  hook: "onAgentToolFinish" | "onDetachedDone";
  runId: string;
  status: AgentToolTerminalStatus;
  reason?: AgentToolInterruptedReason;
};

/**
 * The `cf_agent_tool_runs` table a released version kept, for tests that
 * seed its rows; the next start carries them into Task runs.
 */
function ensureReleasedAgentToolTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agent_tool_runs (
      run_id TEXT PRIMARY KEY, parent_tool_call_id TEXT,
      agent_type TEXT NOT NULL, input_preview TEXT,
      input_redacted INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
      summary TEXT, output_json TEXT, error_message TEXT,
      interrupted_reason TEXT, child_still_running INTEGER,
      display_metadata TEXT, display_order INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL, completed_at INTEGER,
      detached INTEGER NOT NULL DEFAULT 0, detached_on_finish TEXT,
      detached_notify_source TEXT, detached_max_budget_at INTEGER,
      finish_claimed_at INTEGER, finish_delivered_at INTEGER,
      give_up_claimed_at INTEGER, give_up_delivered_at INTEGER,
      detached_no_progress_budget_ms INTEGER, last_progress_at INTEGER,
      detached_on_milestones TEXT, event_delivery TEXT
    )
  `);
}

export class TestAgentToolReplayAgent extends Agent {
  private get _agentTool(): AgentToolInternals {
    return (this as unknown as { _agentTools: AgentToolInternals })._agentTools;
  }

  /**
   * Seed a stranded `interrupted` agent-tool run row through the REAL persist
   * path (`_updateAgentToolTerminal`) — exactly what parent recovery does when
   * it gives up re-attaching to a still-running child (#1630). This is the write
   * side of the round-trip the bug regressed.
   */
  @callable()
  async seedInterruptedRunForTest(
    runId: string,
    reason?: AgentToolInterruptedReason,
    childStillRunning?: boolean
  ): Promise<void> {
    await this.seedSettledRunForTest(runId, {
      runId,
      agentType: "Child",
      status: "interrupted",
      error: "parent recovery gave up re-attaching to the child",
      ...(reason !== undefined ? { reason } : {}),
      ...(childStillRunning !== undefined ? { childStillRunning } : {})
    });
  }

  /** Settle a run with `result`, as a run of the awaited definition. */
  private async seedSettledRunForTest(
    runId: string,
    result: RunAgentToolResult
  ): Promise<void> {
    this.tasks.deleteRun(runId);
    const now = Date.now();
    await this.tasks.importRun({
      runId,
      definition: "__cf_agent_tool",
      status: "completed",
      attempt: 1,
      metadata: {
        agentType: "Child",
        parentToolCallId: `call-${runId}`,
        displayOrder: 0,
        startedAt: now
      },
      result: result as unknown as TaskJson,
      retain: true,
      createdAt: now,
      settledAt: now
    });
  }

  /** Repair an `interrupted` run to `completed`, as a re-attach does. */
  async completeRunForTest(runId: string, summary: string): Promise<void> {
    await this.seedSettledRunForTest(runId, {
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

  /** The notify source each `onDetachedDone` delivery carried, per run. */
  private deliveredNotifySources: { runId: string; source?: string }[] = [];

  getDeliveredNotifySourcesForTest(runId: string): (string | undefined)[] {
    return this.deliveredNotifySources
      .filter((entry) => entry.runId === runId)
      .map((entry) => entry.source);
  }

  /** Milestone and `onDetachedDone` deliveries, in the order they began. */
  detachedEventOrder: { runId: string; event: string }[] = [];

  getDetachedEventOrderForTest(runId: string): string[] {
    return this.detachedEventOrder
      .filter((entry) => entry.runId === runId)
      .map((entry) => entry.event);
  }

  hasChildForTest(runId: string): boolean {
    return this.hasSubAgent(TestAgentToolStubChild, runId);
  }

  getDetachedMilestonesForTest(runId: string): string[] {
    return this.detachedMilestoneLog
      .filter((entry) => entry.runId === runId)
      .map((entry) => entry.name);
  }

  /** A child the give-up's cancel did reach, though the call failed. */
  async abortChildWithGiveUpReasonForTest(runId: string): Promise<void> {
    const child = await this.subAgent(TestAgentToolStubChild, runId);
    await child.stopRunForTest(
      runId,
      "agent tool run given up by its parent: detached budget exceeded"
    );
  }

  /** The targeted, durable per-run callback wired via `detached.onFinish`. */
  async onDetachedDone(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    this.deliveredNotifySources.push({
      runId: run.runId,
      ...(run.notifySource !== undefined ? { source: run.notifySource } : {})
    });
    this.detachedEventOrder.push({
      runId: run.runId,
      event: `finish:${result.status}`
    });
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

  /** Delivers a give-up normally, but fails the first real finish once. */
  async onDetachedFinishFailsOnce(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    if (
      result.status !== "interrupted" &&
      !this.detachedFailOnceRuns.has(run.runId)
    ) {
      this.detachedFailOnceRuns.add(run.runId);
      throw new Error("detached finish callback failed once");
    }
    await this.onDetachedDone(run, result);
  }

  getDetachedDeliveryLog(): DetachedDeliveryLogEntry[] {
    return this.detachedDeliveryLog;
  }

  /** Milestone notifications delivered through the `onMilestones` seam. */
  detachedMilestoneLog: { runId: string; name: string }[] = [];

  protected override async _deliverDetachedMilestone(
    run: AgentToolRunInfo,
    milestone: { name: string }
  ): Promise<void> {
    this.detachedMilestoneLog.push({ runId: run.runId, name: milestone.name });
    this.detachedEventOrder.push({
      runId: run.runId,
      event: `milestone:${milestone.name}`
    });
  }

  /** Start a detached run on a stub child, `onDetachedDone` wired. */
  async startDetachedForTest(
    runId: string,
    child: StubRunInput,
    detached: {
      onFinish?: string;
      maxBudgetMs?: number;
      noProgressBudgetMs?: number;
      notify?: { source: string };
      onMilestones?: string[];
    } = {}
  ): Promise<{ status: string; error?: string }> {
    try {
      const result = await this.runAgentTool(TestAgentToolStubChild, {
        runId,
        input: child,
        detached: { onFinish: "onDetachedDone", ...detached }
      });
      return { status: result.status };
    } catch (error) {
      return {
        status: "threw",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Run a waiting detached run's next check now, instead of at its
   * deadline, and wait for its report if it settles. Returns the run's
   * status, what it waits for, and when it checks next.
   */
  async checkDetachedForTest(runId: string): Promise<{
    status: string | null;
    waitReason?: string;
    nextInMs?: number;
  }> {
    // An attempt the live tail woke may be running already: let it end.
    await this.detachedAttemptEndedForTest(runId);
    if (this.tasks.peek(runId)?.waitReason === "park") {
      await this.tasks.settle(runId, TaskSettlement.retry(Date.now()));
    }
    await this.tasks.runDue("__cf_agent_tool_detached");
    await this.detachedAttemptEndedForTest(runId);
    return this.detachedStateForTest(runId);
  }

  /** Wait while an attempt of the run is running (it parks or settles). */
  private async detachedAttemptEndedForTest(runId: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (
      this.tasks.peek(runId)?.status === "running" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Clear every run; what is left of `runId`, and the open-run count. */
  async clearRunsForTest(
    runId: string
  ): Promise<{ task: string | null; open: number; child: boolean }> {
    await this.clearAgentToolRuns();
    return {
      task: this.tasks.peek(runId)?.status ?? null,
      child: this.hasSubAgent(TestAgentToolStubChild, runId),
      open: (
        this as unknown as {
          _agentTools: { _activeAgentToolRunCount(): number };
        }
      )._agentTools._activeAgentToolRunCount()
    };
  }

  /** A detached run's state; waits for its report once it settled. */
  async detachedStateForTest(runId: string): Promise<{
    status: string | null;
    waitReason?: string;
    nextInMs?: number;
  }> {
    const record = this.tasks.peek(runId);
    if (!record) return { status: null };
    if (record.status !== "pending" && record.status !== "running") {
      await this.tasks.wait(runId);
      return { status: record.status };
    }
    const row = this.sql<{ next_at: number | null }>`
      SELECT next_at FROM cf_agents_task_runs WHERE run_id = ${runId}
    `[0];
    return {
      status: record.status,
      ...(record.waitReason !== undefined
        ? { waitReason: record.waitReason }
        : {}),
      ...(row?.next_at != null ? { nextInMs: row.next_at - Date.now() } : {})
    };
  }

  /** Put a detached run's budget in the past, as time passing would. */
  expireDetachedBudgetForTest(runId: string): void {
    this.tasks.updateMetadata(runId, (metadata) => ({
      ...metadata,
      detached: {
        ...(metadata.detached as Record<string, TaskJson>),
        maxBudgetAt: Date.now() - 1
      }
    }));
  }

  /** End a stub child's run, as the child itself would. */
  async finishChildForTest(
    runId: string,
    how: "completes" | "is stopped",
    milestone?: string
  ): Promise<void> {
    const child = await this.subAgent(TestAgentToolStubChild, runId);
    if (milestone) await child.addMilestoneForTest(runId, milestone);
    if (how === "completes") await child.completeRunForTest(runId);
    else await child.stopRunForTest(runId, "stopped by its client");
  }

  /** Cancel a run through the public API. */
  async cancelRunForTest(runId: string): Promise<void> {
    await this.cancelAgentTool(runId);
  }

  /**
   * Run `action` and return the terminal agent-tool frames it broadcast.
   */
  async captureTerminalBroadcastsForTest(
    runId: string,
    action: "cancel" | "check"
  ): Promise<AgentToolEvent[]> {
    const captured: AgentToolEvent[] = [];
    const self = this as unknown as {
      broadcast(msg: string, without?: string[]): void;
    };
    const original = self.broadcast.bind(this);
    self.broadcast = (body: string, without?: string[]) => {
      try {
        const message = JSON.parse(body) as AgentToolEventMessage;
        if (message.type === "agent-tool-event") captured.push(message.event);
      } catch {
        // Ignore non-JSON frames.
      }
      return original(body, without);
    };
    try {
      if (action === "cancel") await this.cancelAgentTool(runId);
      await this.checkDetachedForTest(runId);
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
   * Make every pending Lifecycle job due now and point the alarm at it, so
   * `runDurableObjectAlarm` runs it (a failed report's retry, say).
   */
  async makeJobsDueForTest(): Promise<void> {
    this.sql`UPDATE cf_agents_jobs SET time = ${Date.now() - 1000}`;
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /**
   * A released detached row that recorded its child's completion but had
   * not delivered it, whose child is gone; carried forward.
   */
  async carryForwardReleasedOwedWithoutChildForTest(
    runId: string,
    options: { childWithMilestone?: string; onMilestones?: string } = {}
  ): Promise<void> {
    if (options.childWithMilestone) {
      const child = await this.subAgent(TestAgentToolStubChild, runId);
      await child.startAgentToolRun(
        {
          chunkBodies: ["a"],
          summary: "recorded",
          milestones: [{ beforeChunk: 0, name: options.childWithMilestone }]
        },
        { runId }
      );
    }
    ensureReleasedAgentToolTable(this.ctx.storage.sql);
    const now = Date.now();
    const configured = options.childWithMilestone ?? options.onMilestones;
    const milestones = configured ? JSON.stringify([configured]) : null;
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, agent_type, status, summary, started_at, completed_at,
        detached, detached_on_finish, detached_max_budget_at,
        detached_on_milestones
      ) VALUES (
        ${runId}, 'TestAgentToolStubChild', 'completed', 'recorded', ${now},
        ${now}, 1, 'onDetachedDone', ${now + 3_600_000}, ${milestones}
      )
    `;
    await this._agentTool._carryForwardAgentToolRuns();
  }

  /**
   * Replay's stored-chunk step for a run cleared after replay listed it:
   * whether that recreated its child.
   */
  async replayClearedRunForTest(runId: string): Promise<boolean> {
    await (
      this as unknown as {
        _agentTools: {
          _broadcastAgentToolStoredChunks(
            row: {
              run_id: string;
              agent_type: string;
              parent_tool_call_id: string | null;
            },
            sequence: number,
            replay?: true
          ): Promise<number>;
        };
      }
    )._agentTools._broadcastAgentToolStoredChunks(
      {
        run_id: runId,
        agent_type: "TestAgentToolStubChild",
        parent_tool_call_id: null
      },
      0,
      true
    );
    return this.hasSubAgent(TestAgentToolStubChild, runId);
  }

  /** Detached runs a released version left, one per ledger state. */
  async seedReleasedDetachedRowsForTest(): Promise<void> {
    ensureReleasedAgentToolTable(this.ctx.storage.sql);
    const now = Date.now();
    const seed = async (
      runId: string,
      row: {
        status: string;
        summary?: string;
        finishDelivered?: boolean;
        giveUpDelivered?: boolean;
        childStillRunning?: number;
      },
      child: StubRunInput
    ) => {
      const stub = await this.subAgent(TestAgentToolStubChild, runId);
      await stub.startAgentToolRun(child, { runId });
      ensureReleasedAgentToolTable(this.ctx.storage.sql);

      this.sql`
        INSERT INTO cf_agent_tool_runs (
          run_id, agent_type, status, summary, child_still_running,
          started_at, completed_at, detached, detached_on_finish,
          detached_max_budget_at, finish_delivered_at, give_up_delivered_at
        ) VALUES (
          ${runId}, 'TestAgentToolStubChild', ${row.status},
          ${row.summary ?? null}, ${row.childStillRunning ?? null}, ${now},
          ${row.status === "running" ? null : now}, 1, 'onDetachedDone',
          ${now + 3_600_000}, ${row.finishDelivered ? now : null},
          ${row.giveUpDelivered ? now : null}
        )
      `;
    };
    await seed(
      "released-delivered",
      { status: "completed", summary: "done", finishDelivered: true },
      { chunkBodies: [], summary: "done" }
    );
    await seed(
      "released-owed",
      { status: "completed", summary: "done" },
      { chunkBodies: [], summary: "done" }
    );
    await seed(
      "released-open",
      { status: "running" },
      { chunkBodies: [], summary: "finished while the parent was down" }
    );
    await seed(
      "released-torn-down",
      { status: "interrupted", giveUpDelivered: true, childStillRunning: 0 },
      { chunkBodies: [], staysRunning: true }
    );
    await seed(
      "released-may-run",
      { status: "interrupted", giveUpDelivered: true, childStillRunning: 1 },
      { chunkBodies: [], staysRunning: true }
    );
    // A released version armed its reconcile backbone as this schedule.
    await this.schedule(60, "_cfDetachedReconcileTick" as keyof this, {
      cadenceIndex: 0
    });
  }

  /** Whether the released `cf_agent_tool_runs` table still exists. */
  releasedTableLeftForTest(): boolean {
    return (
      this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sqlite_master
        WHERE type = 'table' AND name = 'cf_agent_tool_runs'
      `[0]?.n === 1
    );
  }

  /**
   * A facet (the stub child) carries a released awaited row forward; what
   * is left of its released table, and the run it became.
   */
  async carryForwardReleasedInFacetForTest(childName: string): Promise<{
    tableRows: number | null;
    status: string | null;
  }> {
    const child = await this.subAgent(TestAgentToolStubChild, childName);
    return child.carryForwardReleasedRowForTest();
  }

  /** Stands in for the released backbone callback a schedule row names. */
  async _cfDetachedReconcileTick(): Promise<void> {}

  /** The carry-forward, then what is left of the released state. */
  async carryForwardReleasedDetachedForTest(): Promise<{
    statuses: Record<string, string | null>;
    tableLeft: boolean;
    legacySchedules: number;
  }> {
    await this._agentTool._carryForwardAgentToolRuns();
    const statuses: Record<string, string | null> = {};
    for (const runId of [
      "released-delivered",
      "released-owed",
      "released-open",
      "released-torn-down",
      "released-may-run"
    ]) {
      statuses[runId] = this.tasks.peek(runId)?.status ?? null;
    }
    const tableLeft = this.releasedTableLeftForTest();
    const legacySchedules = (await this.listSchedules()).filter(
      (schedule) => schedule.callback === "_cfDetachedReconcileTick"
    ).length;
    return { statuses, tableLeft, legacySchedules };
  }

  /**
   * Run `check` with the stub child's cancel replaced: `before` runs first,
   * as if it landed between the parent's inspection and its cancel.
   */
  async checkWithChildBeforeCancelForTest(
    runId: string,
    before: "completes" | "is stopped" | "milestone and completes"
  ): Promise<void> {
    await this.detachedAttemptEndedForTest(runId);
    const self = (this as unknown as { _agentTools: unknown })._agentTools as {
      _asAgentToolChildAdapter(child: unknown): {
        cancelAgentToolRun(runId: string, reason?: unknown): Promise<void>;
      };
    };
    const original = self._asAgentToolChildAdapter.bind(self);
    self._asAgentToolChildAdapter = (resolved) => {
      const adapter = original(resolved);
      return new Proxy(adapter, {
        get: (target, key, receiver) => {
          if (key !== "cancelAgentToolRun") {
            return Reflect.get(target, key, receiver);
          }
          return async (id: string, reason?: unknown) => {
            if (before === "milestone and completes") {
              await this.finishChildForTest(
                id,
                "completes",
                "sources-gathered"
              );
            } else {
              await this.finishChildForTest(id, before);
            }
            return target.cancelAgentToolRun(id, reason);
          };
        }
      });
    };
    try {
      // The budget runs out only now, with the child's cancel replaced, so
      // whichever attempt gives up (this check or one its wake started)
      // meets the replaced cancel.
      this.expireDetachedBudgetForTest(runId);
      await this.checkDetachedForTest(runId);
    } finally {
      self._asAgentToolChildAdapter = original;
    }
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
    const child = await this.subAgent(TestAgentToolStubChild, options.runId);
    await child.startAgentToolRun(
      {
        chunkBodies: options.chunkBodies,
        milestones: [{ beforeChunk: 0, name: "begin" }],
        inspectDelayMs: options.inspectDelayMs
      },
      { runId: options.runId }
    );
    ensureReleasedAgentToolTable(this.ctx.storage.sql);

    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, summary,
        display_order, started_at, completed_at, detached
      ) VALUES (
        ${options.runId}, ${`call-${options.runId}`}, 'TestAgentToolStubChild',
        'completed', 'done', 0, ${Date.now()}, ${Date.now()}, 0
      )
    `;
    const startedAt = Date.now();
    await this._agentTool._carryForwardAgentToolRuns();
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
      const child = await this.subAgent(TestAgentToolStubChild, runId);
      await child.startAgentToolRun(
        { chunkBodies: [JSON.stringify({ type: "text-start", id: "t" })] },
        { runId }
      );
      ensureReleasedAgentToolTable(this.ctx.storage.sql);

      this.sql`
        INSERT INTO cf_agent_tool_runs (
          run_id, parent_tool_call_id, agent_type, status, summary,
          display_order, started_at, completed_at, detached
        ) VALUES (
          ${runId}, ${`call-${runId}`}, 'TestAgentToolStubChild',
          'completed', 'done', 0, ${startedAt}, ${startedAt}, 0
        )
      `;
    }

    const self = this as unknown as {
      _cf_resolveSubAgent(className: string, name: string): Promise<unknown>;
    };
    const original = self._cf_resolveSubAgent.bind(this);
    self._cf_resolveSubAgent = async (className, name) => {
      if (name === options.stalledRunId) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.resolveDelayMs)
        );
      }
      return original(className, name);
    };
    const replayStartedAt = Date.now();
    try {
      await this._agentTool._carryForwardAgentToolRuns();
      const frames = await this._captureReplayForTest();
      return { elapsedMs: Date.now() - replayStartedAt, frames };
    } finally {
      self._cf_resolveSubAgent = original;
    }
  }

  /**
   * The settled rows a released version left in `cf_agent_tool_runs`
   * (completed, error, interrupted) plus an open detached one, then the next
   * start's carry-forward. Returns what a re-issue of each awaited run
   * hands back, the connect-time replay, and the rows left in the table.
   */
  async carryForwardSettledReleasedRowsForTest(): Promise<{
    reissued: Record<
      string,
      {
        status: string;
        summary?: string;
        error?: string;
        reason?: string;
        childStillRunning?: boolean;
      }
    >;
    replayKinds: Record<string, string[]>;
    tableLeft: boolean;
    childStarts: number;
  }> {
    const now = Date.now();
    const seed = (
      runId: string,
      status: string,
      extra: {
        summary?: string;
        output?: unknown;
        error?: string;
        reason?: string;
        childStillRunning?: number;
      }
    ) => {
      ensureReleasedAgentToolTable(this.ctx.storage.sql);

      this.sql`
        INSERT INTO cf_agent_tool_runs (
          run_id, parent_tool_call_id, agent_type, input_preview,
          input_redacted, status, summary, output_json, error_message,
          interrupted_reason, child_still_running, display_metadata,
          display_order, started_at, completed_at, detached
        ) VALUES (
          ${runId}, ${`call-${runId}`}, 'TestAgentToolStubChild',
          ${JSON.stringify(`preview ${runId}`)}, 1, ${status},
          ${extra.summary ?? null},
          ${extra.output === undefined ? null : JSON.stringify(extra.output)},
          ${extra.error ?? null}, ${extra.reason ?? null},
          ${extra.childStillRunning ?? null},
          ${JSON.stringify({ name: runId })}, 0, ${now}, ${now}, 0
        )
      `;
    };
    seed("released-completed", "completed", {
      summary: "done",
      output: { answer: 42 }
    });
    seed("released-error", "error", { error: "child failed" });
    seed("released-interrupted", "interrupted", {
      error: "gave up",
      reason: "no-progress",
      childStillRunning: 1
    });
    ensureReleasedAgentToolTable(this.ctx.storage.sql);
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, agent_type, status, started_at, detached, detached_on_finish
      ) VALUES (
        'released-detached', 'TestAgentToolStubChild', 'running', ${now}, 1,
        'onDetachedDone'
      )
    `;

    await this._agentTool._carryForwardAgentToolRuns();

    // The interrupted run's child finished meanwhile: a re-issue re-attaches.
    const child = await this.subAgent(
      TestAgentToolStubChild,
      "released-interrupted"
    );
    await child.startAgentToolRun(
      { chunkBodies: [], summary: "finished later" },
      { runId: "released-interrupted" }
    );
    let childStarts = 0;
    const reissued: Record<
      string,
      {
        status: string;
        summary?: string;
        error?: string;
        reason?: string;
        childStillRunning?: boolean;
      }
    > = {};
    for (const runId of ["released-completed", "released-error"]) {
      const result = await this.runAgentTool(TestAgentToolStubChild, {
        runId,
        input: { chunkBodies: [], summary: "must not run" }
      });
      if (result.summary === "must not run") childStarts++;
      reissued[runId] = {
        status: result.status,
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
        ...(result.error !== undefined ? { error: result.error } : {})
      };
    }
    const frames = await this._captureReplayForTest();
    const replayKinds: Record<string, string[]> = {};
    for (const frame of frames) {
      const runId = (frame.event as { runId: string }).runId;
      (replayKinds[runId] ??= []).push(frame.event.kind);
    }
    const repaired = await this.runAgentTool(TestAgentToolStubChild, {
      runId: "released-interrupted",
      input: { chunkBodies: [], summary: "must not run" }
    });
    reissued["released-interrupted"] = {
      status: repaired.status,
      ...(repaired.summary !== undefined ? { summary: repaired.summary } : {})
    };
    return {
      reissued,
      replayKinds,
      tableLeft: this.releasedTableLeftForTest(),
      childStarts
    };
  }

  /**
   * An awaited run whose output is too large for a Task value: what the
   * caller gets, what the record keeps, and what a re-issue returns.
   */
  async runWithLargeOutputForTest(runId: string): Promise<{
    callerBytes: number;
    recordHasOutput: boolean;
    reissueBytes: number;
  }> {
    const output = { blob: "x".repeat(1_200_000) };
    const first = await this.runAgentTool(TestAgentToolStubChild, {
      runId,
      input: { chunkBodies: [], summary: "big", output }
    });
    const record = this.tasks.peek(runId)?.result as
      | { output?: unknown }
      | undefined;
    const again = await this.runAgentTool(TestAgentToolStubChild, {
      runId,
      input: { chunkBodies: [], summary: "must not run" }
    });
    const size = (value: unknown) =>
      value === undefined ? 0 : JSON.stringify(value).length;
    return {
      callerBytes: size(first.output),
      recordHasOutput: record?.output !== undefined,
      reissueBytes: size(again.output)
    };
  }

  /**
   * A released completed row whose output is too large for a Task value,
   * then an open row after it. The large row stays on the table, its only
   * copy; the open one is carried. A re-issue returns the large output from
   * the row even when the child is gone.
   */
  async carryOversizedReleasedRowForTest(): Promise<{
    carried: Record<string, string | null>;
    tableLeft: boolean;
    reissueBytes: number;
  }> {
    const output = { blob: "y".repeat(1_200_000) };
    const big = "released-big";
    const child = await this.subAgent(TestAgentToolStubChild, big);
    await child.startAgentToolRun(
      { chunkBodies: [], summary: "big", output },
      { runId: big }
    );
    const now = Date.now();
    ensureReleasedAgentToolTable(this.ctx.storage.sql);

    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, agent_type, status, summary, output_json, display_order,
        started_at, completed_at, detached
      ) VALUES (
        ${big}, 'TestAgentToolStubChild', 'completed', 'big',
        ${JSON.stringify(output)}, 0, ${now}, ${now}, 0
      )
    `;
    ensureReleasedAgentToolTable(this.ctx.storage.sql);

    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, agent_type, status, display_order, started_at, detached
      ) VALUES (
        'released-open-after', 'TestAgentToolStubChild', 'running', 0,
        ${now + 1}, 0
      )
    `;
    await this._agentTool._carryForwardAgentToolRuns();
    const carried: Record<string, string | null> = {};
    for (const runId of [big, "released-open-after"]) {
      carried[runId] = this.tasks.peek(runId)?.status ?? null;
    }
    const tableLeft = this.releasedTableLeftForTest();
    await this.deleteSubAgent(TestAgentToolStubChild, big);
    const again = await this.runAgentTool(TestAgentToolStubChild, {
      runId: big,
      input: { chunkBodies: [], summary: "must not run" }
    });
    return {
      carried,
      tableLeft,
      reissueBytes: JSON.stringify(again.output ?? "").length
    };
  }

  /**
   * A run a released version left open whose child then finished with an
   * output too large for a Task value. A caller joins the open run (as a
   * recovered turn does) while its recovered attempt runs: what it gets.
   */
  async joinRecoveredRunWithLargeOutputForTest(
    runId: string
  ): Promise<{ status: string; bytes: number; recordHasOutput: boolean }> {
    const child = await this.subAgent(TestAgentToolStubChild, runId);
    await child.startAgentToolRun(
      {
        chunkBodies: [],
        summary: "big",
        output: { blob: "z".repeat(1_200_000) }
      },
      { runId }
    );
    ensureReleasedAgentToolTable(this.ctx.storage.sql);

    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, agent_type, status, display_order, started_at, detached
      ) VALUES (
        ${runId}, 'TestAgentToolStubChild', 'running', 0, ${Date.now()}, 0
      )
    `;
    await this._agentTool._carryForwardAgentToolRuns();
    const joined = this.runAgentTool(TestAgentToolStubChild, {
      runId,
      input: { chunkBodies: [], summary: "must not run" }
    });
    await this.tasks.runDue("__cf_agent_tool");
    const result = await joined;
    const record = this.tasks.peek(runId)?.result as
      | { output?: unknown }
      | undefined;
    return {
      status: result.status,
      bytes: JSON.stringify(result.output ?? "").length,
      recordHasOutput: record?.output !== undefined
    };
  }

  /**
   * A completed row a released version kept without its output, while the
   * child still has it: what a re-issue after the carry-forward returns.
   */
  async reissueCarriedRowWithoutOutputForTest(
    runId: string
  ): Promise<{ status: string; output: unknown }> {
    const child = await this.subAgent(TestAgentToolStubChild, runId);
    await child.startAgentToolRun(
      { chunkBodies: [], summary: "done", output: { answer: 42 } },
      { runId }
    );
    ensureReleasedAgentToolTable(this.ctx.storage.sql);

    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, agent_type, status, summary, display_order, started_at,
        completed_at, detached
      ) VALUES (
        ${runId}, 'TestAgentToolStubChild', 'completed', 'done', 0,
        ${Date.now()}, ${Date.now()}, 0
      )
    `;
    await this._agentTool._carryForwardAgentToolRuns();
    const result = await this.runAgentTool(TestAgentToolStubChild, {
      runId,
      input: { chunkBodies: [], summary: "must not run" }
    });
    return { status: result.status, output: result.output };
  }

  /**
   * A run a released version left open whose child is stuck (its tail never
   * sends or closes), with a 3 s no-progress budget: how long one check of
   * the recovered run takes, and what the run waits for after it.
   */
  async checkRecoveredRunWithStuckChildForTest(runId: string): Promise<{
    elapsedMs: number;
    status: string | null;
    waitReason?: string;
  }> {
    const child = await this.subAgent(TestAgentToolStubChild, runId);
    await child.startAgentToolRun(
      { chunkBodies: [], tailHangs: true },
      { runId }
    );
    ensureReleasedAgentToolTable(this.ctx.storage.sql);
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, agent_type, status, display_order, started_at, detached
      ) VALUES (
        ${runId}, 'TestAgentToolStubChild', 'running', 0, ${Date.now()}, 0
      )
    `;
    await this._agentTool._carryForwardAgentToolRuns();
    const resolved = (
      this as unknown as {
        _resolvedOptions: { agentToolReattachNoProgressTimeoutMs: number };
      }
    )._resolvedOptions;
    const before = resolved.agentToolReattachNoProgressTimeoutMs;
    resolved.agentToolReattachNoProgressTimeoutMs = 3_000;
    const startedAt = Date.now();
    try {
      await this.tasks.runDue("__cf_agent_tool");
    } finally {
      resolved.agentToolReattachNoProgressTimeoutMs = before;
    }
    const record = this.tasks.peek(runId);
    return {
      elapsedMs: Date.now() - startedAt,
      status: record?.status ?? null,
      ...(record?.waitReason !== undefined
        ? { waitReason: record.waitReason }
        : {})
    };
  }

  /** Times the forward-progress hook ran (chat hosts credit recovery). */
  streamProgressCredits = 0;

  protected override async _onAgentToolStreamProgress(): Promise<void> {
    this.streamProgressCredits++;
  }

  /**
   * A run a released version left open, whose stub child is still running
   * with `stored` chunks. Carries it forward and runs its first check.
   */
  private async recoverRunningChildForTest(
    runId: string,
    stored: string[]
  ): Promise<{
    poll: (
      beforeEach?: () => Promise<void>
    ) => Promise<AgentToolEventMessage[]>;
    child: DurableObjectStub<TestAgentToolStubChild>;
  }> {
    const child = await this.subAgent(TestAgentToolStubChild, runId);
    await child.startAgentToolRun(
      { chunkBodies: stored, tailHangs: true },
      { runId }
    );
    ensureReleasedAgentToolTable(this.ctx.storage.sql);
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached
      ) VALUES (
        ${runId}, ${`call-${runId}`}, 'TestAgentToolStubChild', 'running', 0,
        ${Date.now()}, 0
      )
    `;
    await this._agentTool._carryForwardAgentToolRuns();
    await this.tasks.runDue("__cf_agent_tool");
    const poll = async () =>
      this._captureBroadcastsForTest(async () => {
        this.makeAgentToolRunsDueForTest();
        await this.tasks.runDue("__cf_agent_tool");
      });
    return {
      poll,
      child: child as unknown as DurableObjectStub<TestAgentToolStubChild>
    };
  }

  /** Put a recovered run's last progress `ms` in the past. */
  private ageReattachProgressForTest(runId: string, ms: number): void {
    this.sql`
      UPDATE cf_agents_task_runs
      SET checkpoint = json_set(checkpoint, '$.reattachProgressAt',
                                ${Date.now() - ms})
      WHERE run_id = ${runId}
    `;
  }

  /**
   * A recovered run whose child keeps running and reports progress but
   * stores no chunk, checked after its no-progress window would have
   * passed. Returns the run's status after the check.
   */
  async recoveredChildReportsProgressForTest(
    runId: string
  ): Promise<string | null> {
    const resolved = (
      this as unknown as {
        _resolvedOptions: { agentToolReattachNoProgressTimeoutMs: number };
      }
    )._resolvedOptions;
    const before = resolved.agentToolReattachNoProgressTimeoutMs;
    resolved.agentToolReattachNoProgressTimeoutMs = 60_000;
    try {
      const { poll, child } = await this.recoverRunningChildForTest(runId, []);
      this.ageReattachProgressForTest(runId, 120_000);
      await child.reportProgressForTest(runId);
      await poll();
      return this.tasks.peek(runId)?.status ?? null;
    } finally {
      resolved.agentToolReattachNoProgressTimeoutMs = before;
    }
  }

  /**
   * A recovered run whose child stores a chunk while still running, then
   * has its turn recovered into a new stream. Returns the chunk bodies each
   * check forwarded and the progress credits.
   */
  async recoveredChildStreamsForTest(runId: string): Promise<{
    whileRunning: string[];
    afterNewStream: string[];
    credits: number;
  }> {
    const { poll, child } = await this.recoverRunningChildForTest(runId, [
      "a",
      "b",
      "c"
    ]);
    const bodies = (frames: AgentToolEventMessage[]) =>
      frames
        .filter((frame) => frame.event.kind === "chunk")
        .map((frame) => (frame.event as { body: string }).body);
    await child.appendChunkForTest(runId, "d");
    const whileRunning = bodies(await poll());
    await child.restartStreamForTest(runId, ["e", "f"]);
    const afterNewStream = bodies(await poll());
    return {
      whileRunning,
      afterNewStream,
      credits: this.streamProgressCredits
    };
  }

  /** Each detached delivery: serialized behind a lane, and from a report. */
  detachedDeliveryContexts: { serialize: boolean; inReport: boolean }[] = [];
  private _inDetachedReport = false;

  protected override async _runDetachedDelivery(
    invoke: () => Promise<void>,
    options?: { serialize?: boolean }
  ): Promise<void> {
    this.detachedDeliveryContexts.push({
      serialize: options?.serialize === true,
      inReport: this._inDetachedReport
    });
    return super._runDetachedDelivery(invoke, options);
  }

  /**
   * Mark deliveries made from a detached run's terminal report, which can
   * run inside a job with no dispatch budget.
   */
  watchDetachedReportsForTest(): void {
    const self = (this as unknown as { _agentTools: unknown })._agentTools as {
      _onDetachedAgentToolStatus(record: unknown): Promise<void>;
    };
    const original = self._onDetachedAgentToolStatus.bind(self);
    self._onDetachedAgentToolStatus = async (record) => {
      this._inDetachedReport = true;
      try {
        await original(record);
      } finally {
        this._inDetachedReport = false;
      }
    };
  }

  getDetachedDeliveryContextsForTest(): {
    serialize: boolean;
    inReport: boolean;
  }[] {
    return this.detachedDeliveryContexts;
  }

  /** Make every waiting awaited run's next check due now. */
  makeAgentToolRunsDueForTest(): void {
    this.sql`
      UPDATE cf_agents_task_runs SET next_at = ${Date.now() - 1}
      WHERE definition = '__cf_agent_tool' AND status = 'pending'
    `;
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
    const child = await this.subAgent(TestAgentToolStubChild, options.runId);
    await child.startAgentToolRun(
      {
        chunkBodies: options.storedChunkBodies,
        pendingChunkBodies: options.pendingChunkBodies
      },
      { runId: options.runId }
    );
    ensureReleasedAgentToolTable(this.ctx.storage.sql);

    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached
      ) VALUES (
        ${options.runId}, ${`call-${options.runId}`}, 'TestAgentToolStubChild',
        'running', 0, ${Date.now()}, 0
      )
    `;
    // The row is what a released version left: carry it into its task as
    // the next start does, then run the interrupted attempt.
    await this._agentTool._carryForwardAgentToolRuns();
    const seen = await this._captureReplayForTest();
    const recovery = await this._captureBroadcastsForTest(async () => {
      // The first check finds the child still running.
      await this.tasks.runDue("__cf_agent_tool");
      // The child produces the rest and ends; the next check follows it.
      await child.flushPendingForTest(options.runId);
      this.makeAgentToolRunsDueForTest();
      await this.tasks.runDue("__cf_agent_tool");
      await this.tasks.wait(options.runId);
    });
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
  /**
   * Seed one settled awaited row the way a released version kept it, carry
   * it forward, and report the table (`null` once dropped) and the run.
   */
  async carryForwardReleasedRowForTest(): Promise<{
    tableRows: number | null;
    status: string | null;
  }> {
    ensureReleasedAgentToolTable(this.ctx.storage.sql);
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, agent_type, status, summary, display_order, started_at,
        completed_at, detached
      ) VALUES (
        'released-in-facet', 'TestAgentToolStubChild', 'completed', 'done', 0,
        ${Date.now()}, ${Date.now()}, 0
      )
    `;
    const agentTools = (
      this as unknown as {
        _agentTools: { _carryForwardAgentToolRuns(): Promise<void> };
      }
    )._agentTools;
    await agentTools._carryForwardAgentToolRuns();
    const table =
      this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sqlite_master
        WHERE type = 'table' AND name = 'cf_agent_tool_runs'
      `[0]?.n === 1;
    return {
      tableRows: table
        ? Number(
            this.ctx.storage.sql
              .exec("SELECT COUNT(*) AS n FROM cf_agent_tool_runs")
              .one().n
          )
        : null,
      status: this.tasks.peek("released-in-facet")?.status ?? null
    };
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
        inspect_delay_ms INTEGER,
        output_json TEXT,
        progress_at INTEGER,
        stream_id TEXT,
        cancel_fails INTEGER
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
    // Like Think / AIChat, a start of a run the child already has returns it.
    const existing = this.sql<{ started_at: number; status: string }>`
      SELECT started_at, status FROM cf_test_stub_runs
      WHERE run_id = ${options.runId}
    `[0];
    if (existing) {
      return {
        runId: options.runId,
        status: existing.status as AgentToolRunInspection["status"],
        startedAt: existing.started_at
      };
    }
    const startedAt = Date.now();
    const chunkBodies = input?.chunkBodies ?? [];
    this._storeChunks(options.runId, chunkBodies, 0);
    const pending =
      input?.pendingChunkBodies ?? (input?.tailHangs ? [] : undefined);
    const open = pending !== undefined || input?.staysRunning === true;
    const status = open ? "running" : "completed";
    const completedAt = open ? null : Date.now();
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
         milestones_json, unstored_json, pending_json, inspect_delay_ms,
         output_json, cancel_fails)
      VALUES
        (${options.runId}, ${status}, ${summary}, ${null}, ${startedAt},
         ${completedAt}, ${milestonesJson}, ${unstoredJson}, ${pendingJson},
         ${input?.inspectDelayMs ?? null},
         ${input?.output === undefined ? null : JSON.stringify(input.output)},
         ${input?.cancelFails ? 1 : 0})
    `;
    return {
      runId: options.runId,
      status,
      summary: input?.summary,
      startedAt,
      completedAt: completedAt ?? undefined
    };
  }

  async cancelAgentToolRun(runId: string, reason?: string): Promise<void> {
    this._ensureTables();
    const fails = this.sql<{ cancel_fails: number | null }>`
      SELECT cancel_fails FROM cf_test_stub_runs WHERE run_id = ${runId}
    `[0];
    if (fails?.cancel_fails) throw new Error("cancel failed");
    // Like Think / AIChat, cancelling an already-finished run is a no-op, and
    // a cancel records its reason as the aborted run's error.
    this.sql`
      UPDATE cf_test_stub_runs
      SET status = 'aborted', error = ${reason ?? null},
          completed_at = ${Date.now()}, pending_json = NULL
      WHERE run_id = ${runId} AND completed_at IS NULL
    `;
  }

  /** Record a milestone on a stub run so later inspections report it. */
  addMilestoneForTest(runId: string, name: string): void {
    this._ensureTables();
    const milestones = this._milestones(runId);
    milestones.push({ beforeChunk: milestones.length, name });
    this.sql`
      UPDATE cf_test_stub_runs SET milestones_json = ${JSON.stringify(milestones)}
      WHERE run_id = ${runId}
    `;
  }

  /** A running run reports progress, storing no chunk. */
  reportProgressForTest(runId: string): void {
    this._ensureTables();
    this.sql`
      UPDATE cf_test_stub_runs SET progress_at = ${Date.now()}
      WHERE run_id = ${runId}
    `;
  }

  /** A running run stores one more chunk and stays running. */
  async appendChunkForTest(runId: string, body: string): Promise<void> {
    this._ensureTables();
    const stored = await this.getAgentToolChunks(runId);
    this._storeChunks(runId, [body], stored.length);
  }

  /**
   * The run's turn was recovered into a new stream: its chunks start again
   * from 0 there, and inspection names the new stream.
   */
  restartStreamForTest(runId: string, bodies: string[]): void {
    this._ensureTables();
    this.sql`DELETE FROM cf_test_stub_chunks WHERE run_id = ${runId}`;
    this._storeChunks(runId, bodies, 0);
    this.sql`
      UPDATE cf_test_stub_runs SET stream_id = ${crypto.randomUUID()}
      WHERE run_id = ${runId}
    `;
  }

  /** Store a run's pending chunks and complete it, as its turn would. */
  async flushPendingForTest(runId: string): Promise<void> {
    this._ensureTables();
    const run = this.sql<{ pending_json: string | null }>`
      SELECT pending_json FROM cf_test_stub_runs WHERE run_id = ${runId}
    `[0];
    if (!run?.pending_json) return;
    const stored = await this.getAgentToolChunks(runId);
    this._storeChunks(runId, JSON.parse(run.pending_json), stored.length);
    this.sql`
      UPDATE cf_test_stub_runs
      SET status = 'completed', completed_at = ${Date.now()},
          pending_json = NULL
      WHERE run_id = ${runId}
    `;
  }

  /** End a still-running stub run `aborted` for a reason of its own. */
  stopRunForTest(runId: string, reason: string): void {
    this._ensureTables();
    this.sql`
      UPDATE cf_test_stub_runs
      SET status = 'aborted', error = ${reason}, completed_at = ${Date.now()},
          pending_json = NULL
      WHERE run_id = ${runId} AND completed_at IS NULL
    `;
  }

  /** Finish a still-running stub run with its stored summary. */
  completeRunForTest(runId: string): void {
    this._ensureTables();
    this.sql`
      UPDATE cf_test_stub_runs
      SET status = 'completed', completed_at = ${Date.now()}
      WHERE run_id = ${runId} AND completed_at IS NULL
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
      output_json: string | null;
      progress_at: number | null;
      stream_id: string | null;
    }>`
      SELECT status, summary, error, started_at, completed_at, inspect_delay_ms,
             output_json, progress_at, stream_id
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
      ...(row.status === "completed" && row.output_json !== null
        ? { output: JSON.parse(row.output_json) }
        : {}),
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      ...(row.progress_at !== null
        ? { progress: { at: row.progress_at } }
        : {}),
      ...(row.stream_id !== null ? { streamId: row.stream_id } : {}),
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
    if (run?.pending_json === "[]") {
      // A child that is stuck: nothing is ever sent, and the tail stays open.
      return new ReadableStream<AgentToolStoredChunk>();
    }
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
