/**
 * The parent side of agent-tool runs: start a run on a child agent, follow
 * its stream, cancel it, and read and retain its result.
 *
 * A Lifecycle capability: it owns `cf_agent_tool_runs` and its migrations
 * (under its own schema version key), two jobs (startup recovery, and the
 * detached backbone), and the `/agent-tool-runs/{runId}` drill-in route.
 *
 * Durable: the run row (status, result, display, the detached delivery
 * ledger, the child's name) and the backbone job. The child keeps its own
 * run row, transcript and stream. In memory: the live tail from the child
 * and the no-progress watch; a broken tail is re-opened from the child's
 * record.
 *
 * `Agent` installs one and delegates its public agent-tool methods here.
 * The developer hooks (`onAgentToolStart`, `onAgentToolFinish`,
 * `onProgress`, a detached run's `onFinish`) stay on the agent and are
 * called through {@link AgentRunsHooks}.
 *
 * @internal Not a public API.
 */

import { nanoid } from "nanoid";
import type { Agent } from "../index";
import type { Connection } from "../lifecycle/durable-object-lifecycle";
import {
  AGENT_TOOL_MILESTONE_PART,
  AGENT_TOOL_PROGRESS_PART,
  isAgentToolLifecycleChunk,
  type AgentToolChildAdapter,
  type AgentToolDisplayMetadata,
  type AgentToolEvent,
  type AgentToolEventMessage,
  type AgentToolInterruptedReason,
  type AgentToolLifecycleResult,
  type AgentToolMilestone,
  type AgentToolProgress,
  type AgentToolProgressSnapshot,
  type AgentToolRunInfo,
  type AgentToolRunInspection,
  type AgentToolRunStatus,
  type AgentToolStoredChunk,
  type ChatCapableAgentClass,
  type DetachedRunAgentToolResult,
  type RunAgentToolOptions,
  type RunAgentToolResult
} from "../agent-tool-types";
import { LifecycleCapability } from "../lifecycle/capability";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import type {
  CapabilityRequestContext,
  CapabilityWebSocketUpgradeContext
} from "../lifecycle/capability-runner";
import {
  agentToolChildStub,
  forwardAgentToolRunRequest,
  type AgentToolChildStub,
  type AgentToolRunChildAddress
} from "./child";

/** @internal The agent-tool budgets an agent resolves from its static `options`. */
export type AgentRunsBudgets = {
  agentToolReattachNoProgressTimeoutMs: number;
  agentToolReattachMaxWindowMs: number;
  detachedMaxBudgetMs: number;
  detachedNoProgressBudgetMs: number;
};

/** @internal A detached run's `onFinish` method, found by the name stored on its row. */
export type DetachedRunMethod = (
  run: AgentToolRunInfo,
  result: AgentToolLifecycleResult
) => Promise<void>;

/**
 * @internal The hooks of the agent that installs {@link AgentRuns}: what a developer
 * overrides, and the seams chat agents use to order detached deliveries
 * with their turns.
 */
export interface AgentRunsHooks {
  onAgentToolStart(run: AgentToolRunInfo): Promise<void>;
  onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void>;
  onProgress(
    run: AgentToolRunInfo,
    progress: AgentToolProgressSnapshot
  ): Promise<void>;
  onError(error: unknown): unknown;
  /** The agent's limit on open runs. */
  maxConcurrentAgentTools(): number;
  /**
   * Send an `agent-tool-event` frame to the agent's clients, through the
   * agent's own `broadcast` so an override sees it.
   */
  broadcast(message: string): void;
  /** The agent's method of that name, for a detached run's `onFinish`. */
  detachedMethod(name: string): DetachedRunMethod | undefined;
  /**
   * Run a detached delivery. `serialize` asks a chat agent to order it
   * after its active turn.
   */
  runDetachedDelivery(
    invoke: () => Promise<void>,
    options?: { serialize?: boolean }
  ): Promise<void>;
  /** A detached run reached a milestone it asked to be told about. */
  deliverDetachedMilestone(
    run: AgentToolRunInfo,
    milestone: AgentToolMilestone,
    mode: "react" | "narrate"
  ): Promise<void>;
  /** A child's forwarded chunk: progress for the parent's own turn. */
  onStreamProgress(): Promise<void>;
  /** Delete a sub-agent an earlier version kept as a facet. */
  deleteLegacySubAgent(className: string, name: string): Promise<void>;
}

/** @internal What an agent passes when it installs {@link AgentRuns}. */
export type AgentRunsOptions = {
  /** The agent's state, for `ctx.exports` (child namespaces) and `waitUntil`. */
  ctx: DurableObjectState;
  hooks: AgentRunsHooks;
  /** Read on each use, so a change to the agent's options is seen. */
  budgets: () => AgentRunsBudgets;
};

const DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS = 2_000;

/** The error of an open run whose child was a facet (before child names). */
const FACET_ERA_AGENT_TOOL_RUN_ERROR =
  "This agent tool run was started by an earlier version of the agents SDK, which ran its child as a facet. It cannot be followed after the upgrade; run it again.";

const DEFAULT_AGENT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS = 5_000;

// How long a detached terminal-delivery claim is leased before another delivery
// path (a backbone reconcile racing the warm fast path, or a re-delivery after
// a crash mid-handler) may re-claim it. Guards against a double-fire on the
// happy path while guaranteeing at-least-once delivery under failure.
const DETACHED_DELIVERY_LEASE_MS = 60_000;

// Escalating cadence for the self-scheduling detached reconcile backbone. The
// warm fast path makes the first entries near-moot; these bound worst-case
// post-eviction latency while keeping steady-state alarm cost low. The schedule
// cancels itself once no detached run remains outstanding.
const DETACHED_BACKBONE_CADENCE_S = [5, 15, 30, 120];

// Detached runs hold a `maxConcurrentAgentTools` slot for their ENTIRE life and
// have no observer to notice them piling up. With the default `Infinity` cap
// that is a real leak footgun, so the framework emits an edge-triggered warning
// when the live (non-terminal) detached count first crosses this threshold,
// rather than silently accumulating. (A separate `maxConcurrentDetachedAgentTools`
// cap is deferred until evidence shows the single cap conflates two budgets.)
const DETACHED_LIVE_COUNT_WARN_THRESHOLD = 50;

/** The backbone's Lifecycle job, and where its cadence step is kept. */
const BACKBONE_JOB_ID = "detached-reconcile";
const BACKBONE_JOB_FN = "reconcile";
const BACKBONE_CADENCE_KEY = "cf_agents:agent_runs:backbone_cadence";
/** The Lifecycle job that runs startup recovery once startup has finished. */
const RECOVERY_JOB_FN = "recover";
/** Version of the `cf_agent_tool_runs` schema this capability last applied. */
const SCHEMA_VERSION_KEY = "cf_agents:agent_runs:schema_version";
const SCHEMA_VERSION = 1;

// Conventional method name a chat agent (Think / AIChatAgent) implements to
// receive `detached: { notify: true }` completions. Resolved by name so the
// base Agent stays decoupled from the chat layer.
const DETACHED_NOTIFY_CALLBACK = "_cfDetachedNotifyFinish";

type AgentToolRecoveryInspection =
  | {
      status: "inspected";
      adapter: AgentToolChildAdapter;
      inspection: AgentToolRunInspection | null;
    }
  | { status: "failed" }
  | { status: "timed-out" };

type AgentToolRunStorageRow = {
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
  child_name?: string | null;
};

type DeferredAgentToolFinish = () => Promise<void>;

/** @internal The payload of a backbone schedule row an earlier version armed. */
export type DetachedReconcilePayload = { cadenceIndex?: number };

export class AgentRuns extends LifecycleCapability {
  /** Startup recovery in flight, so a second start joins it. */
  private _agentToolRunRecoveryPromise: Promise<void> | undefined;
  /** Whether the live detached-run count warning has fired. */
  private _detachedLiveCountWarned = false;
  private readonly ctx: DurableObjectState;
  private readonly hooks: AgentRunsHooks;
  private readonly budgets: () => AgentRunsBudgets;

  constructor(options: AgentRunsOptions) {
    super("agent-runs");
    this.ctx = options.ctx;
    this.hooks = options.hooks;
    this.budgets = options.budgets;
  }

  /**
   * Bring the run table up to date, then recover the runs an earlier
   * isolate left open. Recovery runs as a job, after startup has finished,
   * so it never holds startup and finish hooks run after the agent's own
   * `onStart`. Only runs open now are recovered: a run the agent's
   * `onStart` starts is not.
   */
  override async onStart(): Promise<void> {
    this.ensureTable();
    const runIds = this._agentToolRunRecoveryRunIds();
    if (
      runIds.length > 0 ||
      this._hasFacetEraAgentToolRuns() ||
      this._hasOutstandingDetachedRuns()
    ) {
      await this.lifecycle.jobs.push({
        id: RECOVERY_JOB_FN,
        fn: RECOVERY_JOB_FN,
        time: Date.now(),
        payload: { runIds }
      });
    }
  }

  async onJob({
    job
  }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (job.fn === BACKBONE_JOB_FN) {
      const next = await this._cfDetachedReconcileTick();
      return next === undefined ? undefined : { rescheduleAt: next };
    }
    if (job.fn === RECOVERY_JOB_FN) {
      const payload = job.payload as { runIds?: unknown } | null;
      const runIds = Array.isArray(payload?.runIds)
        ? payload.runIds.filter((id): id is string => typeof id === "string")
        : undefined;
      // Recovery can follow a child for as long as its turn takes: hand it
      // off instead of holding the alarm.
      void this._scheduleAgentToolRunRecovery({ runIds });
    }
    return undefined;
  }

  /** `/agent-tool-runs/{runId}/...`: forward to the run's child. */
  onRequest({
    request
  }: CapabilityRequestContext): Promise<Response | undefined> {
    return this.#forward(request);
  }

  /** The same for an upgrade: after it, the child owns the socket. */
  onWebSocketUpgrade({
    request
  }: CapabilityWebSocketUpgradeContext): Promise<Response | undefined> {
    return this.#forward(request);
  }

  #forward(request: Request): Promise<Response | undefined> {
    return forwardAgentToolRunRequest(this.ctx, request, (runId) =>
      this.#childAddress(runId)
    );
  }

  /** Where a run's child is, for a drill-in (see {@link AgentToolRunChildAddress}). */
  #childAddress(runId: string): AgentToolRunChildAddress {
    const [row] = this.sql<{
      agent_type: string;
      child_name: string | null;
      child_name_minted: number | null;
    }>`
      SELECT agent_type, child_name, child_name_minted
      FROM cf_agent_tool_runs WHERE run_id = ${runId}
    `;
    if (!row) return null;
    if (row.child_name) {
      return { className: row.agent_type, childName: row.child_name };
    }
    // A run refused at dispatch records that it has no child; a row from
    // when children were facets predates the column.
    return row.child_name_minted === 0 ? "never-started" : "facet-era";
  }

  /**
   * Create `cf_agent_tool_runs` and add the columns later versions need,
   * under this capability's own schema version.
   */
  ensureTable(): void {
    const { storage } = this.lifecycle;
    if ((storage.kv.get<number>(SCHEMA_VERSION_KEY) ?? 0) >= SCHEMA_VERSION) {
      return;
    }
    const addColumnIfNotExists = (sql: string) => {
      try {
        storage.sql.exec(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("duplicate column")) throw error;
      }
    };
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_tool_runs (
        run_id TEXT PRIMARY KEY,
        parent_tool_call_id TEXT,
        agent_type TEXT NOT NULL,
        input_preview TEXT,
        input_redacted INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        summary TEXT,
        output_json TEXT,
        error_message TEXT,
        interrupted_reason TEXT,
        child_still_running INTEGER,
        display_metadata TEXT,
        display_order INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_parent_tool_call_id
      ON cf_agent_tool_runs(parent_tool_call_id, display_order)
    `;

    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN output_json TEXT"
    );
    // #1630 follow-up: persist the typed interrupted cause so it survives a
    // reconnect replay (otherwise live clients see `reason`/`childStillRunning`
    // but reconnecting clients replay them as `undefined`).
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN interrupted_reason TEXT"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN child_still_running INTEGER"
    );
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
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN detached INTEGER NOT NULL DEFAULT 0"
    );
    // The name of the run's child Durable Object, minted with the row. A
    // row without one is from when the child was a facet.
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN child_name TEXT"
    );
    // 1 when the parent minted `child_name`, 0 when the caller chose it:
    // only a minted child is destroyed with its last run.
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN child_name_minted INTEGER"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN detached_on_finish TEXT"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN detached_notify_source TEXT"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN detached_max_budget_at INTEGER"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN finish_claimed_at INTEGER"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN finish_delivered_at INTEGER"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN give_up_claimed_at INTEGER"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN give_up_delivered_at INTEGER"
    );
    // Detached progress (rfc-detached-agent-tools §progress). The resetting
    // no-progress window DURATION (not an absolute deadline — it floats with
    // the child's latest signal) and the parent's last-observed signal time.
    // The backbone reconcile reads the child's authoritative `progress.at`
    // via `inspectAgentToolRun`; this cached value is a best-effort liveness
    // hint observed off the warm tail so a still-warm parent does not have to
    // inspect on every tick.
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN detached_no_progress_budget_ms INTEGER"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN last_progress_at INTEGER"
    );
    // Chat-host `detached: { onMilestones }` convenience (4b): JSON
    // `{ names, mode }` — the milestone names that inject an idempotent chat
    // notification when reached, and whether to "react" (model turn) or
    // "narrate" (synthetic assistant line). Persisted so the cold backbone
    // reconcile can deliver them after eviction, not only the warm tail.
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN detached_on_milestones TEXT"
    );
    // `runAgentTool({ eventDelivery: "terminal" })`: NULL means "full".
    addColumnIfNotExists(
      "ALTER TABLE cf_agent_tool_runs ADD COLUMN event_delivery TEXT"
    );
    storage.kv.put(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
  }

  /** A tagged SQL query over this agent's storage. */
  private sql<T = Record<string, SqlStorageValue>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.reduce(
      (acc, part, i) => acc + part + (i < values.length ? "?" : ""),
      ""
    );
    return this.lifecycle.storage.sql.exec(query, ...values).toArray() as T[];
  }

  async runAgentTool<Input = unknown, Output = unknown>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input>
  ): Promise<RunAgentToolResult<Output> | DetachedRunAgentToolResult> {
    const runId = options.runId ?? nanoid(12);
    const agentType = cls.name;
    const detached = this._parseDetachedOption(options.detached);
    const eventDelivery = options.eventDelivery ?? "full";
    if (eventDelivery !== "full" && eventDelivery !== "terminal") {
      throw new Error(
        `runAgentTool: eventDelivery must be "full" or "terminal", got ${JSON.stringify(eventDelivery)}.`
      );
    }
    if (detached && eventDelivery === "terminal") {
      throw new Error(
        'runAgentTool: eventDelivery "terminal" is not supported for detached runs.'
      );
    }

    let existing = this._readAgentToolRun(runId);
    if (existing && !this._isAgentToolRowHardTerminal(existing.status)) {
      // A run from when the child was a facet cannot be followed: it ends
      // `error` here, and is returned like any finished run.
      await this._runDeferredAgentToolFinishHooks(
        await this._failFacetEraAgentToolRuns(runId)
      );
      existing = this._readAgentToolRun(runId);
    }
    if (existing) {
      // Detached re-dispatch (e.g. chat recovery re-running the dispatching
      // turn) is idempotent by runId: re-arm the durable backbone for a still
      // non-terminal run and hand back the live handle instead of re-tailing or
      // spawning fresh work. A run that already reached terminal simply returns
      // a running-shaped handle — its delivery already happened (or is owned by
      // the ledger).
      if (detached) {
        if (!this._isAgentToolRowHardTerminal(existing.status)) {
          await this._armDetachedBackbone();
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
            const child = await this._agentToolChild(agentType, runId);
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
        const child = await this._agentToolChild(agentType, runId);
        const adapter = this._asAgentToolChildAdapter<Input, Output>(child);
        const reattach = await this._reattachAgentToolRunToTerminal<Output>(
          adapter,
          existing,
          1,
          this.budgets().agentToolReattachNoProgressTimeoutMs,
          this.budgets().agentToolReattachMaxWindowMs
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
      this._activeAgentToolRunCount() >= this.hooks.maxConcurrentAgentTools()
    ) {
      const error = `maxConcurrentAgentTools (${this.hooks.maxConcurrentAgentTools()}) exceeded`;
      this.sql`
        INSERT INTO cf_agent_tool_runs (
          run_id, parent_tool_call_id, agent_type, input_preview,
          input_redacted, status, error_message, display_metadata,
          display_order, started_at, completed_at, child_name_minted
        ) VALUES (
          ${runId}, ${options.parentToolCallId ?? null}, ${agentType},
          ${inputPreviewJson}, 1, 'error', ${error}, ${displayJson},
          ${displayOrder}, ${startedAt}, ${Date.now()}, 0
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

    const detachedMaxBudgetAt = detached
      ? startedAt + (detached.maxBudgetMs ?? this.budgets().detachedMaxBudgetMs)
      : null;
    const detachedNoProgressBudgetMs = detached
      ? (detached.noProgressBudgetMs ??
        this.budgets().detachedNoProgressBudgetMs)
      : null;
    const detachedOnMilestonesJson = detached?.onMilestones
      ? JSON.stringify(detached.onMilestones)
      : null;
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, input_preview,
        input_redacted, status, display_metadata, display_order, started_at,
        detached, detached_on_finish, detached_notify_source,
        detached_max_budget_at, detached_no_progress_budget_ms,
        detached_on_milestones, event_delivery, child_name,
        child_name_minted
      ) VALUES (
        ${runId}, ${options.parentToolCallId ?? null}, ${agentType},
        ${inputPreviewJson}, 1, 'starting', ${displayJson}, ${displayOrder},
        ${startedAt}, ${detached ? 1 : 0}, ${detached?.onFinishName ?? null},
        ${detached?.notifySource ?? null}, ${detachedMaxBudgetAt},
        ${detachedNoProgressBudgetMs}, ${detachedOnMilestonesJson},
        ${eventDelivery === "terminal" ? "terminal" : null},
        ${options.childName ?? crypto.randomUUID()},
        ${options.childName === undefined ? 1 : 0}
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
    await this.hooks.onAgentToolStart(runInfo);
    this._broadcastAgentToolEvent(options.parentToolCallId, 0, {
      kind: "started",
      runId,
      agentType,
      inputPreview,
      order: displayOrder,
      display: options.display
    });

    const child = await this._agentToolChild(agentType, runId);
    // Replaced with a fresh stub when the child's isolate goes away under
    // the tail.
    let adapter = this._asAgentToolChildAdapter<Input, Output>(child);
    let childStart: AgentToolRunInspection<Output> | undefined;
    // Set when the start call itself failed. The child may still have
    // started the run (its isolate went away under the call): an awaited
    // run asks the child below, like a run whose tail broke.
    let startFailure: { error: unknown } | undefined;
    try {
      childStart = await adapter.startAgentToolRun(options.input, {
        runId,
        ...(eventDelivery === "terminal" ? { eventDelivery } : {})
      });
    } catch (error) {
      if (detached) throw error;
      startFailure = { error };
    }
    this._markAgentToolRunning(runId);

    if (detached) {
      // The child must OUTLIVE the dispatching turn, so a detached run never
      // inherits `options.signal` (which aborts when this turn ends). Cancel a
      // detached run explicitly with `cancelAgentTool(runId)`.
      if (options.signal) {
        console.warn(
          `[agents] runAgentTool: \`signal\` is ignored for a detached run (${runId}); a detached child must outlive the spawning turn. Use cancelAgentTool(runId) to cancel it.`
        );
      }
      // Arm the durable backbone first so eviction between here and the fast
      // path still finalizes the run, then kick the warm fast path that tails
      // the child to terminal and delivers with low latency while alive.
      await this._armDetachedBackbone({ resetCadence: true });
      // Surface runaway accumulation: detached runs hold a slot for their whole
      // life with no observer to notice a leak.
      this._maybeWarnDetachedLiveCount();
      this.ctx.waitUntil(this._detachedFastPath<Input, Output>(runInfo, runId));
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
        await this._finishAgentToolRun(runInfo, result, { sequence });
        return result;
      } else {
        parentAbortListener = () => {
          void adapter
            .cancelAgentToolRun(runId, options.signal?.reason)
            .catch(() => {});
        };
        options.signal.addEventListener("abort", parentAbortListener, {
          once: true
        });
      }
    }

    try {
      // The tail is an RPC stream from the child. It breaks when the child's
      // isolate goes away under it (an eviction, a reset), which says
      // nothing about the run: the child's chat recovery may be finishing
      // its turn. The run's row decides, below.
      let tailBroke = startFailure !== undefined;
      // The tail ends when the child closes it, and the child closes it
      // when the run ends. A run nothing will end (its turn's recovery was
      // dropped, say) would hold this call for good. So the parent also
      // asks: every no-progress window it inspects the run, which makes
      // the child settle a run that has nothing left to finish it, and
      // stops following a tail whose run has ended.
      const watch = this._watchAgentToolRunWhileTailing(() => adapter, runId);
      // How far the tail got, also when it breaks: what follows a re-attach
      // is numbered after it.
      const cursor = { next: sequence };
      try {
        if (startFailure) throw startFailure.error;
        if (adapter.tailAgentToolRun) {
          const stream = await adapter.tailAgentToolRun(runId, {
            afterSequence: -1
          });
          await this._forwardAgentToolStream(
            stream,
            options.parentToolCallId,
            runId,
            sequence,
            options.signal
              ? AbortSignal.any([options.signal, watch.ended])
              : watch.ended,
            undefined,
            cursor
          );
          sequence = cursor.next;
        } else {
          const chunks = await adapter.getAgentToolChunks(runId);
          sequence = this._broadcastAgentToolChunks(
            options.parentToolCallId,
            runId,
            chunks,
            sequence
          );
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        tailBroke = true;
        sequence = cursor.next;
        // The old stub may still name the instance that went away.
        adapter = this._asAgentToolChildAdapter<Input, Output>(
          await this._agentToolChild(agentType, runId)
        );
      } finally {
        watch.stop();
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

      const inspected = await adapter.inspectAgentToolRun(runId);
      if (
        tailBroke &&
        (inspected?.status === "running" || inspected?.status === "starting")
      ) {
        // The child still has the run open: it is recovering the turn. Wait
        // for it the way a recovered parent does, within the same budgets,
        // and hand back the run's own terminal status.
        const reattach = await this._reattachAgentToolRunToTerminal<Output>(
          adapter,
          {
            run_id: runId,
            agent_type: agentType,
            parent_tool_call_id: options.parentToolCallId ?? null
          },
          sequence,
          this.budgets().agentToolReattachNoProgressTimeoutMs,
          this.budgets().agentToolReattachMaxWindowMs
        );
        if (reattach.result) {
          await this._finishAgentToolRun(runInfo, reattach.result, {
            sequence: reattach.sequence,
            completedAt: reattach.completedAt
          });
          return reattach.result;
        }
        // Budget spent with the run still open: the parent gives up, and
        // says so. `interrupted` is not the run's outcome, and a later
        // `runAgentTool` with the same run id re-attaches.
        const childTornDown = await this._teardownGivenUpAgentToolChild(
          adapter,
          runId,
          reattach.reason
        );
        const result: RunAgentToolResult<Output> = {
          runId,
          agentType,
          status: "interrupted",
          error: this._interruptedMessageForReason(reattach.reason),
          ...(reattach.reason !== undefined ? { reason: reattach.reason } : {}),
          childStillRunning: !childTornDown
        };
        await this._finishAgentToolRun(runInfo, result, {
          sequence: reattach.sequence
        });
        return result;
      }

      const inspection = inspected ?? childStart;
      // The start failed and the child has no such run: the run never
      // began, and the failure is its error.
      if (!inspection) throw startFailure?.error;
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

  /**
   * While an awaited `runAgentTool` follows a child's tail, inspect the run
   * once per no-progress window (`agentToolReattachNoProgressTimeoutMs`).
   *
   * The inspection is what bounds the wait. A child settles a run that has
   * nothing left to finish it when it is inspected, and closes its tails.
   * `ended` aborts when an inspection reports the run over while the tail
   * is still open, so the caller stops following it and reads the result.
   * A run the child reports as still open is followed further: a turn that
   * is working, or one chat recovery is finishing, is not cut short here.
   *
   * @param currentAdapter - Read on every inspection: the caller swaps the
   *   adapter when the child's isolate goes away.
   */
  private _watchAgentToolRunWhileTailing(
    currentAdapter: () => AgentToolChildAdapter,
    runId: string
  ): { ended: AbortSignal; stop: () => void } {
    const ended = new AbortController();
    const everyMs = this.budgets().agentToolReattachNoProgressTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const inspect = async () => {
      try {
        const inspection = await currentAdapter().inspectAgentToolRun(runId);
        if (
          inspection &&
          inspection.status !== "running" &&
          inspection.status !== "starting"
        ) {
          ended.abort();
          return;
        }
      } catch {
        // The child could not be asked this time. Ask again.
      }
      if (!stopped) timer = setTimeout(() => void inspect(), everyMs);
    };
    if (everyMs > 0 && Number.isFinite(everyMs)) {
      timer = setTimeout(() => void inspect(), everyMs);
    }
    return {
      ended: ended.signal,
      stop: () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      }
    };
  }

  /**
   * Cancel an agent-tool run by id. Idempotent: cancelling an already-terminal
   * run is a no-op. Detached runs deliver through the guarded ledger so a wired
   * `onFinish` fires once with `status: "aborted"`; awaited runs leave terminal
   * observation to the awaiting/recovery path, avoiding duplicate finish hooks.
   */
  async cancelAgentTool(runId: string, reason?: unknown): Promise<void> {
    const row = this._readAgentToolRun(runId);
    if (!row) return;
    if (this._isAgentToolRowHardTerminal(row.status)) return;
    const isDetached = row.detached === 1;
    const message =
      reason instanceof Error
        ? reason.message
        : String(reason ?? "cancelled by parent");
    try {
      const child = await this._agentToolChild(row.agent_type, runId);
      const adapter = this._asAgentToolChildAdapter(child);
      await adapter.cancelAgentToolRun(runId, reason);
    } catch {
      // Best-effort child teardown; we still record the aborted terminal so the
      // detached parent stops watching and any wired callback fires.
    }
    if (!isDetached) return;
    await this._deliverDetachedTerminal(runId, "finish", {
      runId,
      agentType: row.agent_type,
      status: "aborted",
      error: message
    });
  }

  /**
   * Parse + validate the `detached` option. Returns `null` for a non-detached
   * run, or the normalized config (with the validated `onFinish` method name)
   * for a detached one. Throws if `onFinish` does not name a method on this
   * agent — closures cannot survive Durable Object eviction, so the durable
   * hook is referenced by method name (the same contract as `schedule`).
   */
  private _parseDetachedOption(detached: RunAgentToolOptions["detached"]): {
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
      if (!this.hooks.detachedMethod(onFinishName)) {
        throw new Error(
          `runAgentTool: detached.onFinish "${onFinishName}" is not a method on ${this.lifecycle.className}. ` +
            'Pass the NAME of a method (e.g. "onImportDone"), not a closure — ' +
            "closures cannot be rehydrated after the Durable Object is evicted."
        );
      }
    } else if (detached.notify) {
      // `notify` sugar: auto-target the chat-agent notify hook if present.
      // A no-op on a base Agent that does not implement it.
      if (this.hooks.detachedMethod(DETACHED_NOTIFY_CALLBACK)) {
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

  private _isAgentToolRowHardTerminal(status: AgentToolRunStatus): boolean {
    return status === "completed" || status === "error" || status === "aborted";
  }

  /** Whether an open run is from when the child was a facet. */
  private _hasFacetEraAgentToolRuns(): boolean {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE child_name IS NULL
        AND status IN ('starting', 'running', 'interrupted')
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  private _hasOutstandingDetachedRuns(): boolean {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE detached = 1 AND finish_delivered_at IS NULL
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  /** Detached runs still holding a concurrency slot (non-terminal). */
  private _liveDetachedRunCount(): number {
    const rows = this.sql<{ n: number }>`
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
  private _maybeWarnDetachedLiveCount(): void {
    const liveCount = this._liveDetachedRunCount();
    if (liveCount < DETACHED_LIVE_COUNT_WARN_THRESHOLD) {
      this._detachedLiveCountWarned = false;
      return;
    }
    if (this._detachedLiveCountWarned) return;
    this._detachedLiveCountWarned = true;
    this.lifecycle.events.emit("agent_tool:detached:live_count_warning", {
      liveCount,
      threshold: DETACHED_LIVE_COUNT_WARN_THRESHOLD
    });
    console.warn(
      `[agents] ${liveCount} detached agent-tool runs are live on this agent (threshold ${DETACHED_LIVE_COUNT_WARN_THRESHOLD}). Detached runs hold a concurrency slot until they finish — make sure they are completing or being cancelled, or lower \`maxConcurrentAgentTools\`.`
    );
  }

  /**
   * Warm fast path for a detached run: tail the child to terminal (so the
   * parent re-broadcasts its live stream to clients) and deliver the completion
   * with low latency while the isolate stays alive. Best-effort — the durable
   * `_cfDetachedReconcileTick` backbone is the guarantee; anything this misses
   * (eviction, a child that has not yet reached terminal) the backbone collects.
   */
  private async _detachedFastPath<Input, Output>(
    runInfo: AgentToolRunInfo,
    runId: string
  ): Promise<void> {
    try {
      const child = await this._agentToolChild(runInfo.agentType, runId);
      const adapter = this._asAgentToolChildAdapter<Input, Output>(child);
      let sequence = 1;
      if (adapter.tailAgentToolRun) {
        const stream = await adapter.tailAgentToolRun(runId, {
          afterSequence: -1
        });
        sequence = (
          await this._forwardAgentToolStream(
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
        this._isAgentToolRowHardTerminal(
          inspection.status as AgentToolRunStatus
        )
      ) {
        const result = this._terminalResultFromInspection<Output>(
          runInfo.agentType,
          inspection
        );
        await this._deliverDetachedTerminal(
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
   */
  private async _deliverDetachedTerminal<Output>(
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

    const row = this._readAgentToolRun(runId);
    if (!row) return;

    this._updateAgentToolTerminal(runId, result, completedAt);
    // Always project the terminal onto the parent's `agent-tool-event` stream so
    // a background-runs tray flips to its final state live. The backbone/fast
    // path supply a tail sequence; other paths (e.g. an explicit
    // `cancelAgentTool`, or a budget give-up) get a synthetic latest-wins
    // sequence — the client reducer keys terminal status off the event kind, not
    // the sequence, so a monotonic value is not required.
    this._broadcastAgentToolTerminal(
      row.parent_tool_call_id ?? undefined,
      options?.sequence ?? Date.now(),
      result
    );

    const runInfo = this._agentToolRunInfoFromRow(
      row,
      result.status,
      completedAt
    );
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
        await this.hooks.onAgentToolFinish(runInfo, lifecycle);
      } catch (error) {
        await this._safeRunOnError(error);
      }
      // Targeted, durable per-run callback (method name persisted on the row).
      const callbackName = row.detached_on_finish;
      if (callbackName) {
        const callback = this.hooks.detachedMethod(callbackName);
        if (callback) {
          try {
            await callback(runInfo, lifecycle);
          } catch (error) {
            this.lifecycle.events.emit("agent_tool:detached:delivery_failed", {
              runId,
              kind,
              status: result.status,
              callback: callbackName,
              error: error instanceof Error ? error.message : String(error)
            });
            await this._safeRunOnError(error);
            throw error;
          }
        }
      }
    };

    // Delivery can fire from a scheduled alarm or the warm fast path (no ambient
    // turn). `_runDetachedDelivery` establishes `agentContext` so a handler that
    // calls runAgentTool / setState / submitMessages works, and — in chat-layer
    // subclasses — serializes the delivery against the host turn queue when
    // `serialize` is set, so a state-mutating `onFinish` never interleaves with
    // an active LLM turn (RFC §"run inside a turn"). An explicit cancel runs
    // inline (it is already inside its caller's context).
    await this.hooks.runDetachedDelivery(invoke, {
      serialize: options?.serialize
    });

    // Mark delivered only AFTER the handler resolves. A crash before this point
    // leaves the lease to expire and a later reconcile to re-deliver.
    if (kind === "finish") {
      this.sql`
        UPDATE cf_agent_tool_runs
        SET finish_delivered_at = ${Date.now()}
        WHERE run_id = ${runId}
      `;
    } else {
      this.sql`
        UPDATE cf_agent_tool_runs
        SET give_up_delivered_at = ${Date.now()}
        WHERE run_id = ${runId}
      `;
    }
  }

  private async _safeRunOnError(error: unknown): Promise<void> {
    try {
      await this.hooks.onError(error);
    } catch {
      // Delivery hooks are best-effort; a failing onError must not wedge the
      // ledger or other detached runs.
    }
  }

  /**
   * Arm the detached backbone: one Lifecycle job with a fixed id, so a
   * second arm replaces it instead of adding another. `resetCadence` starts
   * the cadence again from its first step.
   */
  private async _armDetachedBackbone(options?: {
    resetCadence?: boolean;
  }): Promise<void> {
    if (!options?.resetCadence && this.lifecycle.jobs.get(BACKBONE_JOB_ID)) {
      return;
    }
    this.lifecycle.storage.kv.put(BACKBONE_CADENCE_KEY, 0);
    await this.lifecycle.jobs.push({
      id: BACKBONE_JOB_ID,
      fn: BACKBONE_JOB_FN,
      time: Date.now() + DETACHED_BACKBONE_CADENCE_S[0] * 1000
    });
  }

  /**
   * Run the backbone from a schedule row an earlier version armed, then
   * carry on as this capability's job.
   */
  async reconcileFromSchedule(
    payload?: DetachedReconcilePayload
  ): Promise<void> {
    const next = await this._cfDetachedReconcileTick(payload);
    if (next === undefined) return;
    await this.lifecycle.jobs.push({
      id: BACKBONE_JOB_ID,
      fn: BACKBONE_JOB_FN,
      time: next
    });
  }

  /**
   * Durable backbone for detached runs. Runs on a self-rescheduling alarm:
   * collects any detached run that has reached terminal but was not yet
   * delivered (e.g. the parent was evicted before the fast path landed), gives
   * up on any run past its absolute budget (tearing the child down), and
   * reschedules itself while any detached run remains undelivered — cancelling
   * itself once everything has settled (zero steady-state cost).
   */
  async _cfDetachedReconcileTick(
    payload?: DetachedReconcilePayload
  ): Promise<number | undefined> {
    const rows = this.sql<AgentToolRunStorageRow>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, interrupted_reason,
             child_still_running, display_metadata, display_order,
             started_at, completed_at, detached, detached_on_finish,
             detached_notify_source, detached_max_budget_at,
             detached_no_progress_budget_ms, last_progress_at,
             detached_on_milestones, child_name,
             finish_claimed_at, finish_delivered_at, give_up_claimed_at,
             give_up_delivered_at
      FROM cf_agent_tool_runs
      WHERE detached = 1 AND finish_delivered_at IS NULL
      ORDER BY started_at ASC
    `;

    for (const row of rows) {
      const runId = row.run_id;
      if (row.child_name === null) {
        // From when the child was a facet: there is no child to ask, so a
        // finish whose callback failed is delivered again from the row.
        await this._deliverDetachedTerminal(runId, "finish", {
          runId,
          agentType: row.agent_type,
          status: "error",
          error: row.error_message ?? FACET_ERA_AGENT_TOOL_RUN_ERROR
        });
        continue;
      }
      let inspection: AgentToolRunInspection | null = null;
      try {
        const child = await this._agentToolChild(row.agent_type, runId);
        const adapter = this._asAgentToolChildAdapter(child);
        inspection = await adapter.inspectAgentToolRun(runId);
      } catch {
        // Treat an unreachable child like a null inspection: keep waiting within
        // budget rather than sealing (a single failure is not proof it is gone).
      }

      // Deliver any configured milestone notifications the warm tail missed
      // (e.g. the parent was evicted when the milestone landed). Idempotent:
      // `_deliverDetachedMilestone` keys on (runId, name), so re-delivering an
      // already-notified milestone is a no-op. Runs regardless of terminal
      // state — a milestone reached just before completion still notifies.
      if (inspection?.milestones && row.detached_on_milestones) {
        const milestoneRunInfo = this._agentToolRunInfoFromRow(row);
        for (const milestone of inspection.milestones) {
          this._maybeDeliverDetachedMilestone(row, milestoneRunInfo, milestone);
        }
      }

      if (
        inspection &&
        this._isAgentToolRowHardTerminal(
          inspection.status as AgentToolRunStatus
        )
      ) {
        const result = this._terminalResultFromInspection(
          row.agent_type,
          inspection
        );
        await this._deliverDetachedTerminal(
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
          const child = await this._agentToolChild(row.agent_type, runId);
          const adapter = this._asAgentToolChildAdapter(child);
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
        await this._deliverDetachedTerminal(
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

    // Come back while anything remains undelivered; otherwise the backbone
    // goes quiet until the next detached run arms it.
    if (!this._hasOutstandingDetachedRuns()) return undefined;
    const stored = this.lifecycle.storage.kv.get<number>(BACKBONE_CADENCE_KEY);
    const currentIndex =
      typeof payload?.cadenceIndex === "number"
        ? payload.cadenceIndex
        : (stored ?? 0);
    const nextIndex = Math.min(
      currentIndex + 1,
      DETACHED_BACKBONE_CADENCE_S.length - 1
    );
    this.lifecycle.storage.kv.put(BACKBONE_CADENCE_KEY, nextIndex);
    return Date.now() + DETACHED_BACKBONE_CADENCE_S[nextIndex] * 1000;
  }

  hasAgentToolRun(
    classOrName: { name: string } | string,
    runId: string
  ): boolean {
    const agentType =
      typeof classOrName === "string" ? classOrName : classOrName.name;
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE run_id = ${runId} AND agent_type = ${agentType}
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  async clearAgentToolRuns(options?: {
    olderThan?: number;
    status?: AgentToolRunStatus[];
  }): Promise<void> {
    const rows = this.sql<{
      run_id: string;
      agent_type: string;
      status: string;
      child_name: string | null;
      child_name_minted: number | null;
    }>`
      SELECT run_id, agent_type, status, child_name, child_name_minted
      FROM cf_agent_tool_runs
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
        if (row.child_name === null) {
          // From when the child was a facet: delete the facet with the run.
          await this.hooks.deleteLegacySubAgent(row.agent_type, row.run_id);
        } else {
          const child = await this._agentToolChild(row.agent_type, row.run_id);
          // `interrupted`: the parent stopped following, the child may not
          // have stopped working.
          if (
            row.status === "starting" ||
            row.status === "running" ||
            row.status === "interrupted"
          ) {
            const adapter = this._asAgentToolChildAdapter(child);
            await adapter.cancelAgentToolRun(
              row.run_id,
              "clearing agent tool run"
            );
          }
          // A child the parent named is its own, and goes with its last
          // run. A child the caller named may be shared or used directly,
          // so only its run is cancelled.
          const othersOnChild =
            this.sql<{ n: number }>`
              SELECT COUNT(*) AS n FROM cf_agent_tool_runs
              WHERE agent_type = ${row.agent_type}
                AND child_name = ${row.child_name}
                AND run_id != ${row.run_id}
            `[0]?.n ?? 0;
          if (row.child_name_minted === 1 && othersOnChild === 0) {
            // The child's own runs go first: a destroyed child no longer
            // reaches the children it started.
            await child.clearAgentToolRuns().catch(() => {});
            // Wipes the child's storage on its next wake.
            await child._cf_scheduleDestroy();
          }
        }
      } catch {
        // Cleanup is intentionally idempotent.
      }
      this.sql`
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
    const rows = this.sql<{ n: number }>`
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

  private _readAgentToolRun(runId: string): AgentToolRunStorageRow | null {
    const rows = this.sql<AgentToolRunStorageRow>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, interrupted_reason,
             child_still_running, display_metadata, display_order,
             started_at, completed_at, detached, detached_on_finish,
             detached_notify_source, detached_max_budget_at,
             finish_claimed_at, finish_delivered_at, give_up_claimed_at,
             give_up_delivered_at
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

  private _resultFromAgentToolRow<Output>(
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
      ...(row.detached_notify_source != null
        ? { notifySource: row.detached_notify_source }
        : {}),
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
      this.hooks.onAgentToolFinish(
        { ...run, status: result.status, completedAt },
        result
      );
    if (options?.deferFinishHook) return finish;
    await finish();
    return undefined;
  }

  private async _runDeferredAgentToolFinishHooks(
    hooks: DeferredAgentToolFinish[]
  ): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        try {
          await this.hooks.onError(error);
        } catch {
          // Recovery hooks are best-effort; one failed mirror write should not
          // prevent the agent from starting or other recovered runs finalizing.
        }
      }
    }
  }

  private _updateAgentToolTerminal<Output>(
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
    this.sql`
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
      this.sql`
        UPDATE cf_agent_tool_runs
        SET output_json = COALESCE(output_json, ${this._stringifyAgentToolOutput(result.output)}),
            summary = COALESCE(summary, ${result.summary ?? null})
        WHERE run_id = ${runId} AND status = 'completed'
      `;
    }
  }

  private _markAgentToolRunning(runId: string): void {
    this.sql`
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
      this.hooks.broadcast(body);
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
    const terminalOnly = this._isTerminalOnlyAgentToolRun(runId);
    let next = sequence;
    for (const chunk of chunks) {
      // Stored chunks are numbered by store position (`started` is 0, stored
      // chunk i is i + 1) on both the live and replay paths, so they dedupe
      // against each other. A skipped chunk still takes its sequence.
      const chunkSequence = next++;
      if (terminalOnly && !isAgentToolLifecycleChunk(chunk.body)) continue;
      this._broadcastAgentToolEvent(
        parentToolCallId,
        chunkSequence,
        { kind: "chunk", runId, body: chunk.body },
        replay,
        connection
      );
    }
    return next;
  }

  private _isTerminalOnlyAgentToolRun(runId: string): boolean {
    const rows = this.sql<{ event_delivery: string | null }>`
      SELECT event_delivery FROM cf_agent_tool_runs WHERE run_id = ${runId}
    `;
    return rows[0]?.event_delivery === "terminal";
  }

  private async _broadcastAgentToolStoredChunks(
    row: Pick<
      AgentToolRunStorageRow,
      "run_id" | "agent_type" | "parent_tool_call_id"
    >,
    sequence: number,
    replay?: true,
    connection?: Connection,
    timeoutMs?: number
  ): Promise<number> {
    const deadline = this._agentToolRecoveryDeadline(timeoutMs);
    const resolving = this._agentToolChild(row.agent_type, row.run_id);
    const child =
      deadline === undefined
        ? await resolving
        : await this._settleWithinRecoveryTimeout(resolving, deadline());
    if (child === undefined) return sequence;
    const adapter = this._asAgentToolChildAdapter(child);
    return this._broadcastAgentToolStoredChunksFromAdapter(
      adapter,
      row,
      sequence,
      replay,
      connection,
      deadline?.()
    );
  }

  /**
   * One budget shared by every step of a bounded recovery read, so a run's
   * total time stays within `timeoutMs`. Returns the remaining milliseconds,
   * never below 1 because a non-positive timeout means "unbounded".
   */
  private _agentToolRecoveryDeadline(
    timeoutMs?: number
  ): (() => number) | undefined {
    if (timeoutMs === undefined || timeoutMs <= 0) return undefined;
    const deadline = Date.now() + timeoutMs;
    return () => Math.max(1, deadline - Date.now());
  }

  private async _broadcastAgentToolStoredChunksFromAdapter(
    adapter: AgentToolChildAdapter,
    row: Pick<AgentToolRunStorageRow, "run_id" | "parent_tool_call_id">,
    sequence: number,
    replay?: true,
    connection?: Connection,
    timeoutMs?: number
  ): Promise<number> {
    const deadline = this._agentToolRecoveryDeadline(timeoutMs);
    const chunks = await this._getAgentToolChunksForRecovery(
      adapter,
      row.run_id,
      deadline?.()
    );
    const next = chunks
      ? this._broadcastAgentToolChunks(
          row.parent_tool_call_id ?? undefined,
          row.run_id,
          chunks,
          sequence,
          replay,
          connection
        )
      : sequence;
    return this._broadcastAgentToolMilestones(
      adapter,
      row,
      next,
      replay,
      connection,
      deadline?.()
    );
  }

  /**
   * Milestones are persisted on the child run rather than in its chunk log, so
   * replay re-emits them from the child's inspection. The client dedupes them
   * on the milestone's own sequence, so a milestone already seen live is a no-op.
   * They carry the next stored-chunk sequence without consuming it, matching
   * the live path.
   */
  private async _broadcastAgentToolMilestones(
    adapter: AgentToolChildAdapter,
    row: Pick<AgentToolRunStorageRow, "run_id" | "parent_tool_call_id">,
    sequence: number,
    replay?: true,
    connection?: Connection,
    timeoutMs?: number
  ): Promise<number> {
    // Read-only: replaying milestones must never seal a stale child run.
    const inspection = await this._settleWithinRecoveryTimeout(
      adapter.inspectAgentToolRun(row.run_id, { reconcile: false }),
      timeoutMs
    );
    const milestones: AgentToolMilestone[] = inspection?.milestones ?? [];
    for (const milestone of milestones) {
      this._broadcastAgentToolEvent(
        row.parent_tool_call_id ?? undefined,
        sequence,
        {
          kind: "chunk",
          runId: row.run_id,
          body: JSON.stringify({
            type: AGENT_TOOL_MILESTONE_PART,
            data: {
              name: milestone.name,
              sequence: milestone.sequence,
              at: milestone.at,
              ...(milestone.data !== undefined ? { data: milestone.data } : {})
            }
          })
        },
        replay,
        connection
      );
    }
    return sequence;
  }

  private async _forwardAgentToolStream(
    stream: ReadableStream<AgentToolStoredChunk>,
    parentToolCallId: string | undefined,
    runId: string,
    sequence: number,
    signal?: AbortSignal,
    idleTimeoutMs?: number,
    /**
     * Kept at the next sequence as chunks are forwarded, so a caller whose
     * stream breaks still knows how far it got.
     */
    cursor?: { next: number }
  ): Promise<{
    next: number;
    ended: "done" | "idle" | "aborted";
    forwarded: boolean;
  }> {
    let next = sequence;
    let forwarded = false;
    if (signal?.aborted) return { next, ended: "aborted", forwarded };
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
    const terminalOnly = this._isTerminalOnlyAgentToolRun(runId);
    try {
      const forwardChunk = (chunk: AgentToolStoredChunk) => {
        // Progress/milestone frames and chunks too large to store are
        // broadcast-only on the child and never replayed from its store, so
        // they must not consume a stored-chunk sequence or live and replayed
        // numbering drift apart (#2364).
        const lifecycle = isAgentToolLifecycleChunk(chunk.body);
        const unstoredId =
          typeof chunk.unstoredId === "string" ? chunk.unstoredId : undefined;
        const chunkSequence =
          lifecycle || unstoredId !== undefined ? next : next++;
        if (cursor) cursor.next = next;
        forwarded = true;
        if (!terminalOnly || lifecycle) {
          this._broadcastAgentToolEvent(parentToolCallId, chunkSequence, {
            kind: "chunk",
            runId,
            body: chunk.body,
            ...(unstoredId !== undefined ? { unstoredId } : {})
          });
        }
        // A reserved `data-agent-progress` frame fires the parent `onProgress`
        // hook + refreshes the cached liveness timestamp. Best-effort: never
        // let a progress observation break the forward loop.
        this._observeForwardedProgress(runId, chunk.body);
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
            await this.hooks.onStreamProgress();
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
    return { next, ended, forwarded };
  }

  /**
   * Best-effort observation of a forwarded child chunk: if it is a reserved
   * `data-agent-progress` frame, refresh the cached liveness timestamp on the
   * run row (a hint for a still-warm parent) and fire the public `onProgress`
   * hook. Never throws into the forward loop — the child's own persisted
   * snapshot (read via `inspectAgentToolRun`) remains authoritative for the
   * resetting no-progress budget after eviction.
   */
  private _observeForwardedProgress(runId: string, body: string): void {
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
    const row = this._readAgentToolRun(runId);
    if (!row) return;
    // The cached liveness timestamp only feeds the DETACHED no-progress budget;
    // skip the write for awaited runs (the `onProgress` hook still fires below).
    if (row.detached) {
      try {
        this.sql`
          UPDATE cf_agent_tool_runs SET last_progress_at = ${at}
          WHERE run_id = ${runId}
        `;
      } catch {
        // Row may have settled / been pruned; the hook still fires below.
      }
    }
    const runInfo = this._agentToolRunInfoFromRow(row);
    void Promise.resolve(this.hooks.onProgress(runInfo, snapshot)).catch(
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
      this._maybeDeliverDetachedMilestone(row, runInfo, {
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
   * to the overridable `_deliverDetachedMilestone` seam (a no-op on the base
   * `Agent`; chat hosts inject an idempotent synthetic chat message).
   */
  private _maybeDeliverDetachedMilestone(
    row: AgentToolRunStorageRow,
    runInfo: AgentToolRunInfo,
    milestone: AgentToolMilestone
  ): void {
    // Stored as `{ names, mode }`; tolerate a bare-array legacy/manual value.
    const configured = this._parseAgentToolJson(
      row.detached_on_milestones ?? null
    ) as
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
      this.hooks.deliverDetachedMilestone(runInfo, milestone, mode)
    ).catch((error) => {
      console.error(
        `[agents] detached milestone delivery threw for run ${runInfo.runId} (${milestone.name}):`,
        error instanceof Error ? error.message : String(error)
      );
    });
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

  /**
   * The child of a run: an ordinary Durable Object of the run's class,
   * under the name minted when the run was recorded.
   */
  private async _agentToolChild(
    agentType: string,
    runId: string
  ): Promise<DurableObjectStub<Agent>> {
    const childName = this.sql<{ child_name: string | null }>`
      SELECT child_name FROM cf_agent_tool_runs WHERE run_id = ${runId}
    `[0]?.child_name;
    if (!childName) throw new Error(FACET_ERA_AGENT_TOOL_RUN_ERROR);
    return agentToolChildStub(this.ctx, agentType, childName);
  }

  /**
   * The child of a run this agent started, as a stub for RPC (for example
   * to read its messages), or `null` when there is no such run.
   */
  async getAgentToolChild<T extends Agent = Agent>(
    runId: string
  ): Promise<AgentToolChildStub<T> | null> {
    const row = this._readAgentToolRun(runId);
    if (!row) return null;
    try {
      return (await this._agentToolChild(
        row.agent_type,
        runId
      )) as unknown as AgentToolChildStub<T>;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === FACET_ERA_AGENT_TOOL_RUN_ERROR
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Runs started before agent-tool children were ordinary Durable Objects
   * ran their child as a facet, which is no longer reached. An open one
   * ends `error` with an event, `onAgentToolFinish`, and (detached) its
   * `onFinish`, so the parent learns how it ended.
   */
  private async _failFacetEraAgentToolRuns(
    onlyRunId?: string
  ): Promise<DeferredAgentToolFinish[]> {
    const deferred: DeferredAgentToolFinish[] = [];
    const rows = this.sql<{ run_id: string; detached: number }>`
      SELECT run_id, detached FROM cf_agent_tool_runs
      WHERE child_name IS NULL
        AND status IN ('starting', 'running', 'interrupted')
        AND (${onlyRunId ?? null} IS NULL OR run_id = ${onlyRunId ?? null})
      ORDER BY started_at ASC
    `;
    for (const { run_id: runId, detached } of rows) {
      const row = this._readAgentToolRun(runId);
      if (!row) continue;
      const result: RunAgentToolResult = {
        runId,
        agentType: row.agent_type,
        status: "error",
        error: FACET_ERA_AGENT_TOOL_RUN_ERROR
      };
      if (detached === 1) {
        try {
          await this._deliverDetachedTerminal(runId, "finish", result);
        } catch {
          // The row is settled; a failed onFinish was reported to onError.
        }
        continue;
      }
      const finish = await this._finishAgentToolRun(
        this._agentToolRunInfoFromRow(row),
        result,
        { sequence: 1, deferFinishHook: true }
      );
      if (finish) deferred.push(finish);
    }
    return deferred;
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
   * wall-clock ceiling (default `Infinity` — uncapped, #1672); set it finite
   * to also bound a child that keeps progressing, which seals
   * `window-exceeded` and tears the child down.
   *
   * Returns the terminal `result` (and `completedAt`) when the child reaches a
   * terminal status, plus the advanced broadcast `sequence`. Returns
   * `{ result: undefined }` when there is no `tailAgentToolRun` adapter, the
   * child makes no progress within a full no-progress window, or the ceiling is
   * reached while the child is still non-terminal — the caller then seals
   * `interrupted`.
   */
  private async _reattachAgentToolRunToTerminal<Output>(
    adapter: AgentToolChildAdapter<unknown, Output>,
    row: Pick<
      AgentToolRunStorageRow,
      "run_id" | "agent_type" | "parent_tool_call_id"
    >,
    sequence: number,
    noProgressTimeoutMs: number = this.budgets()
      .agentToolReattachNoProgressTimeoutMs,
    maxWindowMs: number = this.budgets().agentToolReattachMaxWindowMs
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

    this.lifecycle.events.emit("agent_tool:recovery:reattach", {
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
        // Tailed chunks continue the stored-position numbering replay uses, so
        // clients that already saw the stored chunks don't dedupe new ones away.
        let storedCount = 0;
        try {
          const existing = await adapter.getAgentToolChunks(row.run_id);
          const last = existing[existing.length - 1];
          if (last) afterSequence = last.sequence;
          storedCount = existing.length;
        } catch {
          // Fall back to a full tail if the chunk probe fails.
        }
        // Never below what this parent already broadcast for the run: a
        // recovered turn streams into a stream of its own, which can hold
        // fewer chunks than the first turn sent, and a client keys a chunk
        // by its sequence, so a reused one is dropped as a repeat.
        nextSequence = Math.max(nextSequence, storedCount + 1);

        // Defaults to a non-`done` end so a tail that throws below does NOT
        // re-arm (we only re-arm on a verified clean stream-close).
        let streamEnded: "done" | "idle" | "aborted" = "idle";
        let forwardedAny = false;
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
          forwardedAny = forwarded.forwarded;
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
        if (!forwardedAny) break;
      }
    } finally {
      if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
    }

    return { sequence: nextSequence, reason };
  }

  /** @internal */
  async _replayAgentToolRuns(connection: Connection): Promise<void> {
    const rows = this.sql<{
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
        // Bounded end to end (child resolution included) so one unresponsive
        // child can't stall onConnect or every later run's replay.
        sequence = await this._broadcastAgentToolStoredChunks(
          row,
          sequence,
          true,
          connection,
          DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS
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

  private async _reconcileAgentToolRuns(options?: {
    deferFinishHooks?: boolean;
    childInspectionTimeoutMs?: number;
    totalRecoveryTimeoutMs?: number;
    reattachTimeoutMs?: number;
    reattachMaxWindowMs?: number;
    runIds?: readonly string[];
  }): Promise<DeferredAgentToolFinish[]> {
    const reattachTimeoutMs =
      options?.reattachTimeoutMs ??
      this.budgets().agentToolReattachNoProgressTimeoutMs;
    const reattachMaxWindowMs =
      options?.reattachMaxWindowMs ??
      this.budgets().agentToolReattachMaxWindowMs;
    const startedAt = Date.now();
    const totalTimeoutMs =
      options?.totalRecoveryTimeoutMs ??
      DEFAULT_AGENT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS;
    const deadlineAt =
      totalTimeoutMs > 0
        ? startedAt + totalTimeoutMs
        : Number.POSITIVE_INFINITY;
    const deferredFinishes: DeferredAgentToolFinish[] = [];
    const rows = this.sql<AgentToolRunStorageRow>`
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
    // detached runs are owned by the self-scheduling `_cfDetachedReconcileTick`
    // backbone instead, which keeps them alive within budget and delivers on
    // terminal. The backbone is (re-)armed on startup by
    // `_scheduleAgentToolRunRecovery`.
    const runIds =
      options?.runIds !== undefined ? new Set(options.runIds) : undefined;
    const recoveryRows = rows.filter(
      (row) => !runIds || runIds.has(row.run_id)
    );
    this.lifecycle.events.emit("agent_tool:recovery:begin", {
      runCount: recoveryRows.length,
      totalTimeoutMs
    });
    const finalizeRow = async (
      row: AgentToolRunStorageRow,
      result: RunAgentToolResult,
      sequence: number,
      completedAt: number | undefined
    ): Promise<void> => {
      this.lifecycle.events.emit("agent_tool:recovery:row", {
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
        this.lifecycle.events.emit("agent_tool:recovery:deadline", {
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
          await this._broadcastAgentToolStoredChunksFromAdapter(
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
    this.lifecycle.events.emit("agent_tool:recovery:complete", {
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
      const child = await this._agentToolChild(row.agent_type, row.run_id);
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

  /** @internal */
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

    if (
      options?.runIds &&
      options.runIds.length === 0 &&
      !this._hasFacetEraAgentToolRuns()
    ) {
      return Promise.resolve();
    }

    const recovery = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await this._runDeferredAgentToolFinishHooks(
        await this._failFacetEraAgentToolRuns()
      );
      const recoveredAgentToolFinishes = await this._reconcileAgentToolRuns({
        deferFinishHooks: true,
        childInspectionTimeoutMs: options?.childInspectionTimeoutMs,
        totalRecoveryTimeoutMs: options?.totalRecoveryTimeoutMs,
        reattachTimeoutMs: options?.reattachTimeoutMs,
        reattachMaxWindowMs: options?.reattachMaxWindowMs,
        runIds: options?.runIds
      });
      await this._runDeferredAgentToolFinishHooks(recoveredAgentToolFinishes);
      // Re-arm the detached backbone if this DO woke with outstanding detached
      // runs (the schedule row survives eviction, but this also recreates it if
      // a dispatching turn crashed after inserting the run row but before
      // arming the schedule).
      if (this._hasOutstandingDetachedRuns()) {
        await this._armDetachedBackbone();
      }
    })()
      .catch(async (error) => {
        this.lifecycle.events.emit("agent_tool:recovery:failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        try {
          await this.hooks.onError(error);
        } catch {
          // Background recovery must never make a started agent unreachable.
        }
      })
      .finally(() => {
        this._agentToolRunRecoveryPromise = undefined;
      });

    this._agentToolRunRecoveryPromise = recovery;
    this.ctx.waitUntil(recovery);
    return recovery;
  }

  /** @internal */
  _agentToolRunRecoveryRunIds(): string[] {
    return this.sql<{ run_id: string }>`
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
    return this._settleWithinRecoveryTimeout(
      adapter.getAgentToolChunks(runId),
      timeoutMs
    );
  }

  /** Resolve to `undefined` when `promise` rejects or outlasts `timeoutMs`. */
  private async _settleWithinRecoveryTimeout<T>(
    promise: Promise<T>,
    timeoutMs?: number
  ): Promise<T | undefined> {
    const settled = promise.catch(() => undefined);
    if (timeoutMs === undefined || timeoutMs <= 0) return settled;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timeoutId = setTimeout(() => resolve(undefined), timeoutMs);
    });
    const result = await Promise.race([settled, timeout]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    return result;
  }
}
