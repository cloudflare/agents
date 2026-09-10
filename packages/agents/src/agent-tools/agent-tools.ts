/**
 * The agent-tool PARENT engine as a Lifecycle capability.
 *
 * One parent row table (`cf_agent_tool_runs`) records every run this agent
 * dispatched to a child agent: its display metadata, its terminal result, and
 * — for DETACHED ("background") runs — the two-slot delivery ledger that makes
 * completion hooks fire exactly once on the happy path and at-least-once under
 * failure. The capability owns dispatch, live stream forwarding, reconnect
 * replay, startup recovery / re-attach, and the durable detached backbone job.
 *
 * Everything host-specific — resolving a child facet, broadcasting to clients,
 * the user hooks, and the execution seams chat hosts override — arrives
 * through {@link AgentToolsHost}, installed with `setAgentToolsHost`.
 */

import {
  AGENT_TOOL_MILESTONE_PART,
  AGENT_TOOL_PROGRESS_PART
} from "../agent-tool-types";
import type {
  AgentToolChildAdapter,
  AgentToolDisplayMetadata,
  AgentToolEvent,
  AgentToolEventMessage,
  AgentToolInterruptedReason,
  AgentToolLifecycleResult,
  AgentToolMilestone,
  AgentToolProgress,
  AgentToolProgressSnapshot,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolRunStatus,
  AgentToolStoredChunk,
  ChatCapableAgentClass,
  DetachedAgentToolConfig,
  DetachedRunAgentToolResult,
  RunAgentToolOptions,
  RunAgentToolResult
} from "../agent-tool-types";
import { LifecycleCapability } from "../lifecycle/capability";
import type { LifecycleJobContext } from "../lifecycle/job-queue";
import type { Connection } from "../lifecycle/types";
import { SqlError } from "../sql-error";
import { nanoid } from "nanoid";
import { getAgentToolsHost, type AgentToolsHost } from "./host";
import {
  DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS,
  DEFAULT_AGENT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS,
  DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS,
  DEFAULT_AGENT_TOOL_REATTACH_NO_PROGRESS_TIMEOUT_MS,
  DETACHED_BACKBONE_CADENCE_S,
  DETACHED_DELIVERY_LEASE_MS,
  DETACHED_LIVE_COUNT_WARN_THRESHOLD,
  DETACHED_NOTIFY_CALLBACK,
  resolveAgentToolsOptions,
  type AgentToolsOptions,
  type ResolvedAgentToolsOptions
} from "./options";

const AGENT_TOOLS_SCHEMA_VERSION_KEY = "cf_agents:agent_tools_schema_version";
/** Version 1: the run table moved out of Agent's monolithic schema. */
const CURRENT_AGENT_TOOLS_SCHEMA_VERSION = 1;

/** Stable id of the single detached reconcile job in the Lifecycle queue. */
const DETACHED_RECONCILE_JOB_ID = "detached-reconcile";
/** Dispatch name for that job. */
const DETACHED_RECONCILE_JOB_FN = "detachedReconcile";

/** @internal One raw `cf_agent_tool_runs` row. */
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
  // Detached ("background") run bookkeeping (rfc-detached-agent-tools).
  detached: number;
  detached_on_finish: string | null;
  detached_notify_source?: string | null;
  detached_max_budget_at: number | null;
  finish_claimed_at: number | null;
  finish_delivered_at: number | null;
  give_up_claimed_at: number | null;
  give_up_delivered_at: number | null;
  detached_no_progress_budget_ms?: number | null;
  last_progress_at?: number | null;
  detached_on_milestones?: string | null;
};

/** @internal A finish hook deferred out of a recovery pass. */
export type DeferredAgentToolFinish = () => Promise<void>;

/** Cadence position carried by the detached reconcile job. */
type DetachedReconcilePayload = { cadenceIndex?: number };

type AgentToolRecoveryInspection =
  | {
      status: "inspected";
      adapter: AgentToolChildAdapter;
      inspection: AgentToolRunInspection | null;
    }
  | { status: "failed" }
  | { status: "timed-out" };

/** Options accepted by {@link AgentTools.clear}. */
export type ClearAgentToolRunsOptions = {
  /** Only clear runs started before this epoch-ms timestamp. */
  readonly olderThan?: number;
  /** Only clear runs currently in one of these statuses. */
  readonly status?: AgentToolRunStatus[];
};

/** Options accepted by {@link AgentTools.reconcile}. */
export type AgentToolReconcileOptions = {
  /** Collect finish hooks instead of firing them inline. */
  readonly deferFinishHooks?: boolean;
  /** Bounded wait for one child inspection. */
  readonly childInspectionTimeoutMs?: number;
  /** Deadline for the whole classification sweep. */
  readonly totalRecoveryTimeoutMs?: number;
  /** No-progress budget for the parallel re-attach pass. */
  readonly reattachTimeoutMs?: number;
  /** Hard wall-clock ceiling for the parallel re-attach pass. */
  readonly reattachMaxWindowMs?: number;
  /** Restrict recovery to this snapshot of run ids. */
  readonly runIds?: readonly string[];
};

/**
 * Parent-side agent-tool runs: dispatch, live forwarding, reconnect replay,
 * recovery, and the detached-run delivery ledger.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class AgentTools extends LifecycleCapability {
  readonly #options: ResolvedAgentToolsOptions;
  #detachedLiveCountWarned = false;
  #recoveryPromise: Promise<void> | undefined;

  /**
   * @param options Policy-only knobs; host bindings arrive separately
   * through `setAgentToolsHost`.
   */
  constructor(options: AgentToolsOptions = {}) {
    super("agent-tools");
    this.#options = resolveAgentToolsOptions(options);
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Create and migrate the run table during Lifecycle startup. */
  async onStart(): Promise<void> {
    const storage = this.lifecycle.storage;
    const version =
      (await storage.get<number>(AGENT_TOOLS_SCHEMA_VERSION_KEY)) ?? 0;
    if (version >= CURRENT_AGENT_TOOLS_SCHEMA_VERSION) return;
    this.#ensureTables();
    await storage.put(
      AGENT_TOOLS_SCHEMA_VERSION_KEY,
      CURRENT_AGENT_TOOLS_SCHEMA_VERSION
    );
  }

  /** Drive one due detached reconcile tick. */
  async onJob(context: LifecycleJobContext): Promise<void> {
    if (context.job.fn !== DETACHED_RECONCILE_JOB_FN) return;
    const payload = (context.job.payload ?? undefined) as
      | DetachedReconcilePayload
      | undefined;
    await this.lifecycle.runInHostContext(() => this.reconcileTick(payload));
  }

  // ── Public surface ───────────────────────────────────────────────────────

  /**
   * Dispatch (or re-attach to) one agent-tool run against a child agent
   * class. A detached run returns as soon as the child is started; an awaited
   * run tails the child's stream to its terminal result.
   *
   * @param cls The chat-capable child agent class to run.
   * @param options Run configuration, including the optional stable `runId`.
   * @returns The run handle for a detached run, or the terminal result.
   */
  async run<Input = unknown>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input> & {
      detached: true | DetachedAgentToolConfig;
    }
  ): Promise<DetachedRunAgentToolResult>;
  async run<Input = unknown, Output = unknown>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input>
  ): Promise<RunAgentToolResult<Output>>;
  async run<Input = unknown, Output = unknown>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input>
  ): Promise<RunAgentToolResult<Output> | DetachedRunAgentToolResult> {
    const runId = options.runId ?? nanoid(12);
    const agentType = cls.name;
    const detached = this.#parseDetachedOption(options.detached);

    const existing = this.#readRun(runId);
    if (existing) {
      // Detached re-dispatch (e.g. chat recovery re-running the dispatching
      // turn) is idempotent by runId: re-arm the durable backbone for a still
      // non-terminal run and hand back the live handle instead of re-tailing or
      // spawning fresh work. A run that already reached terminal simply returns
      // a running-shaped handle — its delivery already happened (or is owned by
      // the ledger).
      if (detached) {
        if (!this.#isHardTerminal(existing.status)) {
          await this.armDetachedBackbone();
        }
        return { runId, agentType, status: "running" };
      }
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
            const adapter = await this.#childAdapter<Input, Output>(
              agentType,
              runId
            );
            const inspection = await adapter.inspectAgentToolRun(runId);
            if (inspection?.status === "completed") {
              const result = this.#terminalResultFromInspection<Output>(
                agentType,
                inspection
              );
              this.#updateTerminal(runId, result, inspection.completedAt);
              return result;
            }
          } catch {
            // Fall back to the retained parent row.
          }
        }
        return this.#resultFromRow<Output>(existing);
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
        const adapter = await this.#childAdapter<Input, Output>(
          agentType,
          runId
        );
        const reattach = await this.#reattachToTerminal<Output>(
          adapter,
          existing,
          1,
          this.#options.reattachNoProgressTimeoutMs,
          this.#options.reattachMaxWindowMs
        );
        if (reattach.result) {
          await this.#finishRun(
            this.#runInfoFromRow(existing),
            reattach.result,
            { sequence: reattach.sequence, completedAt: reattach.completedAt }
          );
          return reattach.result;
        }
        reattachReason = reattach.reason;
        // The parent has genuinely given up re-attaching to this live child —
        // tear it down so it stops consuming a fiber / keep-alive (#1630).
        childTornDown = await this.#teardownGivenUpChild(
          adapter,
          runId,
          reattach.reason
        );
      } catch {
        // Fall through to the honest interrupted state below.
      }
      return await this.#replayAndInterrupt<Output>(
        existing,
        this.#interruptedMessageForReason(reattachReason),
        { reason: reattachReason, childStillRunning: !childTornDown }
      );
    }

    const displayOrder = options.displayOrder ?? 0;
    const inputPreview =
      options.inputPreview ?? this.#defaultPreview(options.input);
    const displayJson =
      options.display !== undefined ? JSON.stringify(options.display) : null;
    const inputPreviewJson =
      inputPreview !== undefined ? JSON.stringify(inputPreview) : null;
    const startedAt = Date.now();

    // Two budgets, checked in order: the TOTAL cap covers every non-terminal
    // run, and a detached dispatch must additionally fit the detached-only cap
    // (detached runs count toward both). Either rejection is synchronous — an
    // `error` row plus `started`/`error` events, and no child is spawned.
    const maxConcurrent = this.#maxConcurrent();
    if (this.#activeRunCount() >= maxConcurrent) {
      return this.#rejectDispatch(
        `maxConcurrentAgentTools (${maxConcurrent}) exceeded`,
        {
          runId,
          agentType,
          startedAt,
          displayOrder,
          inputPreview,
          inputPreviewJson,
          displayJson,
          options
        }
      );
    }
    const maxConcurrentDetached = this.#maxConcurrentDetached();
    if (detached && this.#liveDetachedRunCount() >= maxConcurrentDetached) {
      return this.#rejectDispatch(
        `maxConcurrentDetachedAgentTools (${maxConcurrentDetached}) exceeded`,
        {
          runId,
          agentType,
          startedAt,
          displayOrder,
          inputPreview,
          inputPreviewJson,
          displayJson,
          options
        }
      );
    }

    const detachedMaxBudgetAt = detached
      ? startedAt + (detached.maxBudgetMs ?? this.#options.detachedMaxBudgetMs)
      : null;
    const detachedNoProgressBudgetMs = detached
      ? (detached.noProgressBudgetMs ??
        this.#options.detachedNoProgressBudgetMs)
      : null;
    const detachedOnMilestonesJson = detached?.onMilestones
      ? JSON.stringify(detached.onMilestones)
      : null;
    this.#sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, input_preview,
        status, display_metadata, display_order, started_at,
        detached, detached_on_finish, detached_notify_source,
        detached_max_budget_at, detached_no_progress_budget_ms,
        detached_on_milestones
      ) VALUES (
        ${runId}, ${options.parentToolCallId ?? null}, ${agentType},
        ${inputPreviewJson}, 'starting', ${displayJson}, ${displayOrder},
        ${startedAt}, ${detached ? 1 : 0}, ${detached?.onFinishName ?? null},
        ${detached?.notifySource ?? null}, ${detachedMaxBudgetAt},
        ${detachedNoProgressBudgetMs}, ${detachedOnMilestonesJson}
      )
    `;

    const runInfo: AgentToolRunInfo = {
      runId,
      parentToolCallId: options.parentToolCallId,
      agentType,
      inputPreview,
      status: "starting",
      display: options.display,
      ...(detached?.notifySource !== undefined
        ? { notifySource: detached.notifySource }
        : {}),
      displayOrder,
      startedAt
    };
    await this.#host.onAgentToolStart(runInfo);
    this.#broadcastEvent(options.parentToolCallId, 0, {
      kind: "started",
      runId,
      agentType,
      inputPreview,
      order: displayOrder,
      display: options.display
    });

    const adapter = await this.#childAdapter<Input, Output>(agentType, runId);
    const childStart = await adapter.startAgentToolRun(options.input, {
      runId
    });
    this.#markRunning(runId);

    if (detached) {
      // The child must OUTLIVE the dispatching turn, so a detached run never
      // inherits `options.signal` (which aborts when this turn ends). Cancel a
      // detached run explicitly with `cancel(runId)`.
      if (options.signal) {
        console.warn(
          `[agents] runAgentTool: \`signal\` is ignored for a detached run (${runId}); a detached child must outlive the spawning turn. Use cancelAgentTool(runId) to cancel it.`
        );
      }
      // Arm the durable backbone first so eviction between here and the fast
      // path still finalizes the run, then kick the warm fast path that tails
      // the child to terminal and delivers with low latency while alive.
      await this.armDetachedBackbone({ resetCadence: true });
      // Surface runaway accumulation: detached runs hold a slot for their whole
      // life with no observer to notice a leak.
      this.#maybeWarnDetachedLiveCount();
      this.#host.waitUntil(
        this.#detachedFastPath<Input, Output>(runInfo, agentType, runId)
      );
      return { runId, agentType, status: "running" };
    }

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
        await this.#finishRun(runInfo, result, { sequence });
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
          await this.#forwardStream(
            stream,
            options.parentToolCallId,
            runId,
            sequence,
            options.signal
          )
        ).next;
      } else {
        const chunks = await adapter.getAgentToolChunks(runId);
        sequence = this.#broadcastChunks(
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
        await this.#finishRun(runInfo, result, { sequence });
        return result;
      }

      const inspection =
        (await adapter.inspectAgentToolRun(runId)) ?? childStart;
      const result = this.#terminalResultFromInspection<Output>(
        agentType,
        inspection
      );
      await this.#finishRun(runInfo, result, {
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
        await this.#finishRun(runInfo, result, { sequence });
        return result;
      }
      const message = error instanceof Error ? error.message : String(error);
      const result: RunAgentToolResult<Output> = {
        runId,
        agentType,
        status: "error",
        error: message
      };
      await this.#finishRun(runInfo, result, { sequence });
      return result;
    } finally {
      if (parentAbortListener && options.signal) {
        options.signal.removeEventListener("abort", parentAbortListener);
      }
    }
  }

  /**
   * Cancel an agent-tool run by id. Idempotent: cancelling an already-terminal
   * run is a no-op. Detached runs deliver through the guarded ledger so a wired
   * `onFinish` fires once with `status: "aborted"`; awaited runs leave terminal
   * observation to the awaiting/recovery path, avoiding duplicate finish hooks.
   *
   * @param runId The run to cancel.
   * @param reason Optional cancellation reason surfaced to the child.
   */
  async cancel(runId: string, reason?: unknown): Promise<void> {
    const row = this.#readRun(runId);
    if (!row) return;
    if (this.#isHardTerminal(row.status)) return;
    const isDetached = row.detached === 1;
    const message =
      reason instanceof Error
        ? reason.message
        : String(reason ?? "cancelled by parent");
    try {
      const adapter = await this.#childAdapter(row.agent_type, runId);
      await adapter.cancelAgentToolRun(runId, reason);
    } catch {
      // Best-effort child teardown; we still record the aborted terminal so the
      // detached parent stops watching and any wired callback fires.
    }
    if (!isDetached) return;
    await this.#deliverDetachedTerminal(runId, "finish", {
      runId,
      agentType: row.agent_type,
      status: "aborted",
      error: message
    });
  }

  /**
   * Whether a run with this id and agent type is recorded on this parent.
   *
   * @param agentType The child agent class name.
   * @param runId The run id.
   * @returns True when the parent holds a row for that pair.
   */
  has(agentType: string, runId: string): boolean {
    const rows = this.#sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE run_id = ${runId} AND agent_type = ${agentType}
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  /**
   * Delete recorded runs (and their child facets), cancelling any that are
   * still live. Cleanup is idempotent — a child that cannot be reached is
   * still removed from the parent's table.
   *
   * @param options Optional age and status filters; omitted, everything goes.
   */
  async clear(options?: ClearAgentToolRunsOptions): Promise<void> {
    const rows = this.#sql<{
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
    const doomed = rows.filter((row) => {
      if (statusFilter && !statusFilter.has(row.status)) return false;
      if (options?.olderThan !== undefined) {
        const full = this.#readRun(row.run_id);
        if (!full || full.started_at >= options.olderThan) return false;
      }
      return true;
    });

    for (const row of doomed) {
      try {
        if (row.status === "starting" || row.status === "running") {
          const adapter = await this.#childAdapter(row.agent_type, row.run_id);
          await adapter.cancelAgentToolRun(
            row.run_id,
            "clearing agent tool run"
          );
        }
        await this.#host.deleteChild(row.agent_type, row.run_id);
      } catch {
        // Cleanup is intentionally idempotent.
      }
      this.#sql`
        DELETE FROM cf_agent_tool_runs WHERE run_id = ${row.run_id}
      `;
    }
  }

  /**
   * Replay recorded runs onto one freshly connected client as `replay: true`
   * agent-tool events, so a reconnecting UI rebuilds the same timeline a live
   * client saw.
   *
   * Bounded by the `replayOnConnect` policy (both caps default to `Infinity`,
   * i.e. every run with every stored chunk): `maxRuns` keeps only the newest
   * runs by start time, `maxChunksPerRun` keeps only each run's last chunks.
   * Dropped chunks still advance the frame sequence, so the frames a capped
   * replay does send carry the same sequence numbers an uncapped replay would
   * and the client's live/replay dedupe is unaffected.
   *
   * @param connection The connection to send the replay frames to.
   */
  async replayToConnection(connection: Connection): Promise<void> {
    const { maxRuns, maxChunksPerRun } = this.#options.replayOnConnect;
    // SQLite treats a negative LIMIT as "no limit", which is how an `Infinity`
    // cap stays a single query.
    const runLimit =
      Number.isFinite(maxRuns) && maxRuns >= 0 ? Math.floor(maxRuns) : -1;
    if (runLimit === 0) return;
    const rows = this.#sql<{
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
      ORDER BY started_at DESC, rowid DESC
      LIMIT ${runLimit}
    `;
    // Selected newest-first to apply the cap, re-emitted oldest-first so the
    // client rebuilds the timeline in display order.
    rows.reverse();

    for (const row of rows) {
      const parentToolCallId = row.parent_tool_call_id ?? undefined;
      let sequence = 0;
      this.#broadcastEvent(
        parentToolCallId,
        sequence++,
        {
          kind: "started",
          runId: row.run_id,
          agentType: row.agent_type,
          inputPreview: this.#parseJson(row.input_preview),
          order: row.display_order,
          display: this.#parseJson(row.display_metadata) as
            | AgentToolDisplayMetadata
            | undefined
        },
        true,
        connection
      );

      try {
        sequence = await this.#broadcastStoredChunks(
          row,
          sequence,
          true,
          connection,
          maxChunksPerRun
        );
      } catch {
        // Keep replay best-effort per run.
      }

      if (this.#isTerminal(row.status)) {
        this.#broadcastTerminal(
          parentToolCallId,
          sequence,
          {
            runId: row.run_id,
            agentType: row.agent_type,
            status: row.status as RunAgentToolResult["status"],
            output: this.#parseJson(row.output_json),
            summary: row.summary ?? undefined,
            error: row.error_message ?? undefined,
            ...this.#interruptedExtrasFromRow(row)
          },
          true,
          connection
        );
      }
    }
  }

  /**
   * The runs that were non-terminal at wake time. Snapshot this BEFORE the
   * host's own `onStart` runs, then hand it to
   * {@link AgentTools.scheduleStartupRecovery} afterwards.
   *
   * @returns The ids of every `starting`/`running` run, oldest first.
   */
  recoveryRunIds(): string[] {
    return this.#sql<{ run_id: string }>`
      SELECT run_id
      FROM cf_agent_tool_runs
      WHERE status IN ('starting', 'running')
      ORDER BY started_at ASC
    `.map((row) => row.run_id);
  }

  /**
   * Start (once per wake) the background reconciliation of runs interrupted by
   * an eviction or deploy, and re-arm the detached backbone if anything is
   * still outstanding. Runs on the host's `waitUntil`, so it never blocks
   * startup.
   *
   * @param options Recovery bounds and the run-id snapshot to recover.
   * @returns The in-flight recovery pass; already-running passes are shared.
   */
  scheduleStartupRecovery(options?: {
    childInspectionTimeoutMs?: number;
    totalRecoveryTimeoutMs?: number;
    reattachTimeoutMs?: number;
    reattachMaxWindowMs?: number;
    runIds?: readonly string[];
  }): Promise<void> {
    if (this.#recoveryPromise) {
      return this.#recoveryPromise;
    }

    if (options?.runIds && options.runIds.length === 0) {
      return Promise.resolve();
    }

    const recovery = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const recoveredFinishes = await this.reconcile({
        deferFinishHooks: true,
        childInspectionTimeoutMs: options?.childInspectionTimeoutMs,
        totalRecoveryTimeoutMs: options?.totalRecoveryTimeoutMs,
        reattachTimeoutMs: options?.reattachTimeoutMs,
        reattachMaxWindowMs: options?.reattachMaxWindowMs,
        runIds: options?.runIds
      });
      await this.#runDeferredFinishHooks(recoveredFinishes);
      // Re-arm the detached backbone if this DO woke with outstanding detached
      // runs (the job row survives eviction, but this also recreates it if a
      // dispatching turn crashed after inserting the run row but before arming
      // the job).
      if (this.hasOutstandingDetachedRuns()) {
        await this.armDetachedBackbone();
      }
    })()
      .catch(async (error) => {
        this.#emit("agent_tool:recovery:failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        try {
          await this.#host.onError(error);
        } catch {
          // Background recovery must never make a started agent unreachable.
        }
      })
      .finally(() => {
        this.#recoveryPromise = undefined;
      });

    this.#recoveryPromise = recovery;
    this.#host.waitUntil(recovery);
    return recovery;
  }

  /** Whether any detached run is still awaiting terminal delivery. */
  hasOutstandingDetachedRuns(): boolean {
    const rows = this.#sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE detached = 1 AND finish_delivered_at IS NULL
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  /**
   * The pending detached reconcile job, when one is armed.
   *
   * @returns Its due time and cadence position, or `undefined` when the
   * backbone is quiet.
   */
  pendingDetachedReconcile():
    | { dueAt: number; cadenceIndex: number }
    | undefined {
    const job = this.lifecycle.jobs.get(DETACHED_RECONCILE_JOB_ID);
    if (!job) return undefined;
    const payload = (job.payload ?? undefined) as
      | DetachedReconcilePayload
      | undefined;
    return {
      dueAt: job.time,
      cadenceIndex:
        typeof payload?.cadenceIndex === "number" ? payload.cadenceIndex : 0
    };
  }

  /**
   * Arm the detached reconcile backbone. One job, one id: an existing job is
   * reused for recovery/startup calls, but a fresh detached dispatch resets
   * the pending cadence to the fast end so new work is noticed promptly.
   *
   * @param options Pass `resetCadence` to restart at the fastest cadence step.
   */
  async armDetachedBackbone(options?: {
    resetCadence?: boolean;
  }): Promise<void> {
    // The job id is fixed, so a same-id push REPLACES rather than duplicating:
    // a fan-out of detached `runAgentTool`s in one turn converges on exactly
    // one backbone without any isolate-local arming mutex.
    if (
      !options?.resetCadence &&
      this.lifecycle.jobs.get(DETACHED_RECONCILE_JOB_ID)
    ) {
      // A deduplicated push does not re-arm the physical alarm; recover it in
      // case this wake lost it.
      await this.lifecycle.jobs.rearm();
      return;
    }
    await this.#pushBackbone(0);
  }

  /**
   * Durable backbone tick for detached runs: collect any detached run that has
   * reached terminal but was not yet delivered (e.g. the parent was evicted
   * before the fast path landed), deliver any milestone the warm tail missed,
   * give up on any run past its budget (tearing the child down), and re-arm at
   * the next cadence step while any detached run remains undelivered —
   * completing (zero steady-state cost) once everything has settled.
   *
   * @param payload The cadence position this tick was scheduled at.
   */
  async reconcileTick(payload?: DetachedReconcilePayload): Promise<void> {
    const rows = this.#sql<AgentToolRunStorageRow>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, interrupted_reason,
             child_still_running, display_metadata, display_order,
             started_at, completed_at, detached, detached_on_finish,
             detached_notify_source, detached_max_budget_at,
             detached_no_progress_budget_ms, last_progress_at,
             detached_on_milestones,
             finish_claimed_at, finish_delivered_at, give_up_claimed_at,
             give_up_delivered_at
      FROM cf_agent_tool_runs
      WHERE detached = 1 AND finish_delivered_at IS NULL
      ORDER BY started_at ASC
    `;

    for (const row of rows) {
      const runId = row.run_id;
      let inspection: AgentToolRunInspection | null = null;
      try {
        const adapter = await this.#childAdapter(row.agent_type, runId);
        inspection = await adapter.inspectAgentToolRun(runId);
      } catch {
        // Treat an unreachable child like a null inspection: keep waiting within
        // budget rather than sealing (a single failure is not proof it is gone).
      }

      // Deliver any configured milestone notifications the warm tail missed
      // (e.g. the parent was evicted when the milestone landed). Idempotent:
      // the host delivery keys on (runId, name), so re-delivering an
      // already-notified milestone is a no-op. Runs regardless of terminal
      // state — a milestone reached just before completion still notifies.
      if (inspection?.milestones && row.detached_on_milestones) {
        const milestoneRunInfo = this.#runInfoFromRow(row);
        for (const milestone of inspection.milestones) {
          this.#maybeDeliverMilestone(row, milestoneRunInfo, milestone);
        }
      }

      if (
        inspection &&
        this.#isHardTerminal(inspection.status as AgentToolRunStatus)
      ) {
        const result = this.#terminalResultFromInspection(
          row.agent_type,
          inspection
        );
        await this.#deliverDetachedTerminal(
          runId,
          "finish",
          result,
          { sequence: Date.now(), serialize: true },
          inspection.completedAt
        );
        continue;
      }

      // Still non-terminal. Give up only once (the give_up slot guards
      // re-delivery), on whichever bound trips first:
      //  - the absolute `detached_max_budget_at` ceiling (taking too long), or
      //  - the resetting no-progress window: once the child has reported at
      //    least one signal and then goes silent past the window. A child that
      //    has never reported has no signal time and is bounded ONLY by the
      //    absolute ceiling — never given up on merely for being slow.
      const now = Date.now();
      const budgetAt = row.detached_max_budget_at;
      // ANY signal resets the window — ephemeral progress OR a durable milestone
      // (milestones bump the child's signal clock but leave `progress` unset, so
      // a milestone-only child must still count as alive). After eviction the
      // child's inspect is authoritative; `last_progress_at` is the warm-tail
      // cache fallback.
      const latestMilestone = inspection?.milestones?.length
        ? inspection.milestones[inspection.milestones.length - 1].at
        : undefined;
      const signalTimes = [
        inspection?.progress?.at,
        latestMilestone,
        row.last_progress_at
      ].filter((t): t is number => typeof t === "number");
      const lastSignalAt =
        signalTimes.length > 0 ? Math.max(...signalTimes) : undefined;
      const noProgressBudgetMs = row.detached_no_progress_budget_ms;
      const overAbsolute = budgetAt !== null && now >= budgetAt;
      const overNoProgress =
        typeof noProgressBudgetMs === "number" &&
        noProgressBudgetMs > 0 &&
        Number.isFinite(noProgressBudgetMs) &&
        typeof lastSignalAt === "number" &&
        now - lastSignalAt >= noProgressBudgetMs;
      if (
        (overAbsolute || overNoProgress) &&
        row.give_up_delivered_at === null
      ) {
        let childTornDown = false;
        try {
          const adapter = await this.#childAdapter(row.agent_type, runId);
          await adapter.cancelAgentToolRun(
            runId,
            overAbsolute
              ? "detached budget exceeded"
              : "detached run went silent past its no-progress window"
          );
          childTornDown = true;
        } catch {
          // Could not confirm teardown; the child may complete anyway and the
          // finish slot (still open) will deliver the real result.
        }
        await this.#deliverDetachedTerminal(
          runId,
          "give_up",
          {
            runId,
            agentType: row.agent_type,
            status: "interrupted",
            error: overAbsolute
              ? "detached run exceeded its budget before completing"
              : "detached run went silent past its no-progress window",
            reason: overAbsolute ? "budget-exceeded" : "no-progress",
            childStillRunning: !childTornDown
          },
          { serialize: true }
        );
      }
    }

    // Re-arm while anything remains undelivered; otherwise let the backbone go
    // quiet (the job completes and is not recreated here).
    if (this.hasOutstandingDetachedRuns()) {
      const currentIndex =
        typeof payload?.cadenceIndex === "number" ? payload.cadenceIndex : 0;
      const nextIndex = Math.min(
        currentIndex + 1,
        DETACHED_BACKBONE_CADENCE_S.length - 1
      );
      await this.#pushBackbone(nextIndex);
    }
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  /**
   * Reconcile every awaited run left non-terminal by an eviction or deploy:
   * classify each child, re-attach in parallel to the ones still streaming,
   * and seal the rest as `interrupted` with a typed cause.
   *
   * Public because it is a legitimate "recover now" operation: a host that
   * learns out-of-band that its children may have been interrupted (a manual
   * repair, a migration, a test driving recovery deterministically) can run a
   * pass without waiting for the next wake. {@link
   * AgentTools.scheduleStartupRecovery} is the automatic caller.
   *
   * @param options Recovery bounds and filters.
   * @returns The deferred finish hooks when `deferFinishHooks` was set.
   */
  async reconcile(
    options?: AgentToolReconcileOptions
  ): Promise<DeferredAgentToolFinish[]> {
    const reattachTimeoutMs =
      options?.reattachTimeoutMs ?? this.#options.reattachNoProgressTimeoutMs;
    const reattachMaxWindowMs =
      options?.reattachMaxWindowMs ?? this.#options.reattachMaxWindowMs;
    const startedAt = Date.now();
    const totalTimeoutMs =
      options?.totalRecoveryTimeoutMs ??
      DEFAULT_AGENT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS;
    const deadlineAt =
      totalTimeoutMs > 0
        ? startedAt + totalTimeoutMs
        : Number.POSITIVE_INFINITY;
    const deferredFinishes: DeferredAgentToolFinish[] = [];
    const rows = this.#sql<AgentToolRunStorageRow>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, interrupted_reason,
             child_still_running, display_metadata, display_order,
             started_at, completed_at
      FROM cf_agent_tool_runs
      WHERE status IN ('starting', 'running') AND detached = 0
      ORDER BY started_at ASC
    `;
    // NOTE: detached runs are deliberately excluded. The awaited reconcile seals
    // a still-running, not-tailable run `interrupted` because a lost observer
    // means the dispatching turn cannot continue. For a DETACHED run a lost
    // observer is the NORMAL state — sealing it would defeat the feature — so
    // detached runs are owned by the reconcile backbone job instead, which keeps
    // them alive within budget and delivers on terminal. The backbone is
    // (re-)armed on startup by `scheduleStartupRecovery`.
    const runIds =
      options?.runIds !== undefined ? new Set(options.runIds) : undefined;
    const recoveryRows = rows.filter(
      (row) => !runIds || runIds.has(row.run_id)
    );
    this.#emit("agent_tool:recovery:begin", {
      runCount: recoveryRows.length,
      totalTimeoutMs
    });
    const finalizeRow = async (
      row: AgentToolRunStorageRow,
      result: RunAgentToolResult,
      sequence: number,
      completedAt: number | undefined
    ): Promise<void> => {
      this.#emit("agent_tool:recovery:row", {
        runId: row.run_id,
        agentType: row.agent_type,
        status: result.status,
        reason: result.error,
        elapsedMs: Date.now() - startedAt
      });
      const deferredFinish = await this.#finishRun(
        this.#runInfoFromRow(row),
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
        this.#emit("agent_tool:recovery:deadline", {
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
            error: this.#interruptedMessageForReason("recovery-deadline")
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
      const recovery = await this.#inspectForRecovery(row, boundedChildTimeout);
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
              error: this.#interruptedMessageForReason(reason)
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
        // client already replays stored chunks via `replayToConnection`.
        reattachQueue.push({ row, adapter: recovery.adapter });
        continue;
      }
      let sequenceAfterReplay = sequence;
      try {
        sequenceAfterReplay = await this.#broadcastStoredChunksFromAdapter(
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
            error: this.#interruptedMessageForReason("not-tailable")
          },
          sequenceAfterReplay,
          undefined
        );
      } else {
        await finalizeRow(
          row,
          this.#terminalResultFromInspection(row.agent_type, inspection),
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
        const reattach = await this.#reattachToTerminal(
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
        const tornDown = await this.#teardownGivenUpChild(
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
            error: this.#interruptedMessageForReason(reattach.reason)
          },
          reattach.sequence,
          reattach.completedAt
        );
      })
    );
    this.#emit("agent_tool:recovery:complete", {
      runCount: recoveryRows.length,
      elapsedMs: Date.now() - startedAt
    });
    return deferredFinishes;
  }

  /**
   * Run finish hooks deferred out of a recovery pass, isolating each failure so
   * one throwing hook cannot strand the others. Only
   * {@link AgentTools.scheduleStartupRecovery} defers hooks, so the drain is
   * part of that pass rather than a separate operation.
   */
  async #runDeferredFinishHooks(
    hooks: DeferredAgentToolFinish[]
  ): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        try {
          await this.#host.onError(error);
        } catch {
          // Recovery hooks are best-effort; one failed mirror write should not
          // prevent the agent from starting or other recovered runs finalizing.
        }
      }
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
   * @param adapter The child adapter to tail.
   * @param row Identity of the run being re-attached.
   * @param sequence The broadcast sequence to continue from.
   * @param noProgressTimeoutMs Progress-keyed budget for the wait.
   * @param maxWindowMs Optional hard wall-clock ceiling.
   * @returns The terminal `result` (and `completedAt`) when the child reaches a
   * terminal status, plus the advanced broadcast `sequence`. Returns
   * `{ result: undefined }` with a typed `reason` when there is no
   * `tailAgentToolRun` adapter, the child makes no progress within a full
   * no-progress window, or the ceiling is reached while the child is still
   * non-terminal — the caller then seals `interrupted`.
   */
  async #reattachToTerminal<Output>(
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

    this.#emit("agent_tool:recovery:reattach", {
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
          result: this.#terminalResultFromInspection<Output>(
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
        // are already delivered to connected clients via `replayToConnection`
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
          const forwarded = await this.#forwardStream(
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

  // ── Detached delivery ────────────────────────────────────────────────────

  /**
   * Single delivery funnel for a detached terminal. Both the warm fast path and
   * the durable backbone route through here, with INDEPENDENT ledger slots for
   * `finish` (the real terminal) vs `give_up` (budget exhausted). Each slot is
   * delivered at-least-once via a claim + lease:
   *
   * - Concurrent double-fire is prevented by the guarded CAS claim (RETURNING
   *   yields the row only to the winner).
   * - A crash after the side effect but before `*_delivered_at` is written lets
   *   the lease expire so a later reconcile re-delivers — hence handlers must be
   *   idempotent.
   * - Two slots, not one, because `interrupted` is SOFT: a give-up followed by a
   *   real completion is legitimate, and a single shared "delivered" bit would
   *   dedupe the child's real late result away (the #1752 production incident).
   *
   * @param runId The detached run being delivered.
   * @param kind Which ledger slot this delivery claims.
   * @param result The terminal result to record and hand to the hooks.
   * @param options Broadcast sequence and turn-queue serialization.
   * @param completedAt Terminal timestamp; defaults to now.
   */
  async #deliverDetachedTerminal<Output>(
    runId: string,
    kind: "finish" | "give_up",
    result: RunAgentToolResult<Output>,
    options?: { sequence?: number; serialize?: boolean },
    completedAt = Date.now()
  ): Promise<void> {
    const now = Date.now();
    const leaseFloor = now - DETACHED_DELIVERY_LEASE_MS;
    // Guarded CAS claim. `rowsWritten` (changes()) is the affected-row count, so
    // exactly one concurrent caller observes 1 and proceeds; everyone else (a
    // racing path, or a re-delivery within the lease) observes 0 and bails.
    const claimQuery =
      kind === "finish"
        ? `UPDATE cf_agent_tool_runs
             SET finish_claimed_at = ?
             WHERE run_id = ?
               AND finish_delivered_at IS NULL
               AND (finish_claimed_at IS NULL OR finish_claimed_at < ?)`
        : `UPDATE cf_agent_tool_runs
             SET give_up_claimed_at = ?
             WHERE run_id = ?
               AND give_up_delivered_at IS NULL
               AND (give_up_claimed_at IS NULL OR give_up_claimed_at < ?)`;
    const claimed = this.lifecycle.storage.sql.exec(
      claimQuery,
      now,
      runId,
      leaseFloor
    ).rowsWritten;
    if (claimed === 0) return;

    const row = this.#readRun(runId);
    if (!row) return;

    this.#updateTerminal(runId, result, completedAt);
    // Always project the terminal onto the parent's `agent-tool-event` stream so
    // a background-runs tray flips to its final state live. The backbone/fast
    // path supply a tail sequence; other paths (e.g. an explicit `cancel`, or a
    // budget give-up) get a synthetic latest-wins sequence — the client reducer
    // keys terminal status off the event kind, not the sequence, so a monotonic
    // value is not required.
    this.#broadcastTerminal(
      row.parent_tool_call_id ?? undefined,
      options?.sequence ?? Date.now(),
      result
    );

    const runInfo = this.#runInfoFromRow(row, result.status, completedAt);
    const lifecycle: AgentToolLifecycleResult = {
      status: result.status,
      ...(result.summary !== undefined ? { summary: result.summary } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.childStillRunning !== undefined
        ? { childStillRunning: result.childStillRunning }
        : {})
    };

    const invoke = async () => {
      // Global metering hook fires for detached runs too (cost accounting
      // parity with the awaited path).
      try {
        await this.#host.onAgentToolFinish(runInfo, lifecycle);
      } catch (error) {
        await this.#safeOnError(error);
      }
      // Targeted, durable per-run callback (method name persisted on the row).
      const callbackName = row.detached_on_finish;
      if (callbackName) {
        const callback = this.#host.resolveCallback(callbackName);
        if (callback) {
          try {
            await (
              callback as unknown as (
                run: AgentToolRunInfo,
                res: AgentToolLifecycleResult
              ) => Promise<void>
            )(runInfo, lifecycle);
          } catch (error) {
            this.#emit("agent_tool:detached:delivery_failed", {
              runId,
              kind,
              status: result.status,
              callback: callbackName,
              error: error instanceof Error ? error.message : String(error)
            });
            await this.#safeOnError(error);
            throw error;
          }
        }
      }
    };

    // Delivery can fire from a queue job or the warm fast path (no ambient
    // turn). The host's `runDetachedDelivery` establishes `agentContext` so a
    // handler that calls runAgentTool / setState / submitMessages works, and —
    // in chat-layer hosts — serializes the delivery against the host turn queue
    // when `serialize` is set, so a state-mutating `onFinish` never interleaves
    // with an active LLM turn (RFC §"run inside a turn"). An explicit cancel
    // runs inline (it is already inside its caller's context).
    await this.#host.runDetachedDelivery(invoke, {
      serialize: options?.serialize
    });

    // Mark delivered only AFTER the handler resolves. A crash before this point
    // leaves the lease to expire and a later reconcile to re-deliver.
    if (kind === "finish") {
      this.#sql`
        UPDATE cf_agent_tool_runs
        SET finish_delivered_at = ${Date.now()}
        WHERE run_id = ${runId}
      `;
    } else {
      this.#sql`
        UPDATE cf_agent_tool_runs
        SET give_up_delivered_at = ${Date.now()}
        WHERE run_id = ${runId}
      `;
    }
  }

  // ── Storage projections ──────────────────────────────────────────────────

  /**
   * Read one run row. The projection is deliberately wide — every column a
   * delivery, replay or milestone decision reads (including
   * `detached_on_milestones`, which the warm-tail milestone delivery keys on)
   * must be present, or that path silently degrades to the backbone tick.
   */
  #readRun(runId: string): AgentToolRunStorageRow | null {
    const rows = this.#sql<AgentToolRunStorageRow>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, interrupted_reason,
             child_still_running, display_metadata, display_order,
             started_at, completed_at, detached, detached_on_finish,
             detached_notify_source, detached_max_budget_at,
             detached_on_milestones,
             finish_claimed_at, finish_delivered_at, give_up_claimed_at,
             give_up_delivered_at
      FROM cf_agent_tool_runs
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /**
   * Rebuild the public result shape from a stored row.
   *
   * @param row The stored row.
   * @returns The same result object a live caller received.
   */
  #resultFromRow<Output>(
    row: AgentToolRunStorageRow
  ): RunAgentToolResult<Output> {
    const output = this.#parseJson(row.output_json) as Output | undefined;
    return {
      runId: row.run_id,
      agentType: row.agent_type,
      status: row.status as RunAgentToolResult<Output>["status"],
      ...(output !== undefined ? { output } : {}),
      ...(row.summary !== null ? { summary: row.summary } : {}),
      ...(row.error_message !== null ? { error: row.error_message } : {}),
      ...this.#interruptedExtrasFromRow(row)
    };
  }

  /**
   * Persist a run's terminal result.
   *
   * `interrupted` is a SOFT terminal — recovery gave up collecting, but the
   * child (a durable facet) may still reach its real terminal. So it is NOT in
   * the guard below: a later child completion (via a re-issue's re-attach,
   * #1630) can repair an `interrupted` row to `completed`/`error`. The three
   * HARD terminals are never overwritten.
   *
   * @param runId The run to settle.
   * @param result The terminal result.
   * @param completedAt Terminal timestamp; defaults to now.
   */
  #updateTerminal<Output>(
    runId: string,
    result: RunAgentToolResult<Output>,
    completedAt = Date.now()
  ): void {
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
    this.#sql`
      UPDATE cf_agent_tool_runs
      SET status = ${result.status},
          summary = ${result.summary ?? null},
          output_json = ${this.#stringifyOutput(result.output)},
          error_message = ${result.error ?? null},
          interrupted_reason = ${result.reason ?? null},
          child_still_running = ${childStillRunning},
          completed_at = ${completedAt}
      WHERE run_id = ${runId}
        AND status NOT IN ('completed', 'error', 'aborted')
    `;
    if (result.status === "completed" && result.output !== undefined) {
      this.#sql`
        UPDATE cf_agent_tool_runs
        SET output_json = COALESCE(output_json, ${this.#stringifyOutput(result.output)}),
            summary = COALESCE(summary, ${result.summary ?? null})
        WHERE run_id = ${runId} AND status = 'completed'
      `;
    }
  }

  // ── Stream forwarding ────────────────────────────────────────────────────

  /**
   * Forward one child tail stream onto the parent's connections as
   * `agent-tool-event` chunk frames.
   *
   * @param stream The child's tail stream (chunk objects or NDJSON bytes).
   * @param parentToolCallId The tool call this run belongs to, when any.
   * @param runId The run being forwarded.
   * @param sequence The broadcast sequence to continue from.
   * @param signal Optional ceiling signal that ends the forward loop.
   * @param idleTimeoutMs Optional resetting no-progress budget.
   * @returns The next free sequence and how the loop ended.
   */
  async #forwardStream(
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
        this.#broadcastEvent(parentToolCallId, next++, {
          kind: "chunk",
          runId,
          body: chunk.body
        });
        // A reserved `data-agent-progress` frame fires the parent `onProgress`
        // hook + refreshes the cached liveness timestamp. Best-effort: never
        // let a progress observation break the forward loop.
        this.#observeForwardedProgress(runId, chunk.body);
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
          // (no-op in the base Agent; chat-recovery hosts override). Kept off
          // the hot per-chunk path — runs once per read iteration and is
          // throttled inside the override. Best-effort: progress crediting is
          // advisory, so a bump failure must never break the child stream the
          // user is watching.
          try {
            await this.#host.onStreamProgress();
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

  /**
   * Replay a child's durably stored chunks onto the parent's clients.
   *
   * @param adapter The child adapter to read chunks from.
   * @param row Identity of the run being replayed.
   * @param sequence The broadcast sequence to continue from.
   * @param replay Mark the frames as a replay.
   * @param connection Send only to this connection instead of broadcasting.
   * @param timeoutMs Bounded wait for the child's chunk read.
   * @param maxChunks Replay only this many chunks from the END of the run. The
   * dropped chunks still advance the sequence, so the frames that are sent keep
   * the numbers an uncapped replay would have given them.
   * @returns The next free sequence.
   */
  async #broadcastStoredChunksFromAdapter(
    adapter: AgentToolChildAdapter,
    row: Pick<AgentToolRunStorageRow, "run_id" | "parent_tool_call_id">,
    sequence: number,
    replay?: true,
    connection?: Connection,
    timeoutMs?: number,
    maxChunks?: number
  ): Promise<number> {
    const chunks = await this.#getChunksForRecovery(
      adapter,
      row.run_id,
      timeoutMs
    );
    if (!chunks) return sequence;
    const kept =
      maxChunks !== undefined &&
      Number.isFinite(maxChunks) &&
      maxChunks < chunks.length
        ? chunks.slice(chunks.length - Math.max(0, Math.floor(maxChunks)))
        : chunks;
    return this.#broadcastChunks(
      row.parent_tool_call_id ?? undefined,
      row.run_id,
      kept,
      sequence + (chunks.length - kept.length),
      replay,
      connection
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────

  get #host(): AgentToolsHost {
    const host = getAgentToolsHost(this);
    if (!host) {
      throw new Error(
        "AgentTools must be installed with setAgentToolsHost() before use"
      );
    }
    return host;
  }

  #maxConcurrent(): number {
    return this.#host.maxConcurrent?.() ?? this.#options.maxConcurrent;
  }

  #maxConcurrentDetached(): number {
    return (
      this.#host.maxConcurrentDetached?.() ??
      this.#options.maxConcurrentDetached
    );
  }

  /**
   * Reject a dispatch that would exceed a concurrency cap: record the terminal
   * `error` row and project the same `started` + `error` pair a client would
   * have seen, without ever resolving (or spawning) a child.
   */
  #rejectDispatch<Output>(
    error: string,
    dispatch: {
      runId: string;
      agentType: string;
      startedAt: number;
      displayOrder: number;
      inputPreview: unknown;
      inputPreviewJson: string | null;
      displayJson: string | null;
      options: RunAgentToolOptions;
    }
  ): RunAgentToolResult<Output> {
    const { runId, agentType, options } = dispatch;
    this.#sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, input_preview,
        status, error_message, display_metadata,
        display_order, started_at, completed_at
      ) VALUES (
        ${runId}, ${options.parentToolCallId ?? null}, ${agentType},
        ${dispatch.inputPreviewJson}, 'error', ${error}, ${dispatch.displayJson},
        ${dispatch.displayOrder}, ${dispatch.startedAt}, ${Date.now()}
      )
    `;
    this.#broadcastEvent(options.parentToolCallId, 0, {
      kind: "started",
      runId,
      agentType,
      inputPreview: dispatch.inputPreview,
      order: dispatch.displayOrder,
      display: options.display
    });
    this.#broadcastEvent(options.parentToolCallId, 1, {
      kind: "error",
      runId,
      error
    });
    return { runId, agentType, status: "error", error };
  }

  #emit(type: string, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }

  #sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.reduce(
      (result, part, index) =>
        result + part + (index < values.length ? "?" : ""),
      ""
    );
    try {
      // SAFETY: every query here selects from this capability's own table; T
      // describes the projected columns of the accompanying query text.
      return [...this.lifecycle.storage.sql.exec(query, ...values)] as T[];
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  #ensureTables(): void {
    const sql = this.lifecycle.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agent_tool_runs (
        run_id TEXT PRIMARY KEY,
        parent_tool_call_id TEXT,
        agent_type TEXT NOT NULL,
        input_preview TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        output_json TEXT,
        error_message TEXT,
        interrupted_reason TEXT,
        child_still_running INTEGER,
        display_metadata TEXT,
        display_order INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        detached INTEGER NOT NULL DEFAULT 0,
        detached_on_finish TEXT,
        detached_notify_source TEXT,
        detached_max_budget_at INTEGER,
        detached_no_progress_budget_ms INTEGER,
        detached_on_milestones TEXT,
        last_progress_at INTEGER,
        finish_claimed_at INTEGER,
        finish_delivered_at INTEGER,
        give_up_claimed_at INTEGER,
        give_up_delivered_at INTEGER
      )
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_parent_tool_call_id
      ON cf_agent_tool_runs(parent_tool_call_id, display_order)
    `);

    // Tables created by an older Agent schema pre-date most of the columns
    // above; add whichever are missing. (`input_redacted`, written but never
    // read, is dropped from new tables and left alone on old ones.)
    const existing = new Set(
      [
        ...sql.exec<{ name: string }>(
          "SELECT name FROM pragma_table_info('cf_agent_tool_runs')"
        )
      ].map((column) => column.name)
    );
    const addColumn = (name: string, definition: string) => {
      if (existing.has(name)) return;
      sql.exec(
        `ALTER TABLE cf_agent_tool_runs ADD COLUMN ${name} ${definition}`
      );
    };
    addColumn("output_json", "TEXT");
    // #1630 follow-up: persist the typed interrupted cause so it survives a
    // reconnect replay (otherwise live clients see `reason`/`childStillRunning`
    // but reconnecting clients replay them as `undefined`).
    addColumn("interrupted_reason", "TEXT");
    addColumn("child_still_running", "INTEGER");
    // Detached ("background") runs (rfc-detached-agent-tools). `detached`
    // marks a run dispatched without an awaiting parent turn;
    // `detached_on_finish` is the parent METHOD NAME to call on terminal
    // (durable, eviction-surviving — like a `schedule` callback);
    // `detached_notify_source` is a caller-controlled chat metadata source for
    // the `notify` sugar; `detached_max_budget_at` is the absolute give-up
    // deadline. The four ledger columns implement a two-slot (finish /
    // give-up) claim+lease so delivery is exactly-once on the happy path and
    // at-least-once under failure — give-up and finish are INDEPENDENT slots
    // so a premature give-up can never dedupe a child's real late completion
    // away (the production incident in #1752).
    addColumn("detached", "INTEGER NOT NULL DEFAULT 0");
    addColumn("detached_on_finish", "TEXT");
    addColumn("detached_notify_source", "TEXT");
    addColumn("detached_max_budget_at", "INTEGER");
    addColumn("finish_claimed_at", "INTEGER");
    addColumn("finish_delivered_at", "INTEGER");
    addColumn("give_up_claimed_at", "INTEGER");
    addColumn("give_up_delivered_at", "INTEGER");
    // Detached progress (rfc-detached-agent-tools §progress). The resetting
    // no-progress window DURATION (not an absolute deadline — it floats with
    // the child's latest signal) and the parent's last-observed signal time.
    // The backbone reconcile reads the child's authoritative `progress.at`
    // via `inspectAgentToolRun`; this cached value is a best-effort liveness
    // hint observed off the warm tail so a still-warm parent does not have to
    // inspect on every tick.
    addColumn("detached_no_progress_budget_ms", "INTEGER");
    addColumn("last_progress_at", "INTEGER");
    // Chat-host `detached: { onMilestones }` convenience (4b): JSON
    // `{ names, mode }` — the milestone names that inject an idempotent chat
    // notification when reached, and whether to "react" (model turn) or
    // "narrate" (synthetic assistant line). Persisted so the cold backbone
    // reconcile can deliver them after eviction, not only the warm tail.
    addColumn("detached_on_milestones", "TEXT");
  }

  async #pushBackbone(cadenceIndex: number): Promise<void> {
    await this.lifecycle.jobs.push({
      id: DETACHED_RECONCILE_JOB_ID,
      fn: DETACHED_RECONCILE_JOB_FN,
      time: Date.now() + DETACHED_BACKBONE_CADENCE_S[cadenceIndex] * 1000,
      payload: { cadenceIndex } satisfies DetachedReconcilePayload,
      singleflight: true
    });
  }

  async #childAdapter<Input = unknown, Output = unknown>(
    agentType: string,
    runId: string
  ): Promise<AgentToolChildAdapter<Input, Output>> {
    const child = await this.#host.resolveChild(agentType, runId);
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
    // SAFETY: the four required adapter methods were just checked; a child
    // facet stub exposes the optional `tailAgentToolRun` as a function too.
    return candidate as AgentToolChildAdapter<Input, Output>;
  }

  /**
   * Parse + validate the `detached` option. Returns `null` for a non-detached
   * run, or the normalized config (with the validated `onFinish` method name)
   * for a detached one. Throws if `onFinish` does not name a method on the
   * host — closures cannot survive Durable Object eviction, so the durable
   * hook is referenced by method name (the same contract as `schedule`).
   */
  #parseDetachedOption(detached: RunAgentToolOptions["detached"]): {
    onFinishName?: string;
    maxBudgetMs?: number;
    noProgressBudgetMs?: number;
    notifySource?: string;
    onMilestones?: { names: string[]; mode: "react" | "narrate" };
  } | null {
    if (!detached) return null;
    if (detached === true) return {};
    let onFinishName = detached.onFinish as string | undefined;
    const notifySource =
      typeof detached.notify === "object" ? detached.notify.source : undefined;
    if (onFinishName !== undefined) {
      if (!this.#host.resolveCallback(onFinishName)) {
        throw new Error(
          `runAgentTool: detached.onFinish "${onFinishName}" is not a method on this agent. ` +
            'Pass the NAME of a method (e.g. "onImportDone"), not a closure — ' +
            "closures cannot be rehydrated after the Durable Object is evicted."
        );
      }
    } else if (detached.notify) {
      // `notify` sugar: auto-target the chat-agent notify hook if present.
      // A no-op on a base Agent that does not implement it.
      if (this.#host.resolveCallback(DETACHED_NOTIFY_CALLBACK)) {
        onFinishName = DETACHED_NOTIFY_CALLBACK;
      }
    }
    return {
      ...(onFinishName !== undefined ? { onFinishName } : {}),
      ...(notifySource !== undefined ? { notifySource } : {}),
      ...(detached.maxBudgetMs !== undefined
        ? { maxBudgetMs: detached.maxBudgetMs }
        : {}),
      ...(detached.noProgressBudgetMs !== undefined
        ? { noProgressBudgetMs: detached.noProgressBudgetMs }
        : {}),
      ...(() => {
        const raw = detached.onMilestones;
        if (!raw) return {};
        const names = Array.isArray(raw) ? raw : raw.names;
        if (!Array.isArray(names) || names.length === 0) return {};
        const mode: "react" | "narrate" = Array.isArray(raw)
          ? "narrate"
          : (raw.mode ?? "narrate");
        return { onMilestones: { names, mode } };
      })()
    };
  }

  #isHardTerminal(status: AgentToolRunStatus): boolean {
    return status === "completed" || status === "error" || status === "aborted";
  }

  #isTerminal(status: string): boolean {
    return (
      status === "completed" ||
      status === "error" ||
      status === "aborted" ||
      status === "interrupted"
    );
  }

  /** Detached runs still holding a concurrency slot (non-terminal). */
  #liveDetachedRunCount(): number {
    const rows = this.#sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE detached = 1 AND status IN ('starting', 'running')
    `;
    return rows[0]?.n ?? 0;
  }

  /**
   * Edge-triggered warning when live detached runs cross
   * `DETACHED_LIVE_COUNT_WARN_THRESHOLD`. Fires once on the up-crossing and
   * re-arms only after the count falls back below the threshold, so a parent
   * accumulating long-lived background runs surfaces a signal without spamming.
   */
  #maybeWarnDetachedLiveCount(): void {
    const liveCount = this.#liveDetachedRunCount();
    if (liveCount < DETACHED_LIVE_COUNT_WARN_THRESHOLD) {
      this.#detachedLiveCountWarned = false;
      return;
    }
    if (this.#detachedLiveCountWarned) return;
    this.#detachedLiveCountWarned = true;
    this.#emit("agent_tool:detached:live_count_warning", {
      liveCount,
      threshold: DETACHED_LIVE_COUNT_WARN_THRESHOLD
    });
    console.warn(
      `[agents] ${liveCount} detached agent-tool runs are live on this agent (threshold ${DETACHED_LIVE_COUNT_WARN_THRESHOLD}). Detached runs hold a concurrency slot until they finish — make sure they are completing or being cancelled, or set \`maxConcurrentDetachedAgentTools\` to bound background work.`
    );
  }

  /**
   * Warm fast path for a detached run: tail the child to terminal (so the
   * parent re-broadcasts its live stream to clients) and deliver the completion
   * with low latency while the isolate stays alive. Best-effort — the durable
   * reconcile backbone job is the guarantee; anything this misses (eviction, a
   * child that has not yet reached terminal) the backbone collects.
   */
  async #detachedFastPath<Input, Output>(
    runInfo: AgentToolRunInfo,
    agentType: string,
    runId: string
  ): Promise<void> {
    try {
      const adapter = await this.#childAdapter<Input, Output>(agentType, runId);
      let sequence = 1;
      if (adapter.tailAgentToolRun) {
        const stream = await adapter.tailAgentToolRun(runId, {
          afterSequence: -1
        });
        sequence = (
          await this.#forwardStream(
            stream,
            runInfo.parentToolCallId,
            runId,
            sequence,
            undefined
          )
        ).next;
      }
      const inspection = await adapter.inspectAgentToolRun(runId);
      if (
        inspection &&
        this.#isHardTerminal(inspection.status as AgentToolRunStatus)
      ) {
        const result = this.#terminalResultFromInspection<Output>(
          runInfo.agentType,
          inspection
        );
        await this.#deliverDetachedTerminal(
          runId,
          "finish",
          result,
          { sequence, serialize: true },
          inspection.completedAt
        );
      }
    } catch {
      // Leave it to the backbone reconcile.
    }
  }

  async #safeOnError(error: unknown): Promise<void> {
    try {
      await this.#host.onError(error);
    } catch {
      // Delivery hooks are best-effort; a failing onError must not wedge the
      // ledger or other detached runs.
    }
  }

  #activeRunCount(): number {
    const rows = this.#sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE status IN ('starting', 'running')
    `;
    return rows[0]?.n ?? 0;
  }

  #defaultPreview(input: unknown): unknown {
    if (typeof input === "string") return input.slice(0, 500);
    if (input === null || input === undefined) return input;
    try {
      const json = JSON.stringify(input);
      return json.length > 500 ? `${json.slice(0, 497)}...` : json;
    } catch {
      return String(input).slice(0, 500);
    }
  }

  /**
   * Reconstruct the typed interrupted cause (`reason` / `childStillRunning`,
   * #1630 follow-up) from a stored row so a row→result/event rebuild — e.g. a
   * reconnect replay — carries the same fields a live client saw. Only
   * `interrupted` rows store a cause; everything else yields `{}` (the columns
   * are cleared whenever a row settles to a hard terminal).
   */
  #interruptedExtrasFromRow(row: {
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

  #runInfoFromRow(
    row: AgentToolRunStorageRow,
    status: AgentToolRunStatus = row.status,
    completedAt = row.completed_at ?? undefined
  ): AgentToolRunInfo {
    return {
      runId: row.run_id,
      parentToolCallId: row.parent_tool_call_id ?? undefined,
      agentType: row.agent_type,
      inputPreview: this.#parseJson(row.input_preview),
      status,
      display: this.#parseJson(row.display_metadata) as
        | AgentToolDisplayMetadata
        | undefined,
      ...(row.detached_notify_source != null
        ? { notifySource: row.detached_notify_source }
        : {}),
      displayOrder: row.display_order,
      startedAt: row.started_at,
      completedAt
    };
  }

  #terminalResultFromInspection<Output>(
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

  async #finishRun<Output>(
    run: AgentToolRunInfo,
    result: RunAgentToolResult<Output>,
    options?: {
      sequence?: number;
      completedAt?: number;
      deferFinishHook?: boolean;
    }
  ): Promise<DeferredAgentToolFinish | undefined> {
    const completedAt = options?.completedAt ?? Date.now();
    this.#updateTerminal(run.runId, result, completedAt);
    if (options?.sequence !== undefined) {
      this.#broadcastTerminal(run.parentToolCallId, options.sequence, result);
    }
    const finish = () =>
      this.#host.onAgentToolFinish(
        { ...run, status: result.status, completedAt },
        result
      );
    if (options?.deferFinishHook) return finish;
    await finish();
    return undefined;
  }

  #markRunning(runId: string): void {
    this.#sql`
      UPDATE cf_agent_tool_runs
      SET status = 'running'
      WHERE run_id = ${runId} AND status = 'starting'
    `;
  }

  #parseJson(value: string | null): unknown {
    if (value === null) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  #stringifyOutput(output: unknown): string | null {
    if (output === undefined) return null;
    const json = JSON.stringify(output);
    return json === undefined ? null : json;
  }

  #broadcastEvent(
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
      this.#host.broadcast(body);
    }
  }

  #broadcastChunks(
    parentToolCallId: string | undefined,
    runId: string,
    chunks: AgentToolStoredChunk[],
    sequence: number,
    replay?: true,
    connection?: Connection
  ): number {
    let next = sequence;
    for (const chunk of chunks) {
      this.#broadcastEvent(
        parentToolCallId,
        next++,
        { kind: "chunk", runId, body: chunk.body },
        replay,
        connection
      );
    }
    return next;
  }

  async #broadcastStoredChunks(
    row: Pick<
      AgentToolRunStorageRow,
      "run_id" | "agent_type" | "parent_tool_call_id"
    >,
    sequence: number,
    replay?: true,
    connection?: Connection,
    maxChunks?: number
  ): Promise<number> {
    const adapter = await this.#childAdapter(row.agent_type, row.run_id);
    return this.#broadcastStoredChunksFromAdapter(
      adapter,
      row,
      sequence,
      replay,
      connection,
      undefined,
      maxChunks
    );
  }

  #broadcastTerminal<Output>(
    parentToolCallId: string | undefined,
    sequence: number,
    result: RunAgentToolResult<Output>,
    replay?: true,
    connection?: Connection
  ): void {
    if (result.status === "completed") {
      this.#broadcastEvent(
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
      this.#broadcastEvent(
        parentToolCallId,
        sequence,
        { kind: "aborted", runId: result.runId, reason: result.error },
        replay,
        connection
      );
    } else if (result.status === "interrupted") {
      this.#broadcastEvent(
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
      this.#broadcastEvent(
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

  /**
   * Best-effort observation of a forwarded child chunk: if it is a reserved
   * `data-agent-progress` frame, refresh the cached liveness timestamp on the
   * run row (a hint for a still-warm parent) and fire the public `onProgress`
   * hook. Never throws into the forward loop — the child's own persisted
   * snapshot (read via `inspectAgentToolRun`) remains authoritative for the
   * resetting no-progress budget after eviction.
   */
  #observeForwardedProgress(runId: string, body: string): void {
    let parsed:
      | {
          type?: unknown;
          data?: AgentToolProgress & {
            name?: string;
            sequence?: number;
            at?: number;
          };
        }
      | undefined;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    if (!parsed) return;
    const isMilestone = parsed.type === AGENT_TOOL_MILESTONE_PART;
    if (parsed.type !== AGENT_TOOL_PROGRESS_PART && !isMilestone) return;
    const data = parsed.data ?? {};
    const at = Date.now();
    const snapshot: AgentToolProgressSnapshot = {
      ...(typeof data.fraction === "number" ? { fraction: data.fraction } : {}),
      ...(typeof data.message === "string" ? { message: data.message } : {}),
      ...(typeof data.phase === "string" ? { phase: data.phase } : {}),
      ...(isMilestone && typeof data.name === "string"
        ? { milestone: data.name }
        : {}),
      ...(data.data !== undefined ? { data: data.data } : {}),
      at
    };
    const row = this.#readRun(runId);
    if (!row) return;
    // The cached liveness timestamp only feeds the DETACHED no-progress budget;
    // skip the write for awaited runs (the `onProgress` hook still fires below).
    if (row.detached) {
      try {
        this.#sql`
          UPDATE cf_agent_tool_runs SET last_progress_at = ${at}
          WHERE run_id = ${runId}
        `;
      } catch {
        // Row may have settled / been pruned; the hook still fires below.
      }
    }
    const runInfo = this.#runInfoFromRow(row);
    void Promise.resolve(this.#host.onProgress(runInfo, snapshot)).catch(
      (error) => {
        console.error(
          `[agents] onProgress hook threw for run ${runId}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    );
    // Chat-host `detached: { onMilestones }` convenience: when a CONFIGURED
    // milestone lands on the warm path, deliver its idempotent notification.
    // The cold backbone reconcile delivers the same set after eviction; the
    // idempotency key makes the two paths converge to at-most-once.
    if (isMilestone && typeof data.name === "string") {
      this.#maybeDeliverMilestone(row, runInfo, {
        name: data.name,
        sequence: typeof data.sequence === "number" ? data.sequence : 0,
        at: typeof data.at === "number" ? data.at : at,
        ...(data.data !== undefined ? { data: data.data } : {})
      });
    }
  }

  /**
   * Deliver a milestone notification IF this run opted into it via
   * `detached: { onMilestones }` and the milestone name is in that set. Routes
   * to the host's `deliverDetachedMilestone` seam (a no-op on a base Agent;
   * chat hosts inject an idempotent synthetic chat message).
   */
  #maybeDeliverMilestone(
    row: AgentToolRunStorageRow,
    runInfo: AgentToolRunInfo,
    milestone: AgentToolMilestone
  ): void {
    // Stored as `{ names, mode }`; tolerate a bare-array legacy/manual value.
    const configured = this.#parseJson(row.detached_on_milestones ?? null) as
      | string[]
      | { names?: string[]; mode?: "react" | "narrate" }
      | undefined;
    const names = Array.isArray(configured) ? configured : configured?.names;
    const mode = Array.isArray(configured)
      ? "narrate"
      : (configured?.mode ?? "narrate");
    if (!Array.isArray(names) || !names.includes(milestone.name)) {
      return;
    }
    void Promise.resolve(
      this.#host.deliverDetachedMilestone(runInfo, milestone, mode)
    ).catch((error) => {
      console.error(
        `[agents] detached milestone delivery threw for run ${runInfo.runId} (${milestone.name}):`,
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  async #replayAndInterrupt<Output>(
    row: AgentToolRunStorageRow,
    message: string,
    extra?: { reason?: AgentToolInterruptedReason; childStillRunning?: boolean }
  ): Promise<RunAgentToolResult<Output>> {
    let sequence = 1;
    try {
      sequence = await this.#broadcastStoredChunks(row, sequence);
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
    await this.#finishRun(this.#runInfoFromRow(row), result, { sequence });
    return result;
  }

  /**
   * Human-readable prose for an `interrupted` seal. Kept in sync with
   * `AgentToolInterruptedReason`; callers branch on the typed `reason` field,
   * not this string.
   */
  #interruptedMessageForReason(
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
  async #teardownGivenUpChild(
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

  async #inspectForRecovery(
    row: AgentToolRunStorageRow,
    timeoutMs = DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS
  ): Promise<AgentToolRecoveryInspection> {
    const inspect = (async (): Promise<AgentToolRecoveryInspection> => {
      const adapter = await this.#childAdapter(row.agent_type, row.run_id);
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

  async #getChunksForRecovery(
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
