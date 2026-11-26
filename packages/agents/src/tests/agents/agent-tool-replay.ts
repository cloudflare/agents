import { Agent, callable, type Connection } from "../../index.ts";
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
  _carryForwardAgentToolRuns(): Promise<void>;
  _deliverDetachedTerminal(
    runId: string,
    kind: "finish" | "give_up",
    result: RunAgentToolResult,
    options?: { sequence?: number; serialize?: boolean },
    completedAt?: number
  ): Promise<void>;
  _hasOutstandingDetachedRuns(): boolean;
  _detachedFastPath(
    runInfo: AgentToolRunInfo,
    cls: unknown,
    runId: string
  ): Promise<void>;
  _armDetachedBackbone(options?: { resetCadence?: boolean }): Promise<void>;
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

export class TestAgentToolReplayAgent extends Agent {
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
        run_id, parent_tool_call_id, agent_type, status, display_order, started_at
      ) VALUES (
        ${runId}, ${`call-${runId}`}, 'Child', 'starting', 0, ${Date.now()}
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
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish, detached_notify_source,
        detached_max_budget_at
      ) VALUES (
        ${runId}, ${null}, 'Child', 'running', 0, ${Date.now()}, 1,
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
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish, detached_max_budget_at,
        detached_no_progress_budget_ms, last_progress_at
      ) VALUES (
        ${runId}, ${null}, 'Child', 'running', 0, ${Date.now()}, 1,
        'onDetachedDone', ${null}, ${noProgressBudgetMs}, ${lastProgressAt}
      )
    `;
  }

  /** Seed a non-detached `running` row to prove cancel ownership stays awaited. */
  seedAwaitedRunForTest(runId: string): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached
      ) VALUES (
        ${runId}, ${null}, 'TestAgentToolStubChild', 'running', 0,
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

  /**
   * Make the pending detached backbone schedule due now and point the
   * Durable Object alarm at it, so `runDurableObjectAlarm` fires the real
   * scheduled retry instead of the test calling the tick directly.
   */
  async makeDetachedBackboneDueForTest(): Promise<void> {
    const past = Date.now() - 1_000;
    this.sql`
      UPDATE cf_agents_jobs SET time = ${past}
      WHERE fn = '_cfDetachedReconcileTick'
    `;
    await this.ctx.storage.setAlarm(Date.now() + 1000);
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

  hasOutstandingDetachedRunsForTest(): boolean {
    return this._agentTool._hasOutstandingDetachedRuns();
  }

  async deliverGiveUpForTest(
    runId: string,
    childStillRunning = true
  ): Promise<void> {
    await this._agentTool._deliverDetachedTerminal(runId, "give_up", {
      runId,
      agentType: "Child",
      status: "interrupted",
      error: "detached run exceeded its budget before completing",
      reason: "budget-exceeded",
      childStillRunning
    });
  }

  /**
   * A detached run past its budget whose child (a real
   * {@link TestAgentToolStubChild}) completes just after the backbone inspects
   * it as `running` but before its cancel lands (#2768 review). Runs one
   * backbone tick and reports what was delivered.
   */
  async giveUpRacingChildCompletionForTest(
    runId: string,
    lateMilestone?: string,
    childEnds: "completes" | "is stopped" = "completes"
  ): Promise<{
    log: DetachedDeliveryLogEntry[];
    milestones: string[];
    outstanding: boolean;
    schedules: number;
    status: string | null;
  }> {
    const child = await this.subAgent(TestAgentToolStubChild, runId);
    await child.startAgentToolRun(
      { chunkBodies: [], pendingChunkBodies: [], summary: "real result" },
      { runId }
    );
    const onMilestones = lateMilestone
      ? JSON.stringify({ names: [lateMilestone], mode: "narrate" })
      : null;
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish, detached_max_budget_at,
        detached_on_milestones
      ) VALUES (
        ${runId}, ${null}, 'TestAgentToolStubChild', 'running', 0,
        ${Date.now()}, 1, 'onDetachedDone', ${Date.now() - 1000},
        ${onMilestones}
      )
    `;
    const self = this as unknown as {
      _cf_resolveSubAgent(className: string, name: string): Promise<unknown>;
    };
    const original = self._cf_resolveSubAgent.bind(this);
    let resolves = 0;
    self._cf_resolveSubAgent = async (className, name) => {
      // The second resolve is the cancel: the child finishes right before it.
      // A milestone recorded in that window is only seen after the cancel.
      if (name === runId && ++resolves === 2) {
        if (lateMilestone)
          await child.addMilestoneForTest(runId, lateMilestone);
        if (childEnds === "completes") await child.completeRunForTest(runId);
        else await child.cancelAgentToolRun(runId, "stopped by its client");
      }
      return original(className, name);
    };
    try {
      await this._cfDetachedReconcileTick();
    } finally {
      self._cf_resolveSubAgent = original;
    }
    return {
      log: this.detachedDeliveryLog.filter((entry) => entry.runId === runId),
      milestones: this.detachedMilestoneLog
        .filter((entry) => entry.runId === runId)
        .map((entry) => entry.name),
      outstanding: this._agentTool._hasOutstandingDetachedRuns(),
      schedules: (await this.detachedBackboneSchedulesForTest()).length,
      status: this.readRunStatusForTest(runId)
    };
  }

  /** A detached run past its budget whose stub child is still running. */
  private async seedRunningRunPastBudget(
    runId: string,
    onFinish: string
  ): Promise<void> {
    const child = await this.subAgent(TestAgentToolStubChild, runId);
    await child.startAgentToolRun(
      { chunkBodies: [], pendingChunkBodies: [], summary: "never reached" },
      { runId }
    );
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish, detached_max_budget_at
      ) VALUES (
        ${runId}, ${null}, 'TestAgentToolStubChild', 'running', 0,
        ${Date.now()}, 1, ${onFinish}, ${Date.now() - 1000}
      )
    `;
  }

  /**
   * A budget give-up whose callback fails once, on a cold parent: the next
   * tick, once the give-up claim's lease has expired, finds the child
   * `aborted` by that give-up's cancel. Returns the per-run callback statuses.
   */
  async giveUpCallbackFailsOnceForTest(
    runId: string
  ): Promise<{ statuses: string[]; outstanding: boolean }> {
    await this.seedRunningRunPastBudget(runId, "onDetachedFailsOnce");
    await this._cfDetachedReconcileTick().catch(() => {});
    this.sql`
      UPDATE cf_agent_tool_runs SET give_up_claimed_at = 0
      WHERE run_id = ${runId}
    `;
    await this._cfDetachedReconcileTick();
    return {
      statuses: this.detachedDeliveryLog
        .filter(
          (entry) => entry.runId === runId && entry.hook === "onDetachedDone"
        )
        .map((entry) => entry.status),
      outstanding: this._agentTool._hasOutstandingDetachedRuns()
    };
  }

  /**
   * A budget give-up whose cancel lands but whose post-cancel inspection
   * fails, so the give-up goes out with the teardown unconfirmed. Runs that
   * one tick; the test fires the backbone it re-armed.
   */
  async giveUpWithFailedPostCancelInspectionForTest(
    runId: string
  ): Promise<{ outstanding: boolean; schedules: number }> {
    await this.seedRunningRunPastBudget(runId, "onDetachedDone");
    const self = this as unknown as {
      _asAgentToolChildAdapter(child: unknown): {
        inspectAgentToolRun(runId: string): Promise<unknown>;
      };
    };
    const original = self._asAgentToolChildAdapter.bind(this);
    let inspections = 0;
    self._asAgentToolChildAdapter = (resolved) => {
      const adapter = original(resolved);
      return new Proxy(adapter, {
        get(target, key, receiver) {
          if (key !== "inspectAgentToolRun") {
            return Reflect.get(target, key, receiver);
          }
          return async (id: string) => {
            // The tick's second inspection follows its cancel.
            if (++inspections === 2) throw new Error("inspection failed");
            return target.inspectAgentToolRun(id);
          };
        }
      });
    };
    try {
      await this._cfDetachedReconcileTick();
    } finally {
      self._asAgentToolChildAdapter = original;
    }
    return {
      outstanding: this._agentTool._hasOutstandingDetachedRuns(),
      schedules: (await this.detachedBackboneSchedulesForTest()).length
    };
  }

  /**
   * A detached run past its budget whose child is still running, with the warm
   * fast path tailing it. The backbone tick cancels the child for the give-up,
   * which ends the warm tail on the child's `aborted`. `tail` picks when the
   * fast path inspects the child: between the tick's cancel and its give-up
   * delivery, or after the tick. Returns the per-run callback statuses and
   * the status each inspection read, the fast path's marked `fast:`.
   */
  async giveUpWithWarmTailForTest(
    runId: string,
    tail: "during-give-up" | "after-give-up"
  ): Promise<{
    statuses: string[];
    inspected: string[];
    outstanding: boolean;
    schedules: number;
  }> {
    await this.seedRunningRunPastBudget(runId, "onDetachedDone");
    type Inspection = { status: string } | null;
    const self = this as unknown as {
      _asAgentToolChildAdapter(child: unknown): {
        inspectAgentToolRun(runId: string): Promise<Inspection>;
      };
    };
    const original = self._asAgentToolChildAdapter.bind(this);
    const inspected: string[] = [];
    let inFastPath = false;
    let tickInspections = 0;
    const runFastPath = async () => {
      inFastPath = true;
      try {
        await this._agentTool._detachedFastPath(
          {
            runId,
            agentType: "TestAgentToolStubChild",
            parentToolCallId: undefined
          } as unknown as AgentToolRunInfo,
          TestAgentToolStubChild,
          runId
        );
      } finally {
        inFastPath = false;
      }
    };
    self._asAgentToolChildAdapter = (resolved) => {
      const adapter = original(resolved);
      return new Proxy(adapter, {
        get(target, key, receiver) {
          if (key !== "inspectAgentToolRun") {
            return Reflect.get(target, key, receiver);
          }
          return async (id: string) => {
            const fast = inFastPath;
            // The tick's second inspection follows its cancel: run the warm
            // fast path to the end first, as the closed tail would.
            if (!fast && ++tickInspections === 2 && tail === "during-give-up") {
              await runFastPath();
            }
            const inspection = await target.inspectAgentToolRun(id);
            inspected.push(`${fast ? "fast:" : ""}${inspection?.status}`);
            return inspection;
          };
        }
      });
    };
    try {
      await this._cfDetachedReconcileTick();
      if (tail === "after-give-up") await runFastPath();
    } finally {
      self._asAgentToolChildAdapter = original;
    }
    return {
      statuses: this.detachedDeliveryLog
        .filter(
          (entry) => entry.runId === runId && entry.hook === "onDetachedDone"
        )
        .map((entry) => entry.status),
      inspected,
      outstanding: this._agentTool._hasOutstandingDetachedRuns(),
      schedules: (await this.detachedBackboneSchedulesForTest()).length
    };
  }

  /**
   * A detached run already given up with its child torn down (so polling has
   * stopped), whose warm fast path then claims the child's terminal and its
   * finish callback fails once. Returns the backbone schedules left behind.
   */
  async fastPathFailsAfterGiveUpForTest(
    runId: string
  ): Promise<{ outstanding: boolean; schedules: number }> {
    const child = await this.subAgent(TestAgentToolStubChild, runId);
    await child.startAgentToolRun(
      { chunkBodies: [], summary: "late result" },
      { runId }
    );
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish, child_still_running,
        give_up_delivered_at
      ) VALUES (
        ${runId}, ${null}, 'TestAgentToolStubChild', 'interrupted', 0,
        ${Date.now()}, 1, 'onDetachedFinishFailsOnce', 0, ${Date.now()}
      )
    `;
    await this._agentTool._detachedFastPath(
      {
        runId,
        agentType: "TestAgentToolStubChild",
        parentToolCallId: undefined
      } as unknown as AgentToolRunInfo,
      TestAgentToolStubChild,
      runId
    );
    return {
      outstanding: this._agentTool._hasOutstandingDetachedRuns(),
      schedules: (await this.detachedBackboneSchedulesForTest()).length
    };
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
    tableRows: Array<{ run_id: string; detached: number }>;
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
    this.seedDetachedRunForTest("released-detached");

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
      tableRows: this.sql<{ run_id: string; detached: number }>`
        SELECT run_id, detached FROM cf_agent_tool_runs ORDER BY run_id
      `,
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
   * then an open row after it: both are carried, the large one without its
   * output, which a re-issue reads back from the child.
   */
  async carryOversizedReleasedRowForTest(): Promise<{
    carried: Record<string, string | null>;
    tableRows: number;
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
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, agent_type, status, summary, output_json, display_order,
        started_at, completed_at, detached
      ) VALUES (
        ${big}, 'TestAgentToolStubChild', 'completed', 'big',
        ${JSON.stringify(output)}, 0, ${now}, ${now}, 0
      )
    `;
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
    const tableRows =
      this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      `[0]?.n ?? 0;
    const again = await this.runAgentTool(TestAgentToolStubChild, {
      runId: big,
      input: { chunkBodies: [], summary: "must not run" }
    });
    return {
      carried,
      tableRows,
      reissueBytes: JSON.stringify(again.output ?? "").length
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
        output_json TEXT
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
         milestones_json, unstored_json, pending_json, inspect_delay_ms,
         output_json)
      VALUES
        (${options.runId}, ${status}, ${summary}, ${null}, ${startedAt},
         ${completedAt}, ${milestonesJson}, ${unstoredJson}, ${pendingJson},
         ${input?.inspectDelayMs ?? null},
         ${input?.output === undefined ? null : JSON.stringify(input.output)})
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
    }>`
      SELECT status, summary, error, started_at, completed_at, inspect_delay_ms,
             output_json
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
