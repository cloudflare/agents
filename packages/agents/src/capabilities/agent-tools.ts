/**
 * Agent-tools capability (Layer 1). Owns the runtime queries against the
 * `cf_agent_tool_runs` table (the CREATE TABLE / migration DDL stays in
 * index.ts's `_ensureSchema`, which owns schema versioning for all tables).
 *
 * The `Agent` class delegates its `runAgentTool()`/`hasAgentToolRun()`/
 * `clearAgentToolRuns()` methods plus the recovery/replay internals here;
 * the capability talks to the agent only through the narrow
 * {@link AgentToolsHost} slice. Calls to *public or overridable* agent
 * members (`subAgent`, `deleteSubAgent`, `broadcast`,
 * `maxConcurrentAgentTools`, the `onAgentTool*` lifecycle hooks, the
 * `_onAgentToolStreamProgress` progress hook, and the test-patchable
 * `_broadcastAgentToolStoredChunksFromAdapter`) are re-dispatched through
 * the agent instance so subclass overrides keep working exactly as before.
 */

import { nanoid } from "nanoid";
import type { Connection } from "partyserver";
import type { SqlHost } from "../core/host";
import type {
  AgentToolChildAdapter,
  AgentToolDisplayMetadata,
  AgentToolEvent,
  AgentToolEventMessage,
  AgentToolInterruptedReason,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolRunStatus,
  AgentToolStoredChunk,
  ChatCapableAgentClass,
  RunAgentToolOptions,
  RunAgentToolResult
} from "../agent-tool-types";
import type { Agent, SubAgentClass } from "../index";

const DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS = 2_000;
const DEFAULT_AGENT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS = 5_000;
// Re-attaching to a still-running child agent-tool run (parent recovery /
// duplicate-runId re-issue) tails it to its REAL terminal result instead of
// abandoning it as `interrupted` and re-running already-completed child work
// (#1630). The budget is PROGRESS-KEYED, not a flat wall clock: it bounds how
// long the parent waits with NO forward progress from the child, and resets
// every time the child forwards a chunk. A child that keeps streaming toward
// terminal is therefore never abandoned mid-flight (the previous flat 120s
// budget abandoned healthy, still-advancing children); only a genuinely
// silent/hung child seals `interrupted` after a full no-progress window.
export const DEFAULT_AGENT_TOOL_REATTACH_NO_PROGRESS_TIMEOUT_MS = 120_000;
// Optional hard wall-clock ceiling on a single re-attach. Defaults to NO cap,
// mirroring chat-recovery's `maxRecoveryWork: Infinity` (#1672): the SDK does
// not impose an implicit wall-clock bound on a child that keeps making forward
// progress — a re-attached parent follows a healthy, still-streaming child for
// as long as it advances, exactly as it would on the live (never-evicted) path.
// A hung/silent child is already bounded by the progress-keyed no-progress
// budget above, and a content-runaway is bounded uniformly (live AND recovery)
// by the child's own `maxRecoveryWork` / `shouldKeepRecovering` — not by a
// parent-only timer that would fire only after an eviction. Integrators that
// want a hard wall-clock cap (and the `window-exceeded` child teardown it
// triggers) can still set `agentToolReattachMaxWindowMs` to a finite value.
export const DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS =
  Number.POSITIVE_INFINITY;

/** Raw `cf_agent_tool_runs` row shape. */
export type AgentToolRunStorageRow = {
  run_id: string;
  parent_tool_call_id: string | null;
  agent_type: string;
  input_preview: string | null;
  status: AgentToolRunStatus;
  summary: string | null;
  output_json: string | null;
  error_message: string | null;
  interrupted_reason: string | null;
  child_still_running: number | null;
  display_metadata: string | null;
  display_order: number;
  started_at: number;
  completed_at: number | null;
};

export type DeferredAgentToolFinish = () => Promise<void>;

type AgentToolRecoveryInspection =
  | {
      status: "inspected";
      adapter: AgentToolChildAdapter;
      inspection: AgentToolRunInspection | null;
    }
  | { status: "failed" }
  | { status: "timed-out" };

type AgentToolRecoveryEventType =
  | "agent_tool:recovery:reattach"
  | "agent_tool:recovery:begin"
  | "agent_tool:recovery:row"
  | "agent_tool:recovery:deadline"
  | "agent_tool:recovery:complete"
  | "agent_tool:recovery:failed";

/**
 * The agent surface the capability re-dispatches through so subclass
 * overrides (and instance-level test monkey-patches) are honored.
 */
interface AgentToolsAgentSurface {
  /** Public, user-overridable per instance/subclass. */
  maxConcurrentAgentTools: number;
  broadcast(msg: string): void;
  subAgent(cls: SubAgentClass, name: string): Promise<unknown>;
  deleteSubAgent(cls: SubAgentClass, name: string): Promise<void>;
  onAgentToolStart(run: AgentToolRunInfo): Promise<void>;
  onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void>;
  /** Protected hook overridden by Think / AIChatAgent. */
  _onAgentToolStreamProgress(): Promise<void>;
  /**
   * Delegator on the agent — dispatched through the instance so tests
   * that monkey-patch it (and any subclass override) intercept the
   * internal call sites too.
   */
  _broadcastAgentToolStoredChunksFromAdapter(
    adapter: AgentToolChildAdapter,
    row: Pick<AgentToolRunStorageRow, "run_id" | "parent_tool_call_id">,
    sequence: number,
    replay?: true,
    connection?: Connection,
    timeoutMs?: number
  ): Promise<number>;
}

/** The slice of the agent the agent-tools capability needs. */
export interface AgentToolsHost {
  /**
   * The agent instance — public methods and lifecycle hooks are
   * re-dispatched through it so subclass overrides are honored.
   */
  agent: object;
  sql: SqlHost["sql"];
  emit(
    type: AgentToolRecoveryEventType,
    payload: Record<string, unknown>
  ): void;
  /** `_resolvedOptions.agentToolReattachNoProgressTimeoutMs` on the agent. */
  reattachNoProgressTimeoutMs(): number;
  /** `_resolvedOptions.agentToolReattachMaxWindowMs` on the agent. */
  reattachMaxWindowMs(): number;
  /**
   * `_cf_resolveSubAgent` on the agent — shared facet resolution
   * (sub-agent territory, stays on the agent).
   */
  resolveSubAgent(className: string, name: string): Promise<unknown>;
  /**
   * `ctx.exports` widened to a name-keyed record (see `FacetCapableCtx`
   * in index.ts) — `undefined` when the runtime has no facet support.
   */
  ctxExports(): Record<string, unknown> | undefined;
  /** `ctx.waitUntil` — keeps background recovery alive. */
  waitUntil(promise: Promise<void>): void;
  onError(e: unknown): void | Promise<void>;
}

export class AgentTools {
  private readonly _host: AgentToolsHost;

  /** Single-flight background recovery for parent agent-tool rows. */
  private _agentToolRunRecoveryPromise: Promise<void> | undefined;

  constructor(host: AgentToolsHost) {
    this._host = host;
  }

  private get _agent(): AgentToolsAgentSurface {
    return this._host.agent as AgentToolsAgentSurface;
  }

  async runAgentTool<Input = unknown, Output = unknown>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input>
  ): Promise<RunAgentToolResult<Output>> {
    const runId = options.runId ?? nanoid(12);
    const agentType = cls.name;
    const existing = this._readAgentToolRun(runId);
    if (existing) {
      // HARD terminals (completed/error/aborted) are returned as-is. `interrupted`
      // is a SOFT terminal — recovery gave up once, but the child may have
      // reached its real terminal since — so it falls through to the re-attach
      // path below (which can repair the row), exactly like a non-terminal run.
      if (
        existing.status === "completed" ||
        existing.status === "error" ||
        existing.status === "aborted"
      ) {
        if (existing.status === "completed" && existing.output_json == null) {
          try {
            const child = await this._agent.subAgent(
              cls as SubAgentClass<Agent>,
              runId
            );
            const adapter = this._asAgentToolChildAdapter<Input, Output>(child);
            const inspection = await adapter.inspectAgentToolRun(runId);
            if (inspection?.status === "completed") {
              const result = this._terminalResultFromInspection<Output>(
                agentType,
                inspection
              );
              this._updateAgentToolTerminal(
                runId,
                result,
                inspection.completedAt
              );
              return result;
            }
          } catch {
            // Fall back to the retained parent row.
          }
        }
        return this._resultFromAgentToolRow<Output>(existing);
      }
      // Non-terminal or soft-terminal (`interrupted`) runId: the child may still
      // be in flight or may have reached terminal since we gave up (typically a
      // re-issue after parent recovery re-runs the same turn with a stable
      // runId — the documented "correct pattern"). Re-attach to the live child
      // and tail it to terminal instead of abandoning it as `interrupted` and
      // letting the model re-run already-completed child work (#1630). Falls
      // back to replay+interrupt when there is no tail adapter or the bounded
      // budget is exhausted.
      let reattachReason: AgentToolInterruptedReason | undefined;
      let childTornDown = false;
      try {
        const child = await this._agent.subAgent(
          cls as SubAgentClass<Agent>,
          runId
        );
        const adapter = this._asAgentToolChildAdapter<Input, Output>(child);
        const reattach = await this._reattachAgentToolRunToTerminal<Output>(
          adapter,
          existing,
          1,
          this._host.reattachNoProgressTimeoutMs(),
          this._host.reattachMaxWindowMs()
        );
        if (reattach.result) {
          await this._finishAgentToolRun(
            this._agentToolRunInfoFromRow(existing),
            reattach.result,
            { sequence: reattach.sequence, completedAt: reattach.completedAt }
          );
          return reattach.result;
        }
        reattachReason = reattach.reason;
        // The parent has genuinely given up re-attaching to this live child —
        // tear it down so it stops consuming a fiber / keep-alive (#1630).
        childTornDown = await this._teardownGivenUpAgentToolChild(
          adapter,
          runId,
          reattach.reason
        );
      } catch {
        // Fall through to the honest interrupted state below.
      }
      return await this._replayAndInterruptAgentToolRun<Output>(
        existing,
        this._interruptedMessageForReason(reattachReason),
        { reason: reattachReason, childStillRunning: !childTornDown }
      );
    }

    const displayOrder = options.displayOrder ?? 0;
    const inputPreview =
      options.inputPreview ?? this._defaultAgentToolPreview(options.input);
    const displayJson =
      options.display !== undefined ? JSON.stringify(options.display) : null;
    const inputPreviewJson =
      inputPreview !== undefined ? JSON.stringify(inputPreview) : null;
    const startedAt = Date.now();

    if (
      this._activeAgentToolRunCount() >= this._agent.maxConcurrentAgentTools
    ) {
      const error = `maxConcurrentAgentTools (${this._agent.maxConcurrentAgentTools}) exceeded`;
      this._host.sql`
        INSERT INTO cf_agent_tool_runs (
          run_id, parent_tool_call_id, agent_type, input_preview,
          input_redacted, status, error_message, display_metadata,
          display_order, started_at, completed_at
        ) VALUES (
          ${runId}, ${options.parentToolCallId ?? null}, ${agentType},
          ${inputPreviewJson}, 1, 'error', ${error}, ${displayJson},
          ${displayOrder}, ${startedAt}, ${Date.now()}
        )
      `;
      this._broadcastAgentToolEvent(options.parentToolCallId, 0, {
        kind: "started",
        runId,
        agentType,
        inputPreview,
        order: displayOrder,
        display: options.display
      });
      this._broadcastAgentToolEvent(options.parentToolCallId, 1, {
        kind: "error",
        runId,
        error
      });
      return { runId, agentType, status: "error", error };
    }

    this._host.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, input_preview,
        input_redacted, status, display_metadata, display_order, started_at
      ) VALUES (
        ${runId}, ${options.parentToolCallId ?? null}, ${agentType},
        ${inputPreviewJson}, 1, 'starting', ${displayJson}, ${displayOrder},
        ${startedAt}
      )
    `;

    const runInfo: AgentToolRunInfo = {
      runId,
      parentToolCallId: options.parentToolCallId,
      agentType,
      inputPreview,
      status: "starting",
      display: options.display,
      displayOrder,
      startedAt
    };
    await this._agent.onAgentToolStart(runInfo);
    this._broadcastAgentToolEvent(options.parentToolCallId, 0, {
      kind: "started",
      runId,
      agentType,
      inputPreview,
      order: displayOrder,
      display: options.display
    });

    const child = await this._agent.subAgent(
      cls as SubAgentClass<Agent>,
      runId
    );
    const adapter = this._asAgentToolChildAdapter<Input, Output>(child);
    const childStart = await adapter.startAgentToolRun(options.input, {
      runId
    });
    this._markAgentToolRunning(runId);
    let sequence = 1;
    let parentAbortListener: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        await adapter.cancelAgentToolRun(runId, options.signal.reason);
        const reason =
          options.signal.reason instanceof Error
            ? options.signal.reason.message
            : String(options.signal.reason ?? "cancelled");
        const result: RunAgentToolResult<Output> = {
          runId,
          agentType,
          status: "aborted",
          error: reason
        };
        await this._finishAgentToolRun(runInfo, result, { sequence });
        return result;
      } else {
        parentAbortListener = () => {
          void adapter.cancelAgentToolRun(runId, options.signal?.reason);
        };
        options.signal.addEventListener("abort", parentAbortListener, {
          once: true
        });
      }
    }

    try {
      if (adapter.tailAgentToolRun) {
        const stream = await adapter.tailAgentToolRun(runId, {
          afterSequence: -1
        });
        sequence = (
          await this._forwardAgentToolStream(
            stream,
            options.parentToolCallId,
            runId,
            sequence,
            options.signal
          )
        ).next;
      } else {
        const chunks = await adapter.getAgentToolChunks(runId);
        sequence = this._broadcastAgentToolChunks(
          options.parentToolCallId,
          runId,
          chunks,
          sequence
        );
      }

      if (options.signal?.aborted) {
        await adapter.cancelAgentToolRun(runId, options.signal.reason);
        const reason =
          options.signal.reason instanceof Error
            ? options.signal.reason.message
            : String(options.signal.reason ?? "cancelled");
        const result: RunAgentToolResult<Output> = {
          runId,
          agentType,
          status: "aborted",
          error: reason
        };
        await this._finishAgentToolRun(runInfo, result, { sequence });
        return result;
      }

      const inspection =
        (await adapter.inspectAgentToolRun(runId)) ?? childStart;
      const result = this._terminalResultFromInspection<Output>(
        agentType,
        inspection
      );
      await this._finishAgentToolRun(runInfo, result, {
        sequence,
        completedAt: inspection.completedAt
      });
      return result;
    } catch (error) {
      if (options.signal?.aborted) {
        await adapter.cancelAgentToolRun(runId, options.signal.reason);
        const reason =
          options.signal.reason instanceof Error
            ? options.signal.reason.message
            : String(options.signal.reason ?? "cancelled");
        const result: RunAgentToolResult<Output> = {
          runId,
          agentType,
          status: "aborted",
          error: reason
        };
        await this._finishAgentToolRun(runInfo, result, { sequence });
        return result;
      }
      const message = error instanceof Error ? error.message : String(error);
      const result: RunAgentToolResult<Output> = {
        runId,
        agentType,
        status: "error",
        error: message
      };
      await this._finishAgentToolRun(runInfo, result, { sequence });
      return result;
    } finally {
      if (parentAbortListener && options.signal) {
        options.signal.removeEventListener("abort", parentAbortListener);
      }
    }
  }

  hasAgentToolRun(classOrName: SubAgentClass | string, runId: string): boolean {
    const agentType =
      typeof classOrName === "string" ? classOrName : classOrName.name;
    const rows = this._host.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE run_id = ${runId} AND agent_type = ${agentType}
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  async clearAgentToolRuns(options?: {
    olderThan?: number;
    status?: AgentToolRunStatus[];
  }): Promise<void> {
    const rows = this._host.sql<{
      run_id: string;
      agent_type: string;
      status: string;
    }>`
      SELECT run_id, agent_type, status FROM cf_agent_tool_runs
      ORDER BY started_at ASC
    `;
    const statusFilter = options?.status
      ? new Set<string>(options.status)
      : null;
    const retained = rows.filter((row) => {
      if (statusFilter && !statusFilter.has(row.status)) return false;
      if (options?.olderThan !== undefined) {
        const full = this._readAgentToolRun(row.run_id);
        if (!full || full.started_at >= options.olderThan) return false;
      }
      return true;
    });

    for (const row of retained) {
      try {
        const cls = this._agentToolClassByName(row.agent_type);
        if (row.status === "starting" || row.status === "running") {
          const child = await this._agent.subAgent(cls, row.run_id);
          const adapter = this._asAgentToolChildAdapter(child);
          await adapter.cancelAgentToolRun(
            row.run_id,
            "clearing agent tool run"
          );
        }
        await this._agent.deleteSubAgent(cls, row.run_id);
      } catch {
        // Cleanup is intentionally idempotent.
      }
      this._host.sql`
        DELETE FROM cf_agent_tool_runs WHERE run_id = ${row.run_id}
      `;
    }
  }

  private _isAgentToolTerminal(status: string): boolean {
    return (
      status === "completed" ||
      status === "error" ||
      status === "aborted" ||
      status === "interrupted"
    );
  }

  private _activeAgentToolRunCount(): number {
    const rows = this._host.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE status IN ('starting', 'running')
    `;
    return rows[0]?.n ?? 0;
  }

  private _defaultAgentToolPreview(input: unknown): unknown {
    if (typeof input === "string") return input.slice(0, 500);
    if (input === null || input === undefined) return input;
    try {
      const json = JSON.stringify(input);
      return json.length > 500 ? `${json.slice(0, 497)}...` : json;
    } catch {
      return String(input).slice(0, 500);
    }
  }

  _readAgentToolRun(runId: string): AgentToolRunStorageRow | null {
    const rows = this._host.sql<AgentToolRunStorageRow>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, interrupted_reason,
             child_still_running, display_metadata, display_order,
             started_at, completed_at
      FROM cf_agent_tool_runs
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /**
   * Reconstruct the typed interrupted cause (`reason` / `childStillRunning`,
   * #1630 follow-up) from a stored row so a row→result/event rebuild — e.g. a
   * reconnect replay — carries the same fields a live client saw. Only
   * `interrupted` rows store a cause; everything else yields `{}` (the columns
   * are cleared whenever a row settles to a hard terminal).
   */
  private _agentToolInterruptedExtrasFromRow(row: {
    status: AgentToolRunStatus;
    interrupted_reason: string | null;
    child_still_running: number | null;
  }): { reason?: AgentToolInterruptedReason; childStillRunning?: boolean } {
    if (row.status !== "interrupted") return {};
    return {
      ...(row.interrupted_reason !== null
        ? { reason: row.interrupted_reason as AgentToolInterruptedReason }
        : {}),
      ...(row.child_still_running !== null
        ? { childStillRunning: row.child_still_running !== 0 }
        : {})
    };
  }

  _resultFromAgentToolRow<Output>(
    row: AgentToolRunStorageRow
  ): RunAgentToolResult<Output> {
    const output = this._parseAgentToolJson(row.output_json) as
      | Output
      | undefined;
    return {
      runId: row.run_id,
      agentType: row.agent_type,
      status: row.status as RunAgentToolResult<Output>["status"],
      ...(output !== undefined ? { output } : {}),
      ...(row.summary !== null ? { summary: row.summary } : {}),
      ...(row.error_message !== null ? { error: row.error_message } : {}),
      ...this._agentToolInterruptedExtrasFromRow(row)
    };
  }

  private _agentToolRunInfoFromRow(
    row: AgentToolRunStorageRow,
    status: AgentToolRunStatus = row.status,
    completedAt = row.completed_at ?? undefined
  ): AgentToolRunInfo {
    return {
      runId: row.run_id,
      parentToolCallId: row.parent_tool_call_id ?? undefined,
      agentType: row.agent_type,
      inputPreview: this._parseAgentToolJson(row.input_preview),
      status,
      display: this._parseAgentToolJson(row.display_metadata) as
        | AgentToolDisplayMetadata
        | undefined,
      displayOrder: row.display_order,
      startedAt: row.started_at,
      completedAt
    };
  }

  private _terminalResultFromInspection<Output>(
    agentType: string,
    inspection: AgentToolRunInspection<Output>
  ): RunAgentToolResult<Output> {
    if (inspection.status === "completed") {
      return {
        runId: inspection.runId,
        agentType,
        status: "completed",
        output: inspection.output,
        summary: inspection.summary
      };
    }
    if (inspection.status === "aborted") {
      return {
        runId: inspection.runId,
        agentType,
        status: "aborted",
        error: inspection.error
      };
    }
    return {
      runId: inspection.runId,
      agentType,
      status: "error",
      error: inspection.error ?? "Agent tool run failed"
    };
  }

  private async _finishAgentToolRun<Output>(
    run: AgentToolRunInfo,
    result: RunAgentToolResult<Output>,
    options?: {
      sequence?: number;
      completedAt?: number;
      deferFinishHook?: boolean;
    }
  ): Promise<DeferredAgentToolFinish | undefined> {
    const completedAt = options?.completedAt ?? Date.now();
    this._updateAgentToolTerminal(run.runId, result, completedAt);
    if (options?.sequence !== undefined) {
      this._broadcastAgentToolTerminal(
        run.parentToolCallId,
        options.sequence,
        result
      );
    }
    const finish = () =>
      this._agent.onAgentToolFinish(
        { ...run, status: result.status, completedAt },
        result
      );
    if (options?.deferFinishHook) return finish;
    await finish();
    return undefined;
  }

  async _runDeferredAgentToolFinishHooks(
    hooks: DeferredAgentToolFinish[]
  ): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        try {
          await this._host.onError(error);
        } catch {
          // Recovery hooks are best-effort; one failed mirror write should not
          // prevent the agent from starting or other recovered runs finalizing.
        }
      }
    }
  }

  _updateAgentToolTerminal<Output>(
    runId: string,
    result: RunAgentToolResult<Output>,
    completedAt = Date.now()
  ): void {
    // `interrupted` is a SOFT terminal — recovery gave up collecting, but the
    // child (a durable facet) may still reach its real terminal. So it is NOT
    // in the guard below: a later child completion (via a re-issue's re-attach,
    // #1630) can repair an `interrupted` row to `completed`/`error`. The three
    // HARD terminals are never overwritten.
    // Persist the typed interrupted cause (#1630 follow-up) so a reconnect
    // replay reconstructs the same `reason` / `childStillRunning` a live client
    // saw. Written unconditionally so repairing an `interrupted` row to a hard
    // terminal (e.g. a re-attach that finally collects `completed`) CLEARS the
    // stale cause rather than leaving it dangling.
    const childStillRunning =
      result.childStillRunning === undefined
        ? null
        : result.childStillRunning
          ? 1
          : 0;
    this._host.sql`
      UPDATE cf_agent_tool_runs
      SET status = ${result.status},
          summary = ${result.summary ?? null},
          output_json = ${this._stringifyAgentToolOutput(result.output)},
          error_message = ${result.error ?? null},
          interrupted_reason = ${result.reason ?? null},
          child_still_running = ${childStillRunning},
          completed_at = ${completedAt}
      WHERE run_id = ${runId}
        AND status NOT IN ('completed', 'error', 'aborted')
    `;
    if (result.status === "completed" && result.output !== undefined) {
      this._host.sql`
        UPDATE cf_agent_tool_runs
        SET output_json = COALESCE(output_json, ${this._stringifyAgentToolOutput(result.output)}),
            summary = COALESCE(summary, ${result.summary ?? null})
        WHERE run_id = ${runId} AND status = 'completed'
      `;
    }
  }

  private _markAgentToolRunning(runId: string): void {
    this._host.sql`
      UPDATE cf_agent_tool_runs
      SET status = 'running'
      WHERE run_id = ${runId} AND status = 'starting'
    `;
  }

  private _parseAgentToolJson(value: string | null): unknown {
    if (value === null) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private _stringifyAgentToolOutput(output: unknown): string | null {
    if (output === undefined) return null;
    const json = JSON.stringify(output);
    return json === undefined ? null : json;
  }

  private _broadcastAgentToolEvent(
    parentToolCallId: string | undefined,
    sequence: number,
    event: AgentToolEvent,
    replay?: true,
    connection?: Connection
  ): void {
    const message: AgentToolEventMessage = {
      type: "agent-tool-event",
      parentToolCallId,
      sequence,
      event,
      ...(replay ? { replay } : {})
    };
    const body = JSON.stringify(message);
    if (connection) {
      connection.send(body);
    } else {
      this._agent.broadcast(body);
    }
  }

  private _broadcastAgentToolChunks(
    parentToolCallId: string | undefined,
    runId: string,
    chunks: AgentToolStoredChunk[],
    sequence: number,
    replay?: true,
    connection?: Connection
  ): number {
    let next = sequence;
    for (const chunk of chunks) {
      this._broadcastAgentToolEvent(
        parentToolCallId,
        next++,
        { kind: "chunk", runId, body: chunk.body },
        replay,
        connection
      );
    }
    return next;
  }

  private async _broadcastAgentToolStoredChunks(
    row: Pick<
      AgentToolRunStorageRow,
      "run_id" | "agent_type" | "parent_tool_call_id"
    >,
    sequence: number,
    replay?: true,
    connection?: Connection
  ): Promise<number> {
    const child = await this._host.resolveSubAgent(row.agent_type, row.run_id);
    const adapter = this._asAgentToolChildAdapter(child);
    return this._agent._broadcastAgentToolStoredChunksFromAdapter(
      adapter,
      row,
      sequence,
      replay,
      connection
    );
  }

  async _broadcastAgentToolStoredChunksFromAdapter(
    adapter: AgentToolChildAdapter,
    row: Pick<AgentToolRunStorageRow, "run_id" | "parent_tool_call_id">,
    sequence: number,
    replay?: true,
    connection?: Connection,
    timeoutMs?: number
  ): Promise<number> {
    const chunks = await this._getAgentToolChunksForRecovery(
      adapter,
      row.run_id,
      timeoutMs
    );
    if (!chunks) return sequence;
    return this._broadcastAgentToolChunks(
      row.parent_tool_call_id ?? undefined,
      row.run_id,
      chunks,
      sequence,
      replay,
      connection
    );
  }

  async _forwardAgentToolStream(
    stream: ReadableStream<AgentToolStoredChunk>,
    parentToolCallId: string | undefined,
    runId: string,
    sequence: number,
    signal?: AbortSignal,
    idleTimeoutMs?: number
  ): Promise<{ next: number; ended: "done" | "idle" | "aborted" }> {
    let next = sequence;
    if (signal?.aborted) return { next, ended: "aborted" };
    // How the forward loop ended, so the re-attach caller can re-arm ONLY on a
    // clean stream-close (`done`) and never abandon a fresh reader per idle
    // cycle: `idle` = a full no-progress window elapsed (stalled), `aborted` =
    // the caller's ceiling signal fired.
    let ended: "done" | "idle" | "aborted" = "done";
    const reader = (
      stream as ReadableStream<AgentToolStoredChunk | Uint8Array>
    ).getReader();
    const decoder = new TextDecoder();
    let bufferedBytes = "";
    let aborted = false;
    let resolveAbort: (() => void) | undefined;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    let abortListener: (() => void) | undefined;
    if (signal) {
      abortListener = () => resolveAbort?.();
      signal.addEventListener("abort", abortListener, { once: true });
    }
    // Optional no-progress (idle) budget: a re-attach passes this so a child
    // that keeps forwarding chunks is never cut off mid-flight. The timer is
    // (re-)armed on every forwarded chunk and only fires after a full window of
    // silence. When `idleTimeoutMs` is undefined (the live run path) OR
    // non-finite (`Infinity` = "never seal on no-progress") the idle promise
    // never resolves, so the forward loop ends only on a clean stream-close or
    // the caller's ceiling signal — never on silence.
    const idleEnabled =
      typeof idleTimeoutMs === "number" &&
      idleTimeoutMs > 0 &&
      Number.isFinite(idleTimeoutMs);
    let resolveIdle: (() => void) | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const idlePromise = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    const armIdle = () => {
      if (!idleEnabled) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => resolveIdle?.(), idleTimeoutMs);
    };
    // N9: track whether any chunk was forwarded since the last progress hook so
    // a parent that is merely orchestrating a child still records forward
    // progress for its OWN recovery budget — but ONLY when the child actually
    // produces output (a silent/hung child forwards nothing → no credit → the
    // parent still exhausts on its own no-progress timer).
    let forwardedSinceProgress = false;
    try {
      const forwardChunk = (chunk: AgentToolStoredChunk) => {
        this._broadcastAgentToolEvent(parentToolCallId, next++, {
          kind: "chunk",
          runId,
          body: chunk.body
        });
        forwardedSinceProgress = true;
        // Forward progress resets the no-progress budget.
        armIdle();
      };
      const forwardLine = (line: string) => {
        try {
          const chunk = JSON.parse(line) as Partial<AgentToolStoredChunk>;
          if (typeof chunk.body === "string") {
            forwardChunk(chunk as AgentToolStoredChunk);
          }
        } catch {
          // Skip malformed stream frames; the child remains authoritative for
          // final run status and durable chunk replay.
        }
      };
      const flushBufferedBytes = (final = false) => {
        while (true) {
          const newline = bufferedBytes.indexOf("\n");
          if (newline === -1) break;
          const line = bufferedBytes.slice(0, newline).trim();
          bufferedBytes = bufferedBytes.slice(newline + 1);
          if (line.length > 0) {
            forwardLine(line);
          }
        }
        if (final && bufferedBytes.trim().length > 0) {
          forwardLine(bufferedBytes);
          bufferedBytes = "";
        }
      };
      // Arm the idle budget up front so a child that never emits anything still
      // ends the wait after one no-progress window.
      armIdle();
      while (true) {
        // Pre-attach a catch so that if the abort wins the race below, a later
        // rejection of this read (e.g. the child closing / DO RPC surfacing
        // "Stream was cancelled") never bubbles up as an unhandled rejection.
        const readPromise = reader.read();
        readPromise.catch(() => {});
        const raced = await Promise.race([
          readPromise.then((result) => ({ kind: "read" as const, result })),
          abortPromise.then(() => ({ kind: "abort" as const })),
          idlePromise.then(() => ({ kind: "idle" as const }))
        ]);
        if (raced.kind === "abort" || raced.kind === "idle") {
          // Both leave the pending read in place — we never cancel a live child
          // facet stream (see the note below). The caller distinguishes a
          // no-progress stall from terminal via a follow-up inspect.
          aborted = true;
          ended = raced.kind === "idle" ? "idle" : "aborted";
          break;
        }
        const { done, value } = raced.result;
        if (done) {
          bufferedBytes += decoder.decode();
          flushBufferedBytes(true);
          break;
        }
        if (value instanceof Uint8Array) {
          bufferedBytes += decoder.decode(value, { stream: true });
          flushBufferedBytes();
        } else {
          forwardChunk(value);
        }
        if (forwardedSinceProgress) {
          forwardedSinceProgress = false;
          // Credit the parent's recovery progress for forwarding child output
          // (no-op in the base Agent; chat-recovery subclasses override). Kept
          // off the hot per-chunk path — runs once per read iteration and is
          // throttled inside the override. Best-effort: progress crediting is
          // advisory, so a bump failure must never break the child stream the
          // user is watching.
          try {
            await this._agent._onAgentToolStreamProgress();
          } catch {
            // Ignore and keep forwarding; the next iteration tries again.
          }
        }
      }
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }
      if (!aborted) {
        try {
          reader.releaseLock();
        } catch {
          // A concurrently-cancelled reader can't release; safe to ignore.
        }
      }
      // When `aborted` (re-attach budget expired with a read still pending) we
      // deliberately do NOT cancel the reader: cancelling a remote child-facet
      // RPC stream surfaces a "Stream was cancelled" rejection from the RPC pump
      // that can't be reliably swallowed (verified). Instead we abandon the
      // pre-caught read — it resolves harmlessly when the child reaches terminal
      // and the adapter's tail fires its registered closer, releasing the reader
      // + stream. That makes the hold BOUNDED by the child's own recovery
      // (its turn is sealed within the chat-recovery ceiling), never unbounded.
      // The re-attach loop re-arms only on `ended === "done"`, so at most ONE
      // such read is ever left pending per re-attach (no per-cycle leak).
    }
    return { next, ended };
  }

  private _broadcastAgentToolTerminal<Output>(
    parentToolCallId: string | undefined,
    sequence: number,
    result: RunAgentToolResult<Output>,
    replay?: true,
    connection?: Connection
  ): void {
    if (result.status === "completed") {
      this._broadcastAgentToolEvent(
        parentToolCallId,
        sequence,
        {
          kind: "finished",
          runId: result.runId,
          summary: result.summary ?? ""
        },
        replay,
        connection
      );
    } else if (result.status === "aborted") {
      this._broadcastAgentToolEvent(
        parentToolCallId,
        sequence,
        { kind: "aborted", runId: result.runId, reason: result.error },
        replay,
        connection
      );
    } else if (result.status === "interrupted") {
      this._broadcastAgentToolEvent(
        parentToolCallId,
        sequence,
        {
          kind: "interrupted",
          runId: result.runId,
          error: result.error ?? "Agent tool run was interrupted",
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
          ...(result.childStillRunning !== undefined
            ? { childStillRunning: result.childStillRunning }
            : {})
        },
        replay,
        connection
      );
    } else {
      this._broadcastAgentToolEvent(
        parentToolCallId,
        sequence,
        {
          kind: "error",
          runId: result.runId,
          error: result.error ?? "Agent tool run failed"
        },
        replay,
        connection
      );
    }
  }

  private _asAgentToolChildAdapter<Input = unknown, Output = unknown>(
    child: unknown
  ): AgentToolChildAdapter<Input, Output> {
    const candidate = child as Partial<AgentToolChildAdapter<Input, Output>>;
    if (
      typeof candidate.startAgentToolRun !== "function" ||
      typeof candidate.cancelAgentToolRun !== "function" ||
      typeof candidate.inspectAgentToolRun !== "function" ||
      typeof candidate.getAgentToolChunks !== "function"
    ) {
      throw new Error(
        "Agent tool child must implement the framework agent-tool adapter. Use a @cloudflare/think Think subclass or an AIChatAgent subclass."
      );
    }
    return candidate as AgentToolChildAdapter<Input, Output>;
  }

  private _agentToolClassByName(className: string): SubAgentClass<Agent> {
    const cls = this._host.ctxExports()?.[className];
    if (!cls) {
      throw new Error(`Agent tool class "${className}" is not exported.`);
    }
    return cls as unknown as SubAgentClass<Agent>;
  }

  private async _replayAndInterruptAgentToolRun<Output>(
    row: AgentToolRunStorageRow,
    message: string,
    extra?: { reason?: AgentToolInterruptedReason; childStillRunning?: boolean }
  ): Promise<RunAgentToolResult<Output>> {
    let sequence = 1;
    try {
      sequence = await this._broadcastAgentToolStoredChunks(row, sequence);
    } catch {
      // Interruption is still the honest parent state if replay fails.
    }
    const result: RunAgentToolResult<Output> = {
      runId: row.run_id,
      agentType: row.agent_type,
      status: "interrupted",
      error: message,
      ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra?.childStillRunning !== undefined
        ? { childStillRunning: extra.childStillRunning }
        : {})
    };
    await this._finishAgentToolRun(this._agentToolRunInfoFromRow(row), result, {
      sequence
    });
    return result;
  }

  /**
   * Human-readable prose for an `interrupted` seal. Kept in sync with
   * {@link AgentToolInterruptedReason}; callers branch on the typed `reason`
   * field, not this string.
   */
  private _interruptedMessageForReason(
    reason: AgentToolInterruptedReason | undefined
  ): string {
    switch (reason) {
      case "no-progress":
        return "Agent tool run was still running but made no forward progress within the re-attach no-progress budget; the parent gave up.";
      case "window-exceeded":
        return "Agent tool run did not reach a terminal result within the maximum re-attach window; the parent gave up.";
      case "not-tailable":
        return "Agent tool run was still running, but live-tail reattachment is not supported in this runtime.";
      case "inspect-timeout":
        return "Agent tool run inspection timed out during parent recovery.";
      case "inspect-failed":
        return "Agent tool run could not be inspected during parent recovery.";
      case "recovery-deadline":
        return "Agent tool run recovery deadline exceeded.";
      default:
        return "Agent tool run was still running and did not reach a terminal result.";
    }
  }

  /**
   * Tear down a child agent-tool run the parent has genuinely given up on
   * (#1630 follow-up). Teardown is scoped to `window-exceeded` ONLY — the hard
   * ceiling, where the child has had its full recovery window and is therefore
   * truly exhausted, so cancelling it reclaims its fiber / keep-alive. Every
   * other give-up is deliberately left repairable: `no-progress` seals stay
   * SOFT (`interrupted`, `childStillRunning: true`) so a re-issue can still
   * re-attach and collect the child if it self-heals — tearing those down would
   * defeat the repair-on-re-issue path and convert a retryable interrupt into a
   * non-retryable `aborted`. Reasons where the child's state is unknown
   * (`inspect-*`, `recovery-deadline`, `not-tailable`) are also left alone.
   * Returns whether the child was torn down (so the caller reports
   * `childStillRunning: false`).
   */
  private async _teardownGivenUpAgentToolChild(
    adapter: AgentToolChildAdapter,
    runId: string,
    reason: AgentToolInterruptedReason | undefined
  ): Promise<boolean> {
    if (reason !== "window-exceeded") return false;
    try {
      await adapter.cancelAgentToolRun(
        runId,
        `agent tool run given up by parent recovery: ${reason}`
      );
      return true;
    } catch {
      // Best-effort: a failed teardown just means the child may still be alive.
      return false;
    }
  }

  /**
   * Re-attach to a still-running child agent-tool run and tail it to its real
   * terminal result, instead of abandoning it as `interrupted` (#1630). The
   * child is a separate facet with its own `chatRecovery`, so resolving it via
   * the adapter wakes it and lets it self-complete the interrupted turn; we tail
   * its live stream (forwarding chunks to the parent's connections) until it
   * reaches terminal, then inspect for the collected result.
   *
   * The wait is PROGRESS-KEYED, not a flat wall clock (which previously abandoned
   * healthy, still-advancing children whose recovery simply outran a fixed
   * budget). `noProgressTimeoutMs` bounds how long the parent waits with NO
   * forward progress; it is reset on every forwarded chunk. As long as the child
   * keeps streaming it is followed through to terminal. The loop also RE-ARMS
   * across stream-closes (a child re-evicted mid-recovery, or a tail that ends
   * before terminal) as long as the prior attempt made progress, so a child that
   * dies and recovers again during deploy churn is still collected. A genuinely
   * silent/hung child can never block recovery forever: it seals `interrupted`
   * after one `noProgressTimeoutMs` window. `maxWindowMs` is an OPTIONAL hard
   * wall-clock ceiling (default `Infinity` — uncapped, mirroring #1672's
   * `maxRecoveryWork`); set it finite to also bound a child that keeps
   * progressing, which seals `window-exceeded` and tears the child down.
   *
   * Returns the terminal `result` (and `completedAt`) when the child reaches a
   * terminal status, plus the advanced broadcast `sequence`. Returns
   * `{ result: undefined }` when there is no `tailAgentToolRun` adapter, the
   * child makes no progress within a full no-progress window, or the ceiling is
   * reached while the child is still non-terminal — the caller then seals
   * `interrupted`.
   */
  async _reattachAgentToolRunToTerminal<Output>(
    adapter: AgentToolChildAdapter<unknown, Output>,
    row: Pick<
      AgentToolRunStorageRow,
      "run_id" | "agent_type" | "parent_tool_call_id"
    >,
    sequence: number,
    noProgressTimeoutMs: number = DEFAULT_AGENT_TOOL_REATTACH_NO_PROGRESS_TIMEOUT_MS,
    maxWindowMs: number = DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS
  ): Promise<{
    sequence: number;
    result?: RunAgentToolResult<Output>;
    completedAt?: number;
    reason?: AgentToolInterruptedReason;
  }> {
    if (typeof adapter.tailAgentToolRun !== "function") {
      // Defensive: a real (RPC) child stub reports every method as a `function`,
      // so this only fires for an in-process adapter that genuinely omits the
      // method. A real child that can't tail surfaces as a tail-call failure
      // below (caught → `no-progress`), not here.
      return { sequence, reason: "not-tailable" };
    }

    this._host.emit("agent_tool:recovery:reattach", {
      runId: row.run_id,
      agentType: row.agent_type,
      budgetMs: noProgressTimeoutMs
    });

    const collectTerminal = async (
      seq: number
    ): Promise<{
      sequence: number;
      result: RunAgentToolResult<Output>;
      completedAt?: number;
    } | null> => {
      let inspection: AgentToolRunInspection<Output> | null = null;
      try {
        inspection = await adapter.inspectAgentToolRun(row.run_id);
      } catch {
        // Treat an un-inspectable child as still non-terminal.
        return null;
      }
      if (
        inspection &&
        inspection.status !== "running" &&
        inspection.status !== "starting"
      ) {
        return {
          sequence: seq,
          result: this._terminalResultFromInspection<Output>(
            row.agent_type,
            inspection
          ),
          completedAt: inspection.completedAt
        };
      }
      return null;
    };

    let nextSequence = sequence;

    // A non-positive no-progress budget means "do not wait" — only collect an
    // already-terminal child without tailing. A non-finite (`Infinity`) budget
    // is the OPPOSITE — "never seal on no-progress": it falls through to the
    // tail loop below, where a non-finite budget disables the idle timer so a
    // silent-but-alive child is followed until its stream closes (or the hard
    // ceiling fires), matching the `maxWindowMs` "Infinity = off" convention.
    if (!(noProgressTimeoutMs > 0)) {
      return (
        (await collectTerminal(nextSequence)) ?? {
          sequence: nextSequence,
          reason: "no-progress"
        }
      );
    }

    // Optional hard wall-clock ceiling (default Infinity = off). A hung child is
    // already bounded by the no-progress budget; this only additionally bounds a
    // child that keeps progressing, when an integrator opts into a finite cap.
    const ceilingController = new AbortController();
    let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
    if (maxWindowMs > 0 && Number.isFinite(maxWindowMs)) {
      ceilingTimer = setTimeout(() => ceilingController.abort(), maxWindowMs);
    }

    // Defaults to the no-progress cause; promoted to `window-exceeded` if the
    // hard ceiling is what ends the wait.
    let reason: AgentToolInterruptedReason = "no-progress";
    try {
      // Re-arm loop: keep tailing as long as the child makes forward progress.
      // Each attempt forwards live chunks until the child reaches terminal (its
      // stream closes), goes silent for a full no-progress window, or the ceiling
      // fires. Only a full no-progress window with no terminal seals
      // `interrupted`; a still-streaming or re-evicted-but-advancing child is
      // followed through.
      while (!ceilingController.signal.aborted) {
        // Tail from the child's CURRENT last chunk, not from -1: stored chunks
        // are already delivered to connected clients via `_replayAgentToolRuns`
        // on reconnect, so replaying them here would duplicate parts (the client
        // reducer appends by arrival order). Forwarding only chunks produced
        // after this point keeps the live stream correct without dupes.
        let afterSequence = -1;
        try {
          const existing = await adapter.getAgentToolChunks(row.run_id);
          const last = existing[existing.length - 1];
          if (last) afterSequence = last.sequence;
        } catch {
          // Fall back to a full tail if the chunk probe fails.
        }

        const beforeSequence = nextSequence;
        // Defaults to a non-`done` end so a tail that throws below does NOT
        // re-arm (we only re-arm on a verified clean stream-close).
        let streamEnded: "done" | "idle" | "aborted" = "idle";
        try {
          // NOTE: the ceiling signal is NOT forwarded to `tailAgentToolRun` — an
          // AbortSignal can't be serialized across the child-facet DO RPC. We
          // bound the wait parent-side: the ceiling/no-progress budget ends our
          // local forward loop and releases the read view, but never cancels the
          // child (it must keep advancing toward its own terminal so this — or a
          // later — inspect can still collect it).
          const stream = await adapter.tailAgentToolRun(row.run_id, {
            afterSequence
          });
          // Resolves when the child reaches terminal (the adapter closes the
          // tail), goes silent for a full no-progress window, or the ceiling
          // aborts our controller.
          const forwarded = await this._forwardAgentToolStream(
            stream,
            row.parent_tool_call_id ?? undefined,
            row.run_id,
            nextSequence,
            ceilingController.signal,
            noProgressTimeoutMs
          );
          nextSequence = forwarded.next;
          streamEnded = forwarded.ended;
        } catch {
          // Tail failures fall through to an inspect; the child remains
          // authoritative for terminal status and durable chunk replay.
        }

        const terminal = await collectTerminal(nextSequence);
        if (terminal) return terminal;

        if (ceilingController.signal.aborted) {
          reason = "window-exceeded";
          break;
        }

        // Re-arm ONLY when the child's stream closed cleanly (`done`) AND it
        // made forward progress this attempt — i.e. a re-evicted-but-advancing
        // child that closed before terminal. An `idle` end means a full
        // no-progress window elapsed (genuinely stalled) ⇒ seal `no-progress`
        // now; re-arming there would both mis-read a stall as recoverable and
        // abandon a fresh pending reader every cycle. No progress likewise
        // seals.
        if (streamEnded !== "done") break;
        if (nextSequence <= beforeSequence) break;
      }
    } finally {
      if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
    }

    return { sequence: nextSequence, reason };
  }

  async _replayAgentToolRuns(connection: Connection): Promise<void> {
    const rows = this._host.sql<{
      run_id: string;
      parent_tool_call_id: string | null;
      agent_type: string;
      input_preview: string | null;
      status: AgentToolRunStatus;
      summary: string | null;
      output_json: string | null;
      error_message: string | null;
      interrupted_reason: string | null;
      child_still_running: number | null;
      display_metadata: string | null;
      display_order: number;
    }>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, interrupted_reason,
             child_still_running, display_metadata, display_order
      FROM cf_agent_tool_runs
      ORDER BY started_at ASC
    `;

    for (const row of rows) {
      const parentToolCallId = row.parent_tool_call_id ?? undefined;
      let sequence = 0;
      this._broadcastAgentToolEvent(
        parentToolCallId,
        sequence++,
        {
          kind: "started",
          runId: row.run_id,
          agentType: row.agent_type,
          inputPreview: this._parseAgentToolJson(row.input_preview),
          order: row.display_order,
          display: this._parseAgentToolJson(row.display_metadata) as
            | AgentToolDisplayMetadata
            | undefined
        },
        true,
        connection
      );

      try {
        sequence = await this._broadcastAgentToolStoredChunks(
          row,
          sequence,
          true,
          connection
        );
      } catch {
        // Keep replay best-effort per run.
      }

      if (this._isAgentToolTerminal(row.status)) {
        this._broadcastAgentToolTerminal(
          parentToolCallId,
          sequence,
          {
            runId: row.run_id,
            agentType: row.agent_type,
            status: row.status as RunAgentToolResult["status"],
            output: this._parseAgentToolJson(row.output_json),
            summary: row.summary ?? undefined,
            error: row.error_message ?? undefined,
            ...this._agentToolInterruptedExtrasFromRow(row)
          },
          true,
          connection
        );
      }
    }
  }

  async _reconcileAgentToolRuns(options?: {
    deferFinishHooks?: boolean;
    childInspectionTimeoutMs?: number;
    totalRecoveryTimeoutMs?: number;
    reattachTimeoutMs?: number;
    reattachMaxWindowMs?: number;
    runIds?: readonly string[];
  }): Promise<DeferredAgentToolFinish[]> {
    const reattachTimeoutMs =
      options?.reattachTimeoutMs ?? this._host.reattachNoProgressTimeoutMs();
    const reattachMaxWindowMs =
      options?.reattachMaxWindowMs ?? this._host.reattachMaxWindowMs();
    const startedAt = Date.now();
    const totalTimeoutMs =
      options?.totalRecoveryTimeoutMs ??
      DEFAULT_AGENT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS;
    const deadlineAt =
      totalTimeoutMs > 0
        ? startedAt + totalTimeoutMs
        : Number.POSITIVE_INFINITY;
    const deferredFinishes: DeferredAgentToolFinish[] = [];
    const rows = this._host.sql<AgentToolRunStorageRow>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, interrupted_reason,
             child_still_running, display_metadata, display_order,
             started_at, completed_at
      FROM cf_agent_tool_runs
      WHERE status IN ('starting', 'running')
      ORDER BY started_at ASC
    `;
    const runIds =
      options?.runIds !== undefined ? new Set(options.runIds) : undefined;
    const recoveryRows = rows.filter(
      (row) => !runIds || runIds.has(row.run_id)
    );
    this._host.emit("agent_tool:recovery:begin", {
      runCount: recoveryRows.length,
      totalTimeoutMs
    });
    const finalizeRow = async (
      row: AgentToolRunStorageRow,
      result: RunAgentToolResult,
      sequence: number,
      completedAt: number | undefined
    ): Promise<void> => {
      this._host.emit("agent_tool:recovery:row", {
        runId: row.run_id,
        agentType: row.agent_type,
        status: result.status,
        reason: result.error,
        elapsedMs: Date.now() - startedAt
      });
      const deferredFinish = await this._finishAgentToolRun(
        this._agentToolRunInfoFromRow(row),
        result,
        {
          sequence,
          completedAt,
          deferFinishHook: options?.deferFinishHooks
        }
      );
      if (deferredFinish) {
        deferredFinishes.push(deferredFinish);
      }
    };

    // Pass 1 — deadline-bounded inspect/classify sweep. Terminal and
    // non-recoverable rows are finalized immediately; still-running tail-able
    // children are queued for the parallel re-attach pass below. The shared
    // `deadlineAt` only bounds this fast classification — re-attach (which can
    // legitimately run for the child's lifetime) must NOT count against it, or
    // one slow child would starve every later sibling of recovery (#1630).
    const reattachQueue: Array<{
      row: AgentToolRunStorageRow;
      adapter: AgentToolChildAdapter;
    }> = [];
    for (const row of recoveryRows) {
      const sequence = 1;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        this._host.emit("agent_tool:recovery:deadline", {
          runId: row.run_id,
          agentType: row.agent_type,
          elapsedMs: Date.now() - startedAt
        });
        await finalizeRow(
          row,
          {
            runId: row.run_id,
            agentType: row.agent_type,
            status: "interrupted",
            reason: "recovery-deadline",
            error: this._interruptedMessageForReason("recovery-deadline")
          },
          sequence,
          undefined
        );
        continue;
      }
      const childTimeout =
        options?.childInspectionTimeoutMs ??
        DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS;
      const boundedChildTimeout =
        childTimeout > 0 ? Math.min(childTimeout, remainingMs) : remainingMs;
      const recovery = await this._inspectAgentToolRunForRecovery(
        row,
        sequence,
        boundedChildTimeout
      );
      if (recovery.status !== "inspected") {
        await finalizeRow(
          row,
          (() => {
            const reason: AgentToolInterruptedReason =
              recovery.status === "timed-out"
                ? "inspect-timeout"
                : "inspect-failed";
            return {
              runId: row.run_id,
              agentType: row.agent_type,
              status: "interrupted" as const,
              reason,
              error: this._interruptedMessageForReason(reason)
            };
          })(),
          sequence,
          undefined
        );
        continue;
      }
      const inspection = recovery.inspection;
      const stillRunning =
        !inspection ||
        inspection.status === "running" ||
        inspection.status === "starting";
      if (
        stillRunning &&
        typeof recovery.adapter.tailAgentToolRun === "function"
      ) {
        // Defer to the parallel re-attach pass — keep the row non-terminal so
        // re-attach can collect the child's real terminal result. No stored-chunk
        // broadcast here: re-attach forwards only new chunks, and a reconnected
        // client already replays stored chunks via `_replayAgentToolRuns`.
        reattachQueue.push({ row, adapter: recovery.adapter });
        continue;
      }
      let sequenceAfterReplay = sequence;
      try {
        sequenceAfterReplay =
          await this._agent._broadcastAgentToolStoredChunksFromAdapter(
            recovery.adapter,
            row,
            sequence,
            undefined,
            undefined,
            boundedChildTimeout
          );
      } catch {
        // Terminal reconciliation should still complete if chunk replay fails.
      }
      if (stillRunning) {
        await finalizeRow(
          row,
          {
            runId: row.run_id,
            agentType: row.agent_type,
            status: "interrupted",
            reason: "not-tailable",
            // The child has no live-tail adapter, so it was never torn down and
            // may still self-complete and be collected by a later inspect.
            childStillRunning: true,
            error: this._interruptedMessageForReason("not-tailable")
          },
          sequenceAfterReplay,
          undefined
        );
      } else {
        await finalizeRow(
          row,
          this._terminalResultFromInspection(row.agent_type, inspection),
          sequenceAfterReplay,
          inspection.completedAt
        );
      }
    }

    // Pass 2 — re-attach still-running children IN PARALLEL, each bounded by
    // its own re-attach budget, so a slow/hung child only delays itself and can
    // never cause a sibling run to be wrongly abandoned (#1630).
    await Promise.all(
      reattachQueue.map(async ({ row, adapter }) => {
        const reattach = await this._reattachAgentToolRunToTerminal(
          adapter,
          row,
          1,
          reattachTimeoutMs,
          reattachMaxWindowMs
        );
        if (reattach.result) {
          await finalizeRow(
            row,
            reattach.result,
            reattach.sequence,
            reattach.completedAt
          );
          return;
        }
        // The parent has genuinely given up on this still-running child — tear
        // it down so it stops consuming a fiber / keep-alive (#1630).
        const tornDown = await this._teardownGivenUpAgentToolChild(
          adapter,
          row.run_id,
          reattach.reason
        );
        await finalizeRow(
          row,
          {
            runId: row.run_id,
            agentType: row.agent_type,
            status: "interrupted",
            reason: reattach.reason,
            childStillRunning: !tornDown,
            error: this._interruptedMessageForReason(reattach.reason)
          },
          reattach.sequence,
          reattach.completedAt
        );
      })
    );
    this._host.emit("agent_tool:recovery:complete", {
      runCount: recoveryRows.length,
      elapsedMs: Date.now() - startedAt
    });
    return deferredFinishes;
  }

  private async _inspectAgentToolRunForRecovery(
    row: AgentToolRunStorageRow,
    _sequence: number,
    timeoutMs = DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS
  ): Promise<AgentToolRecoveryInspection> {
    const inspect = (async (): Promise<AgentToolRecoveryInspection> => {
      const child = await this._host.resolveSubAgent(
        row.agent_type,
        row.run_id
      );
      const adapter = this._asAgentToolChildAdapter(child);
      const inspection = await adapter.inspectAgentToolRun(row.run_id);
      return { status: "inspected", adapter, inspection };
    })().catch((): AgentToolRecoveryInspection => ({ status: "failed" }));

    if (timeoutMs <= 0) return inspect;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<AgentToolRecoveryInspection>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({ status: "timed-out" });
      }, timeoutMs);
    });

    const result = await Promise.race([inspect, timeout]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    return result;
  }

  _scheduleAgentToolRunRecovery(options?: {
    childInspectionTimeoutMs?: number;
    totalRecoveryTimeoutMs?: number;
    reattachTimeoutMs?: number;
    reattachMaxWindowMs?: number;
    runIds?: readonly string[];
  }): Promise<void> {
    if (this._agentToolRunRecoveryPromise) {
      return this._agentToolRunRecoveryPromise;
    }

    if (options?.runIds && options.runIds.length === 0) {
      return Promise.resolve();
    }

    const recovery = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const recoveredAgentToolFinishes = await this._reconcileAgentToolRuns({
        deferFinishHooks: true,
        childInspectionTimeoutMs: options?.childInspectionTimeoutMs,
        totalRecoveryTimeoutMs: options?.totalRecoveryTimeoutMs,
        reattachTimeoutMs: options?.reattachTimeoutMs,
        reattachMaxWindowMs: options?.reattachMaxWindowMs,
        runIds: options?.runIds
      });
      await this._runDeferredAgentToolFinishHooks(recoveredAgentToolFinishes);
    })()
      .catch(async (error) => {
        this._host.emit("agent_tool:recovery:failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        try {
          await this._host.onError(error);
        } catch {
          // Background recovery must never make a started agent unreachable.
        }
      })
      .finally(() => {
        this._agentToolRunRecoveryPromise = undefined;
      });

    this._agentToolRunRecoveryPromise = recovery;
    this._host.waitUntil(recovery);
    return recovery;
  }

  _agentToolRunRecoveryRunIds(): string[] {
    return this._host.sql<{ run_id: string }>`
      SELECT run_id
      FROM cf_agent_tool_runs
      WHERE status IN ('starting', 'running')
      ORDER BY started_at ASC
    `.map((row) => row.run_id);
  }

  private async _getAgentToolChunksForRecovery(
    adapter: AgentToolChildAdapter,
    runId: string,
    timeoutMs?: number
  ): Promise<AgentToolStoredChunk[] | undefined> {
    const chunks = adapter.getAgentToolChunks(runId).catch(() => undefined);
    if (timeoutMs === undefined || timeoutMs <= 0) return chunks;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timeoutId = setTimeout(() => resolve(undefined), timeoutMs);
    });
    const result = await Promise.race([chunks, timeout]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    return result;
  }
}
