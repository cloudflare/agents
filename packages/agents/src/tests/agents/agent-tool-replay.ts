import {
  Agent,
  callable,
  getAgentToolsHost,
  setAgentToolsHost,
  type Connection
} from "../../index.ts";
import type {
  AgentToolChildAdapter,
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

/** What a scripted child adapter should pretend to be doing. */
type ScriptedChildScenario =
  /** Non-terminal, and its live tail never produces anything or closes. */
  | { kind: "running" }
  /** Cannot be inspected at all (an unreachable / broken child). */
  | { kind: "inspect-throws" }
  /** Already at a terminal result. */
  | {
      kind: "terminal";
      /** A child only ever reports a HARD terminal about itself. */
      status: Exclude<AgentToolTerminalStatus, "interrupted">;
      text?: string;
    };

/** A scripted child adapter plus what the capability did to it. */
type ScriptedChild = {
  readonly adapter: AgentToolChildAdapter;
  /** Run ids the capability asked the child to cancel (teardown evidence). */
  readonly cancelled: string[];
};

/**
 * A scripted stand-in for a real (RPC) child facet. The parent engine only ever
 * reaches a child through this adapter shape, so scripting it is how a test
 * injects a child fault without touching the capability's internals.
 */
function scriptedChild(scenario: ScriptedChildScenario): ScriptedChild {
  const cancelled: string[] = [];
  const inspection = (runId: string): AgentToolRunInspection => {
    if (scenario.kind !== "terminal") {
      return { runId, status: "running", startedAt: 0 };
    }
    return {
      runId,
      status: scenario.status,
      startedAt: 0,
      completedAt: Date.now(),
      ...(scenario.status === "completed"
        ? { summary: scenario.text, output: scenario.text }
        : { error: scenario.text })
    };
  };
  const adapter: AgentToolChildAdapter = {
    startAgentToolRun: async (_input, options) => inspection(options.runId),
    cancelAgentToolRun: async (runId) => {
      cancelled.push(runId);
    },
    inspectAgentToolRun: async (runId) => {
      if (scenario.kind === "inspect-throws") {
        throw new Error("scripted child cannot be inspected");
      }
      return inspection(runId);
    },
    getAgentToolChunks: async () => [],
    tailAgentToolRun: async () =>
      new ReadableStream<AgentToolStoredChunk>({
        start(controller) {
          // A still-running child holds its tail open with nothing to send, so
          // the parent's budgets (not the stream) decide when to stop waiting.
          if (scenario.kind !== "running") controller.close();
        }
      })
  };
  return { adapter, cancelled };
}

export class TestAgentToolReplayAgent extends Agent {
  private get _agentTool() {
    return this.agentTools;
  }

  /**
   * Run `body` with the capability's CHILD boundary replaced by a scripted
   * in-process adapter.
   *
   * This is the seam every fault injection below uses: the capability resolves
   * children through its installed host port, so re-installing that port with a
   * different `resolveChild` scripts the child without reaching into the
   * capability's internals. Restores the real port afterwards.
   */
  private async _withScriptedChild<T>(
    scenario: ScriptedChildScenario,
    body: (script: ScriptedChild) => Promise<T>
  ): Promise<T> {
    const host = getAgentToolsHost(this.agentTools);
    if (!host) throw new Error("agent-tool host bindings are not installed");
    const script = scriptedChild(scenario);
    setAgentToolsHost(this.agentTools, {
      ...host,
      resolveChild: async () => script.adapter
    });
    try {
      return await body(script);
    } finally {
      setAgentToolsHost(this.agentTools, host);
    }
  }

  /** Insert a `running` parent row the recovery paths can pick up. */
  private _insertRunningRunForTest(runId: string): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order, started_at
      ) VALUES (
        ${runId}, ${`call-${runId}`}, 'Child', 'running', 0, ${Date.now()}
      )
    `;
  }

  /**
   * Seal a stranded `interrupted` run row through the REAL recovery path — no
   * test-only write into the capability's table. A `running` row is reconciled
   * against a scripted child that never reaches terminal, which is exactly what
   * parent recovery does when it gives up on a still-running child (#1630), and
   * is the write side of the round-trip the bug regressed.
   *
   * - `no-progress`: the re-attach budget is spent without waiting (the child is
   *   non-terminal), so the seal is SOFT and the child is left running.
   * - `window-exceeded`: the hard wall-clock ceiling ends the wait on a silent
   *   child, which also tears it down (`childStillRunning: false`).
   * - `inspect-failed`: the child cannot be inspected at all, so the seal
   *   records a reason with no knowledge of the child (no `childStillRunning`).
   */
  @callable()
  async sealInterruptedRunForTest(
    runId: string,
    cause: "no-progress" | "window-exceeded" | "inspect-failed"
  ): Promise<void> {
    this._insertRunningRunForTest(runId);
    await this._withScriptedChild(
      cause === "inspect-failed"
        ? { kind: "inspect-throws" }
        : { kind: "running" },
      async () => {
        await this._agentTool.reconcile({
          runIds: [runId],
          childInspectionTimeoutMs: 50,
          // `no-progress` spends the budget without tailing; `window-exceeded`
          // tails the silent child until the finite ceiling fires.
          reattachTimeoutMs: cause === "window-exceeded" ? 5_000 : 0,
          reattachMaxWindowMs:
            cause === "window-exceeded" ? 150 : Number.POSITIVE_INFINITY
        });
      }
    );
  }

  /**
   * Seed an `interrupted` row with NO persisted cause — the shape a row
   * stranded before the cause columns existed has on disk.
   */
  @callable()
  seedLegacyInterruptedRunForTest(runId: string): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, error_message,
        display_order, started_at, completed_at
      ) VALUES (
        ${runId}, ${`call-${runId}`}, 'Child', 'interrupted',
        'Agent tool run was still running and did not reach a terminal result.',
        0, ${Date.now()}, ${Date.now()}
      )
    `;
  }

  /**
   * Repair an `interrupted` row to `completed` the way a re-issue does once the
   * child self-heals: re-dispatch the same runId and let the re-attach collect
   * the child's real terminal result.
   */
  async repairRunViaReissueForTest(
    runId: string,
    summary: string
  ): Promise<RunAgentToolResult> {
    return this._withScriptedChild(
      { kind: "terminal", status: "completed", text: summary },
      async () =>
        this._agentTool.run<StubRunInput>(TestAgentToolStubChild, {
          runId,
          input: { chunkBodies: [] }
        })
    );
  }

  /** The persisted cause columns, read straight from the capability's table. */
  readPersistedRunRowForTest(runId: string): {
    status: string;
    summary: string | null;
    error: string | null;
    reason: string | null;
    childStillRunning: number | null;
  } | null {
    const rows = this.sql<{
      status: string;
      summary: string | null;
      error_message: string | null;
      interrupted_reason: string | null;
      child_still_running: number | null;
    }>`
      SELECT status, summary, error_message, interrupted_reason,
             child_still_running
      FROM cf_agent_tool_runs WHERE run_id = ${runId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      status: row.status,
      summary: row.summary,
      error: row.error_message,
      reason: row.interrupted_reason,
      childStillRunning: row.child_still_running
    };
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
    await this._agentTool.replayToConnection(connection);
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
    const rows = this.sql<{ detached_notify_source: string | null }>`
      SELECT detached_notify_source FROM cf_agent_tool_runs
      WHERE run_id = ${runId} LIMIT 1
    `;
    return rows[0]?.detached_notify_source ?? null;
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
   * backbone schedules. The fixed job id must collapse them to exactly one.
   */
  async armDetachedBackboneConcurrentlyForTest(
    count: number
  ): Promise<DetachedBackboneSchedule[]> {
    await Promise.all(
      Array.from({ length: count }, () =>
        this._agentTool.armDetachedBackbone({ resetCadence: true })
      )
    );
    return this.detachedBackboneSchedulesForTest();
  }

  async detachedReconcileTickForTest(cadenceIndex?: number): Promise<void> {
    await this._agentTool.reconcileTick(
      cadenceIndex !== undefined ? { cadenceIndex } : undefined
    );
  }

  /**
   * The pending backbone job projected into the shape the cadence assertions
   * use: how far out it is armed, and the cadence position it carries.
   */
  async detachedBackboneSchedulesForTest(): Promise<
    DetachedBackboneSchedule[]
  > {
    const pending = this._agentTool.pendingDetachedReconcile();
    if (!pending) return [];
    return [
      {
        delayInSeconds: Math.round((pending.dueAt - Date.now()) / 1000),
        payload: { cadenceIndex: pending.cadenceIndex }
      }
    ];
  }

  /**
   * Deliver a detached run's real terminal the way production does: a child that
   * now inspects terminal, collected by a backbone reconcile tick. No direct
   * call into the delivery funnel — the tick is the public operation, the
   * scripted child is the boundary.
   */
  async deliverFinishForTest(
    runId: string,
    status: Exclude<AgentToolTerminalStatus, "interrupted">,
    text: string
  ): Promise<void> {
    await this._withScriptedChild(
      { kind: "terminal", status, text },
      async () => {
        await this._agentTool.reconcileTick();
      }
    );
  }

  async deliverFinishCatchingForTest(
    runId: string,
    status: Exclude<AgentToolTerminalStatus, "interrupted">,
    text: string
  ): Promise<string | null> {
    try {
      await this.deliverFinishForTest(runId, status, text);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Drive a budget give-up: expire the seeded run's absolute ceiling, then let a
   * backbone tick observe a still-running child past its budget.
   */
  async deliverGiveUpForTest(runId: string): Promise<void> {
    this.sql`
      UPDATE cf_agent_tool_runs
      SET detached_max_budget_at = 1
      WHERE run_id = ${runId}
    `;
    await this._withScriptedChild({ kind: "running" }, async () => {
      await this._agentTool.reconcileTick();
    });
  }

  readRunStatusForTest(runId: string): string | null {
    return this.readPersistedRunRowForTest(runId)?.status ?? null;
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
        completed_at INTEGER
      )
    `;
  }

  async startAgentToolRun(
    input: StubRunInput,
    options: { runId: string }
  ): Promise<AgentToolRunInspection> {
    this._ensureTables();
    const startedAt = Date.now();
    const chunkBodies = input?.chunkBodies ?? [];
    chunkBodies.forEach((body, seq) => {
      this.sql`
        INSERT OR REPLACE INTO cf_test_stub_chunks (run_id, seq, body)
        VALUES (${options.runId}, ${seq}, ${body})
      `;
    });
    const completedAt = Date.now();
    const summary = input?.summary ?? null;
    this.sql`
      INSERT OR REPLACE INTO cf_test_stub_runs
        (run_id, status, summary, error, started_at, completed_at)
      VALUES
        (${options.runId}, 'completed', ${summary}, ${null}, ${startedAt}, ${completedAt})
    `;
    return {
      runId: options.runId,
      status: "completed",
      summary: input?.summary,
      startedAt,
      completedAt
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
    runId: string
  ): Promise<AgentToolRunInspection | null> {
    this._ensureTables();
    const rows = this.sql<{
      status: string;
      summary: string | null;
      error: string | null;
      started_at: number;
      completed_at: number | null;
    }>`
      SELECT status, summary, error, started_at, completed_at
      FROM cf_test_stub_runs WHERE run_id = ${runId}
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      runId,
      status: row.status as AgentToolRunInspection["status"],
      summary: row.summary ?? undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined
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
    const chunks = await this.getAgentToolChunks(runId, options);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (options?.signal?.aborted) {
          controller.close();
          return;
        }
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
        controller.close();
      }
    });
    return stream as unknown as ReadableStream<AgentToolStoredChunk>;
  }
}
