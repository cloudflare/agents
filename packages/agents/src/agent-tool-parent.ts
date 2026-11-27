import { hasTable } from "./lifecycle/schema";
import type { DynamicAgentClass as SubAgentClass } from "./dynamic-agents/types";
import { nanoid } from "nanoid";
import type { Connection } from "./lifecycle/durable-object-lifecycle";
import type { ResolvedAgentOptions } from "./agent-options";
import type { ObservabilityEvent } from "./observability/emitter";
import type { Schedule } from "./schedules/types";
import {
  DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS,
  DEFAULT_AGENT_TOOL_REATTACH_NO_PROGRESS_TIMEOUT_MS
} from "./agent-options";
import { MAX_SERIALIZED_BYTES } from "./tasks/serialization";
import { TaskSettlement } from "./tasks/settlement";
import type { Tasks } from "./tasks/tasks";
import type { TaskJson, TaskRecord, TaskStep } from "./tasks/types";
import { allChunks } from "./agent-tool-chunks";
import {
  AGENT_TOOL_MILESTONE_PART,
  AGENT_TOOL_PROGRESS_PART,
  isAgentToolLifecycleChunk
} from "./agent-tool-types";
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
  DetachedRunAgentToolResult,
  RunAgentToolOptions,
  RunAgentToolResult
} from "./agent-tool-types";

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
};

const DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS = 2_000;
// An awaited agent-tool run is one run of this Task definition, keyed by the
// run id. Its attempt follows the child; a reset re-runs it, which re-attaches.
const AGENT_TOOL_TASK = "__cf_agent_tool";
// How often a re-attached run asks its child, at most: it starts at 1 s and
// doubles up to this. It asks, rather than holding the child's tail, so the
// alarm that runs it is never held open by the child.
const AGENT_TOOL_REATTACH_POLL_MAX_MS = 5_000;
// A detached agent-tool run: its attempts follow the child while the parent
// is up and check on it on the backbone's cadence while it is not.
const AGENT_TOOL_DETACHED_TASK = "__cf_agent_tool_detached";
/** Both agent-tool definitions, for the reads that list every run. */
const AGENT_TOOL_DEFINITIONS = [AGENT_TOOL_TASK, AGENT_TOOL_DETACHED_TASK];
// The cancel reason `clearAgentToolRuns` gives an open run.
const AGENT_TOOL_CLEARED_REASON = "agent tool run cleared";
// When a detached run's give-up callback failed, give up again this much
// later.
const DETACHED_DELIVERY_RETRY_MS = 30_000;
// Escalating cadence on which a waiting detached run checks on its child.
// The warm tail makes the first entries near-moot; these bound worst-case
// post-eviction latency while keeping steady-state alarm cost low.
const DETACHED_BACKBONE_CADENCE_S = [5, 15, 30, 120];
// Detached runs hold a `maxConcurrentAgentTools` slot for their ENTIRE life and
// have no observer to notice them piling up. With the default `Infinity` cap
// that is a real leak footgun, so the framework emits an edge-triggered warning
// when the live (non-terminal) detached count first crosses this threshold,
// rather than silently accumulating. (A separate `maxConcurrentDetachedAgentTools`
// cap is deferred until evidence shows the single cap conflates two budgets.)
const DETACHED_LIVE_COUNT_WARN_THRESHOLD = 50;
// The Scheduler callback the released reconcile backbone was armed under.
// Its rows are cancelled when the runs move to Tasks.
const LEGACY_DETACHED_RECONCILE_CALLBACK = "_cfDetachedReconcileTick";
// The reasons the backbone cancels a child with when it gives up on a run. The
// child records the reason as its `aborted` run's error, which is how an abort
// the give-up caused is told from one the child had for its own reasons.
const DETACHED_BUDGET_CANCEL_REASON =
  "agent tool run given up by its parent: detached budget exceeded";
const DETACHED_SILENT_CANCEL_REASON =
  "agent tool run given up by its parent: detached run went silent past its no-progress window";
// Conventional method name a chat agent (Think / AIChatAgent) implements to
// receive `detached: { notify: true }` completions. Resolved by name so the
// base Agent stays decoupled from the chat layer.
const DETACHED_NOTIFY_CALLBACK = "_cfDetachedNotifyFinish";
/** What an awaited run's task keeps as metadata: today's display fields. */
type AgentToolTaskMeta = {
  agentType: string;
  parentToolCallId?: string;
  inputPreview?: TaskJson;
  display?: TaskJson;
  displayOrder: number;
  eventDelivery?: "terminal";
  startedAt: number;
  /** Set for a detached run: what its delivery and its budgets need. */
  detached?: {
    onFinish?: string;
    notifySource?: string;
    maxBudgetAt: number;
    noProgressBudgetMs?: number;
    onMilestones?: { names: string[]; mode: "react" | "narrate" };
  };
};
/** Handed to the attempt in the isolate that started the run (`local`). */
type AgentToolTaskLocal = {
  input: unknown;
  signal?: AbortSignal;
  meta: AgentToolTaskMeta;
  /**
   * A re-issue of a run that ended `interrupted`: the child already has the
   * run, so the attempt re-attaches within the budgets instead of starting.
   */
  reissue?: true;
  /** A result too large for the run's record, handed to the caller here. */
  fullResult?: RunAgentToolResult;
  /** A detached run's caller waits for the child to take the run. */
  childStarted?: { resolve(): void; reject(error: unknown): void };
};

/** The agent options agent tools read. */
export type AgentToolParentOptions = Pick<
  ResolvedAgentOptions,
  | "detachedMaxBudgetMs"
  | "detachedNoProgressBudgetMs"
  | "agentToolReattachMaxWindowMs"
  | "agentToolReattachNoProgressTimeoutMs"
>;

/**
 * The agent's own methods an agent-tool run calls. Each calls the agent, so
 * a subclass's override applies.
 */
export interface AgentToolParentHooks {
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
  /** Run a detached delivery in the agent's context (a chat host's lane). */
  runDetachedDelivery(
    invoke: () => Promise<void>,
    options?: { serialize?: boolean }
  ): Promise<void>;
  deliverDetachedMilestone(
    run: AgentToolRunInfo,
    milestone: AgentToolMilestone,
    mode: "react" | "narrate"
  ): Promise<void>;
  onAgentToolStreamProgress(): Promise<void>;
  /**
   * The method a run names to be called when it finishes (`onFinish`, kept
   * by name so it outlives the isolate), bound to the agent; `undefined` if
   * the agent has none.
   */
  method(name: string): ((...args: never[]) => unknown) | undefined;
}

/** What the parent side of agent tools is built from. */
export interface AgentToolParentDeps {
  readonly ctx: DurableObjectState;
  readonly tasks: Tasks;
  options(): AgentToolParentOptions;
  maxConcurrentAgentTools(): number;
  /** The agent's class name, for error messages. */
  readonly className: string;
  /** Whether the agent runs as a facet (read once its start knows). */
  isFacet(): boolean;
  /** The agent's sub-agents, by class name. */
  readonly children: {
    resolve(agentType: string, name: string): Promise<unknown>;
    has(agentType: string, name: string): boolean;
    /** Delete a child and its storage. */
    delete(agentType: string, name: string): Promise<void>;
  };
  /** The agent's schedules, for the released backbone's leftover rows. */
  readonly schedules: {
    listSchedules(): Promise<Schedule<unknown>[]>;
    cancelSchedule(id: string): Promise<unknown>;
  };
  /** Emit an observability event. */
  emit(
    type: ObservabilityEvent["type"],
    payload: Record<string, unknown>
  ): void;
  /** Send a frame to every client of the agent. */
  broadcast(message: string): void;
  readonly hooks: AgentToolParentHooks;
}

/**
 * The parent side of agent tools: awaited and detached runs as Task runs,
 * their attempts, delivery, replay to clients, the carry-forward of released
 * rows, and the concurrency cap.
 *
 * @internal
 */
export class AgentToolParent {
  /**
   * Awaited runs accepted by `runAgentTool` whose task row may not be written
   * yet, so concurrent calls count them against `maxConcurrentAgentTools`.
   * Each leaves when its call returns.
   */
  private readonly _agentToolRunsStarting = new Set<string>();
  /** Edge-trigger latch for the live-detached-count warning. */
  private _detachedLiveCountWarned = false;
  private readonly host: AgentToolParentDeps;

  constructor(host: AgentToolParentDeps) {
    this.host = host;
  }

  /** Register both agent-tool Task definitions on the host's Tasks. */
  registerTasks(claimMs: number): void {
    this.host.tasks.register(
      AGENT_TOOL_DETACHED_TASK,
      (_input, step) => this._detachedAgentToolAttempt(step),
      {
        claimMs,
        onStatus: (record) => this._onDetachedAgentToolStatus(record)
      }
    );
    this.host.tasks.register(
      AGENT_TOOL_TASK,
      (_input, step) => this._agentToolAttempt(step),
      {
        claimMs,
        // Started only by `runAgentTool`, which waits for the attempt: no
        // wake job for the accept or the claim. A reset loses nothing; the
        // next start makes the interrupted attempt due.
        attached: true,
        onStatus: (record) => this._onAgentToolTaskStatus(record)
      }
    );
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

    const peeked = this.host.tasks.peek(runId);
    // A run a clear left behind (a reset cut the clear off) is gone: the id
    // starts a new run, as after a clear that finished.
    const task = peeked && this._dropIfCleared(peeked) ? undefined : peeked;
    if (task?.definition === AGENT_TOOL_TASK && !detached) {
      // A re-issue of an awaited run, typically chat recovery re-running the
      // dispatching turn with the same run id. An open run is joined. A
      // settled run returns its result, except `interrupted`, a SOFT
      // terminal: the parent gave up following, but the child may have
      // finished since, so the run starts again under the same id and
      // re-attaches to the child instead of letting the model re-run work
      // the child already did (#1630).
      const settled = this._agentToolTaskResult<Output>(task);
      if (settled && settled.status !== "interrupted") {
        return this._agentToolResultWithOutput<Output>(task, settled);
      }
      if (settled) {
        const meta = this._agentToolTaskMeta(task);
        this.host.tasks.deleteRun(runId);
        if (meta) {
          return this._startAgentToolTask<Output>(runId, meta, {
            input: options.input,
            signal: options.signal,
            meta,
            reissue: true
          });
        }
      }
      return this._waitAgentToolTask<Output>(runId);
    }

    if (task?.definition === AGENT_TOOL_DETACHED_TASK) {
      // Detached re-dispatch (e.g. chat recovery re-running the dispatching
      // turn) is idempotent by run id: the run goes on, or has delivered.
      return { runId, agentType, status: "running" };
    }

    const displayOrder = options.displayOrder ?? 0;
    const inputPreview =
      options.inputPreview ?? this._defaultAgentToolPreview(options.input);
    const startedAt = Date.now();

    const meta: AgentToolTaskMeta = {
      agentType,
      ...(options.parentToolCallId !== undefined
        ? { parentToolCallId: options.parentToolCallId }
        : {}),
      ...(inputPreview !== undefined
        ? { inputPreview: inputPreview as TaskJson }
        : {}),
      ...(options.display !== undefined
        ? { display: options.display as TaskJson }
        : {}),
      displayOrder,
      ...(eventDelivery === "terminal"
        ? { eventDelivery: "terminal" as const }
        : {}),
      startedAt
    };

    if (
      this._activeAgentToolRunCount() >= this.host.maxConcurrentAgentTools()
    ) {
      const error = `maxConcurrentAgentTools (${this.host.maxConcurrentAgentTools()}) exceeded`;
      // Kept as a settled run, so a re-issue returns the same refusal.
      await this.host.tasks.importRun({
        runId,
        definition: AGENT_TOOL_TASK,
        status: "completed",
        attempt: 0,
        metadata: meta,
        result: { runId, agentType, status: "error", error },
        retain: true,
        createdAt: startedAt,
        settledAt: Date.now()
      });
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

    if (!detached) {
      // Counted from here, before the first await, so runs started together
      // all see each other against the cap.
      this._agentToolRunsStarting.add(runId);
      try {
        await this.host.hooks.onAgentToolStart(runInfo);
        this._broadcastAgentToolEvent(options.parentToolCallId, 0, {
          kind: "started",
          runId,
          agentType,
          inputPreview,
          order: displayOrder,
          display: options.display
        });
        return await this._startAgentToolTask<Output>(runId, meta, {
          input: options.input,
          signal: options.signal,
          meta
        });
      } finally {
        this._agentToolRunsStarting.delete(runId);
      }
    }

    // The child must OUTLIVE the dispatching turn, so a detached run never
    // inherits `options.signal` (which aborts when this turn ends). Cancel a
    // detached run explicitly with `cancelAgentTool(runId)`.
    if (options.signal) {
      console.warn(
        `[agents] runAgentTool: \`signal\` is ignored for a detached run (${runId}); a detached child must outlive the spawning turn. Use cancelAgentTool(runId) to cancel it.`
      );
    }
    const detachedMeta: AgentToolTaskMeta = {
      ...meta,
      detached: {
        ...(detached.onFinishName !== undefined
          ? { onFinish: detached.onFinishName }
          : {}),
        ...(detached.notifySource !== undefined
          ? { notifySource: detached.notifySource }
          : {}),
        maxBudgetAt:
          startedAt +
          (detached.maxBudgetMs ?? this.host.options().detachedMaxBudgetMs),
        noProgressBudgetMs:
          detached.noProgressBudgetMs ??
          this.host.options().detachedNoProgressBudgetMs,
        ...(detached.onMilestones !== undefined
          ? { onMilestones: detached.onMilestones }
          : {})
      }
    };
    this._agentToolRunsStarting.add(runId);
    try {
      await this.host.hooks.onAgentToolStart(runInfo);
      this._broadcastAgentToolEvent(options.parentToolCallId, 0, {
        kind: "started",
        runId,
        agentType,
        inputPreview,
        order: displayOrder,
        display: options.display
      });
      let childStarted!: AgentToolTaskLocal["childStarted"];
      const started = new Promise<void>((resolve, reject) => {
        childStarted = { resolve, reject };
      });
      // The first attempt runs here: it starts the child, sets its live
      // tail going beside the run, and parks the run until its next check.
      await this.host.tasks.run(AGENT_TOOL_DETACHED_TASK, null, {
        runId,
        metadata: detachedMeta,
        retain: true,
        start: "now",
        local: {
          input: options.input,
          meta: detachedMeta,
          childStarted
        } satisfies AgentToolTaskLocal
      });
      // A child that could not take the run fails this call, as before; the
      // run also ends `error` and delivers it. (A no-op once settled.)
      childStarted?.resolve();
      await started;
    } finally {
      this._agentToolRunsStarting.delete(runId);
    }
    // Surface runaway accumulation: detached runs hold a slot for their whole
    // life with no observer to notice a leak.
    this._maybeWarnDetachedLiveCount();
    return { runId, agentType, status: "running" };
  }

  /** Accept an awaited run's task, run its first attempt here, and wait for it. */
  private async _startAgentToolTask<Output>(
    runId: string,
    metadata: AgentToolTaskMeta,
    local: AgentToolTaskLocal
  ): Promise<RunAgentToolResult<Output>> {
    // The caller's signal reaches the first attempt through `local`; a run
    // that goes on waiting for a later check is stopped from here.
    const signal = local.signal;
    const onAbort = () => {
      void this.host.tasks
        .cancel(
          runId,
          signal?.reason instanceof Error
            ? signal.reason.message
            : String(signal?.reason ?? "cancelled")
        )
        .catch(() => {});
      void this.host.children
        .resolve(metadata.agentType, runId)
        .then((child) =>
          this._asAgentToolChildAdapter(child).cancelAgentToolRun(
            runId,
            signal?.reason
          )
        )
        .catch(() => {});
    };
    await this.host.tasks.run(AGENT_TOOL_TASK, null, {
      runId,
      metadata,
      retain: true,
      start: "now",
      local
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let result: RunAgentToolResult<Output>;
    try {
      result = await this._waitAgentToolTask<Output>(runId);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    // SAFETY: the attempt set it from this run's own result.
    return (local.fullResult as RunAgentToolResult<Output>) ?? result;
  }

  /**
   * A settled run's result with its output. A record marked
   * `outputOnChild` (the output was too large for it, or a carried row had
   * none) reads it from the child, for at most 2 s; the stored result
   * stands when the child cannot say.
   */
  private async _agentToolResultWithOutput<Output>(
    record: TaskRecord,
    settled: RunAgentToolResult<Output>
  ): Promise<RunAgentToolResult<Output>> {
    const stored = record.result as
      | { outputOnChild?: unknown; outputInInput?: unknown }
      | undefined;
    if (settled.status === "completed" && stored?.outputInInput === true) {
      // A released result too large for a Task value: its run's input.
      return (
        this.host.tasks.inputOf<RunAgentToolResult<Output>>(record.runId) ??
        settled
      );
    }
    if (settled.status !== "completed" || stored?.outputOnChild !== true) {
      return settled;
    }
    const fromChild = await this._settleWithinRecoveryTimeout(
      (async () => {
        const adapter = this._asAgentToolChildAdapter<unknown, Output>(
          await this.host.children.resolve(settled.agentType, settled.runId)
        );
        const inspection = await adapter.inspectAgentToolRun(settled.runId);
        if (inspection?.status !== "completed") return undefined;
        return this._terminalResultFromInspection<Output>(
          settled.agentType,
          inspection
        );
      })(),
      DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS
    );
    return fromChild ?? settled;
  }

  /** The result of an awaited run's task, once its terminal report returned. */
  private async _waitAgentToolTask<Output>(
    runId: string
  ): Promise<RunAgentToolResult<Output>> {
    const record = await this.host.tasks.wait(runId);
    const settled = record && this._agentToolTaskResult<Output>(record);
    if (record && settled) {
      return this._agentToolResultWithOutput<Output>(record, settled);
    }
    return {
      runId,
      agentType: this._agentToolTaskMeta(record)?.agentType ?? "",
      status: "error",
      error: "Agent tool run was deleted before it finished."
    };
  }

  /** An awaited run's metadata, or `undefined` for any other record. */
  private _agentToolTaskMeta(
    record: TaskRecord | null | undefined
  ): AgentToolTaskMeta | undefined {
    if (
      record?.definition !== AGENT_TOOL_TASK &&
      record?.definition !== AGENT_TOOL_DETACHED_TASK
    ) {
      return undefined;
    }
    // SAFETY: written by `runAgentTool` (or the carry-forward) in this shape.
    return record.metadata as AgentToolTaskMeta | undefined;
  }

  /**
   * The agent-tool result a settled run's task holds: the attempt's
   * returned result, or the Task's own `error` or `aborted` ending.
   * `undefined` while the run is open.
   */
  private _agentToolTaskResult<Output>(
    record: TaskRecord
  ): RunAgentToolResult<Output> | undefined {
    const agentType = this._agentToolTaskMeta(record)?.agentType ?? "";
    if (record.status === "completed") {
      // SAFETY: the attempt returns a `RunAgentToolResult` as its value.
      const {
        outputOnChild: _onChild,
        outputInInput: _inInput,
        delivered: _delivered,
        ...result
      } = record.result as unknown as RunAgentToolResult<Output> & {
        outputOnChild?: true;
        outputInInput?: true;
        delivered?: true;
      };
      return result;
    }
    if (record.status === "aborted" || record.status === "skipped") {
      return {
        runId: record.runId,
        agentType,
        status: "aborted",
        error: record.reason ?? "cancelled"
      };
    }
    if (record.status === "error") {
      return {
        runId: record.runId,
        agentType,
        status: "error",
        error: record.error?.message ?? "Agent tool run failed"
      };
    }
    return undefined;
  }

  /**
   * One attempt of an awaited run. The attempt in the isolate that started
   * the run starts the child and follows its live tail. An attempt after a
   * reset re-attaches to the child, within the re-attach budgets. Either way
   * it broadcasts the terminal event and returns the result; the terminal
   * report runs `onAgentToolFinish`.
   */
  async _agentToolAttempt(step: TaskStep): Promise<TaskJson | TaskSettlement> {
    const runId = step.id;
    const local = step.local as AgentToolTaskLocal | undefined;
    const meta =
      local?.meta ?? this._agentToolTaskMeta(this.host.tasks.peek(runId));
    if (!meta) {
      throw new Error(`Agent tool run ${runId} has no metadata`);
    }
    // The caller's signal (in the isolate that started the run) and the
    // run's own (a cancel through Tasks) both stop the run.
    const stop = new AbortController();
    const sources = [local?.signal, step.signal].filter(
      (source): source is AbortSignal => source !== undefined
    );
    const listeners = sources.map((source) => {
      const listener = () => stop.abort(source.reason);
      if (source.aborted) listener();
      else source.addEventListener("abort", listener, { once: true });
      return () => source.removeEventListener("abort", listener);
    });
    const signal = stop.signal;
    let result: RunAgentToolResult;
    let sequence = 1;
    try {
      const followed =
        local && !local.reissue
          ? await this._followLiveAgentToolRun(meta, runId, local.input, signal)
          : await this._reattachAgentToolRun(meta, runId, signal, step);
      // Still running: the run asks the child again later.
      if (followed instanceof TaskSettlement) return followed;
      result = followed.result;
      sequence = followed.sequence;
    } catch (error) {
      result = {
        runId,
        agentType: meta.agentType,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      for (const remove of listeners) remove();
    }
    // A run cancelled through Tasks meanwhile ends `aborted` without this
    // result, and its report sends that terminal frame instead.
    if (!step.signal.aborted) {
      this._broadcastAgentToolTerminal(meta.parentToolCallId, sequence, result);
    }
    return this._agentToolResultForRecord(result, local);
  }

  /**
   * The value a run's record keeps. An output too large for a Task value is
   * left on the child, which keeps it, and the record is marked
   * `outputOnChild`: the caller in this isolate gets the whole result
   * through `local`, and a later reader asks the child.
   */
  private _agentToolResultForRecord(
    result: RunAgentToolResult,
    local?: AgentToolTaskLocal
  ): TaskJson {
    // SAFETY: a `RunAgentToolResult` is JSON (its output came over RPC).
    const value = result as unknown as TaskJson;
    if (this._fitsAgentToolRecord(result)) return value;
    if (local) local.fullResult = result;
    const { output: _output, ...rest } = result;
    return { ...rest, outputOnChild: true } as unknown as TaskJson;
  }

  /** Whether a result, output included, fits a Task value. */
  private _fitsAgentToolRecord(result: RunAgentToolResult): boolean {
    if (result.output === undefined) return true;
    const json = JSON.stringify(result);
    // A UTF-8 byte is at most 3 per UTF-16 unit: skip the encode when it fits.
    if (json.length * 3 <= MAX_SERIALIZED_BYTES) return true;
    return new TextEncoder().encode(json).byteLength <= MAX_SERIALIZED_BYTES;
  }

  /** The terminal report of an awaited run: `onAgentToolFinish`, once settled. */
  async _onAgentToolTaskStatus(record: TaskRecord): Promise<void> {
    const result = this._agentToolTaskResult(record);
    const meta = this._agentToolTaskMeta(record);
    if (!result || !meta) return;
    // A run that ended without an attempt's result (cancelled while it
    // waited for its next check, say): no attempt sent its terminal frame.
    if (record.status !== "completed") {
      this._broadcastAgentToolTerminal(
        meta.parentToolCallId,
        Date.now(),
        result
      );
    }
    // Best-effort, like every recovered or detached finish: a hook that
    // throws goes to `onError` and does not hold the run's report.
    try {
      await this.host.hooks.onAgentToolFinish(
        {
          ...this._agentToolRunInfoFromTask(meta, record.runId),
          status: result.status,
          completedAt: record.settledAt ?? Date.now()
        },
        result
      );
    } catch (error) {
      await this._safeRunOnError(error);
    }
  }

  private _agentToolRunInfoFromTask(
    meta: AgentToolTaskMeta,
    runId: string
  ): AgentToolRunInfo {
    return {
      runId,
      parentToolCallId: meta.parentToolCallId,
      agentType: meta.agentType,
      inputPreview: meta.inputPreview,
      status: "running",
      display: meta.display as AgentToolDisplayMetadata | undefined,
      ...(meta.detached?.notifySource !== undefined
        ? { notifySource: meta.detached.notifySource }
        : {}),
      displayOrder: meta.displayOrder,
      startedAt: meta.startedAt
    };
  }

  /**
   * Start the child's run and follow its live tail to its end, in the
   * isolate that started the run.
   */
  private async _followLiveAgentToolRun(
    meta: AgentToolTaskMeta,
    runId: string,
    input: unknown,
    signal: AbortSignal
  ): Promise<{ result: RunAgentToolResult; sequence: number }> {
    const { agentType, parentToolCallId } = meta;
    const resolveAdapter = async () =>
      this._asAgentToolChildAdapter(
        await this.host.children.resolve(agentType, runId)
      );
    // Replaced with a fresh stub when the child's isolate goes away under
    // the tail.
    let adapter = await resolveAdapter();
    let sequence = 1;
    const aborted = async (): Promise<{
      result: RunAgentToolResult;
      sequence: number;
    }> => {
      await adapter.cancelAgentToolRun(runId, signal.reason).catch(() => {});
      return {
        result: {
          runId,
          agentType,
          status: "aborted",
          error:
            signal.reason instanceof Error
              ? signal.reason.message
              : String(signal.reason ?? "cancelled")
        },
        sequence
      };
    };
    if (signal.aborted) return aborted();

    let childStart: AgentToolRunInspection | undefined;
    // Set when the start call itself failed. The child may still have
    // started the run (its isolate went away under the call): ask the child
    // below, like a run whose tail broke.
    let startFailure: { error: unknown } | undefined;
    try {
      childStart = await adapter.startAgentToolRun(input, {
        runId,
        ...(meta.eventDelivery === "terminal"
          ? { eventDelivery: "terminal" as const }
          : {})
      });
    } catch (error) {
      startFailure = { error };
    }

    const onAbort = () => {
      void adapter.cancelAgentToolRun(runId, signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
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
            parentToolCallId,
            runId,
            sequence,
            AbortSignal.any([signal, watch.ended]),
            undefined,
            cursor
          );
          sequence = cursor.next;
        } else {
          const chunks = await this._readAgentToolChunks(adapter, runId);
          sequence = this._broadcastAgentToolChunks(
            parentToolCallId,
            runId,
            chunks,
            sequence
          );
        }
      } catch {
        if (signal.aborted) return aborted();
        tailBroke = true;
        sequence = cursor.next;
        // The old stub may still name the instance that went away.
        adapter = await resolveAdapter();
      } finally {
        watch.stop();
      }

      if (signal.aborted) return aborted();

      const inspected = await adapter.inspectAgentToolRun(runId);
      if (
        tailBroke &&
        (inspected?.status === "running" || inspected?.status === "starting")
      ) {
        // The child still has the run open: it is recovering the turn. Wait
        // for it the way a recovered parent does, within the same budgets.
        // Awaited here, so the abort relay above stays on until it ends.
        return await this._reattachUntilGivenUp(adapter, meta, runId, sequence);
      }

      const inspection = inspected ?? childStart;
      // The start failed and the child has no such run: the run never
      // began, and the failure is its error.
      if (!inspection) throw startFailure?.error;
      return {
        result: this._terminalResultFromInspection(agentType, inspection),
        sequence
      };
    } catch (error) {
      if (signal.aborted) return aborted();
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * An attempt after a reset: the parent lost its tail. A child that ended
   * meanwhile has its stored chunks replayed to the connected clients and
   * its result returned; a child still running is re-attached to.
   */
  private async _reattachAgentToolRun(
    meta: AgentToolTaskMeta,
    runId: string,
    signal: AbortSignal,
    step: TaskStep
  ): Promise<
    { result: RunAgentToolResult; sequence: number } | TaskSettlement
  > {
    // Bounded: a child that cannot be reached or does not answer must not
    // hold the parent's run for good.
    const reached = await this._settleWithinRecoveryTimeout(
      (async () => {
        const adapter = this._asAgentToolChildAdapter(
          await this.host.children.resolve(meta.agentType, runId)
        );
        return {
          adapter,
          inspection: await adapter.inspectAgentToolRun(runId)
        };
      })().then(
        (value) => ({ ok: true as const, ...value }),
        () => ({ ok: false as const })
      ),
      DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS
    );
    if (!reached?.ok) {
      const reason: AgentToolInterruptedReason = reached
        ? "inspect-failed"
        : "inspect-timeout";
      return {
        result: {
          runId,
          agentType: meta.agentType,
          status: "interrupted",
          reason,
          error: this._interruptedMessageForReason(reason)
        },
        sequence: 1
      };
    }
    const { adapter, inspection } = reached;
    const onAbort = () => {
      void adapter.cancelAgentToolRun(runId, signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await this._reattachReached(
        meta,
        runId,
        signal,
        adapter,
        inspection,
        step
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async _reattachReached(
    meta: AgentToolTaskMeta,
    runId: string,
    signal: AbortSignal,
    adapter: AgentToolChildAdapter,
    inspection: AgentToolRunInspection | null,
    step: TaskStep
  ): Promise<
    { result: RunAgentToolResult; sequence: number } | TaskSettlement
  > {
    if (signal.aborted) {
      await adapter.cancelAgentToolRun(runId, signal.reason).catch(() => {});
      return {
        result: {
          runId,
          agentType: meta.agentType,
          status: "aborted",
          error: String(signal.reason ?? "cancelled")
        },
        sequence: 1
      };
    }
    if (
      inspection &&
      inspection.status !== "running" &&
      inspection.status !== "starting"
    ) {
      let sequence = 1;
      try {
        sequence = await this._broadcastAgentToolStoredChunksFromAdapter(
          adapter,
          {
            run_id: runId,
            parent_tool_call_id: meta.parentToolCallId ?? null
          },
          sequence
        );
      } catch {
        // The result stands if the replay fails.
      }
      return {
        result: this._terminalResultFromInspection(meta.agentType, inspection),
        sequence
      };
    }
    if (!inspection) {
      // The child has no such run: the parent was reset before the child
      // took it, and the input is not kept on the parent.
      return {
        result: {
          runId,
          agentType: meta.agentType,
          status: "error",
          error:
            "Agent tool run was interrupted before its child started it. Run it again."
        },
        sequence: 1
      };
    }
    return this._pollReattachedAgentToolRun(
      adapter,
      meta,
      runId,
      step,
      inspection
    );
  }

  /**
   * One check of a re-attached run whose child is still running: forward
   * the chunks it stored since the last check, then give up past a
   * re-attach budget or ask again soon. The budgets keep their meaning:
   * `agentToolReattachNoProgressTimeoutMs` since the child last stored a
   * chunk, `agentToolReattachMaxWindowMs` since the first check (the child
   * is torn down then).
   */
  private async _pollReattachedAgentToolRun(
    adapter: AgentToolChildAdapter,
    meta: AgentToolTaskMeta,
    runId: string,
    step: TaskStep,
    inspection: AgentToolRunInspection
  ): Promise<
    { result: RunAgentToolResult; sequence: number } | TaskSettlement
  > {
    const now = Date.now();
    const checkpoint = step.checkpoint;
    const firstAt = checkpoint.get<number>("reattachFirstAt") ?? now;
    let progressAt = checkpoint.get<number>("reattachProgressAt") ?? now;
    const polls = checkpoint.get<number>("reattachPolls") ?? 0;
    // The child's chunks are numbered per stream, and a recovered child
    // turn streams into a new one: the cursor belongs to a stream. Events
    // to clients are numbered on, across streams.
    const streamId = inspection.streamId ?? null;
    let cursor =
      checkpoint.get<string | null>("reattachStream") === streamId
        ? checkpoint.get<number>("reattachCursor")
        : undefined;
    const first = checkpoint.get<number>("reattachNextEvent") === undefined;
    let nextEvent = checkpoint.get<number>("reattachNextEvent") ?? 1;
    // Progress frames and milestones are progress too, though the child
    // stores them beside its chunks.
    const signalAt = Math.max(
      inspection.progress?.at ?? 0,
      inspection.milestones?.at(-1)?.at ?? 0
    );
    if (signalAt > (checkpoint.get<number>("reattachSignalAt") ?? 0)) {
      if (!first) progressAt = now;
      checkpoint.set("reattachSignalAt", signalAt);
    }
    try {
      if (first) {
        // The first check: what the child stored so far reaches clients
        // through the connect replay; follow from its end.
        const stored = await this._readAgentToolChunks(adapter, runId);
        cursor = stored.at(-1)?.sequence ?? -1;
        nextEvent = stored.length + 1;
      } else {
        const fresh = await adapter.getAgentToolChunks(
          runId,
          cursor === undefined ? undefined : { afterSequence: cursor }
        );
        if (fresh.length > 0) {
          nextEvent = this._broadcastAgentToolChunks(
            meta.parentToolCallId,
            runId,
            fresh,
            nextEvent
          );
          cursor = fresh[fresh.length - 1].sequence;
          progressAt = now;
          // Forwarding a child's output is progress for the parent's own
          // turn recovery too (chat hosts credit it; best-effort).
          try {
            await this.host.hooks.onAgentToolStreamProgress();
          } catch {
            // The next forward tries again.
          }
        }
      }
    } catch {
      // The chunks could not be read this time: the budgets still count.
    }
    checkpoint.set("reattachStream", streamId);
    if (cursor !== undefined) checkpoint.set("reattachCursor", cursor);
    checkpoint.set("reattachNextEvent", nextEvent);
    const sequence = nextEvent;
    const maxWindow = this.host.options().agentToolReattachMaxWindowMs;
    const noProgress = this.host.options().agentToolReattachNoProgressTimeoutMs;
    const windowed = maxWindow > 0 && Number.isFinite(maxWindow);
    let reason: AgentToolInterruptedReason | undefined;
    if (windowed && now - firstAt >= maxWindow) {
      reason = "window-exceeded";
    } else if (
      !(noProgress > 0) ||
      (Number.isFinite(noProgress) && now - progressAt >= noProgress)
    ) {
      reason = "no-progress";
    }
    if (reason) {
      const childTornDown = await this._teardownGivenUpAgentToolChild(
        adapter,
        runId,
        reason
      );
      return {
        result: {
          runId,
          agentType: meta.agentType,
          status: "interrupted",
          error: this._interruptedMessageForReason(reason),
          reason,
          childStillRunning: !childTornDown
        },
        sequence
      };
    }
    checkpoint.set("reattachFirstAt", firstAt);
    checkpoint.set("reattachProgressAt", progressAt);
    checkpoint.set("reattachPolls", polls + 1);
    const next = Math.min(
      now + Math.min(1000 * 2 ** polls, AGENT_TOOL_REATTACH_POLL_MAX_MS),
      Number.isFinite(noProgress) ? progressAt + noProgress : Infinity,
      windowed ? firstAt + maxWindow : Infinity
    );
    return TaskSettlement.retry(next);
  }

  /**
   * Follow a child that still has the run open within the re-attach budgets.
   * A spent budget ends the run `interrupted`, a SOFT terminal: the child
   * is torn down only when the hard ceiling was reached.
   */
  private async _reattachUntilGivenUp(
    adapter: AgentToolChildAdapter,
    meta: AgentToolTaskMeta,
    runId: string,
    sequence: number
  ): Promise<{ result: RunAgentToolResult; sequence: number }> {
    const reattach = await this._reattachAgentToolRunToTerminal(
      adapter,
      {
        run_id: runId,
        agent_type: meta.agentType,
        parent_tool_call_id: meta.parentToolCallId ?? null
      },
      sequence,
      this.host.options().agentToolReattachNoProgressTimeoutMs,
      this.host.options().agentToolReattachMaxWindowMs
    );
    if (reattach.result) {
      return { result: reattach.result, sequence: reattach.sequence };
    }
    const childTornDown = await this._teardownGivenUpAgentToolChild(
      adapter,
      runId,
      reattach.reason
    );
    return {
      result: {
        runId,
        agentType: meta.agentType,
        status: "interrupted",
        error: this._interruptedMessageForReason(reattach.reason),
        ...(reattach.reason !== undefined ? { reason: reattach.reason } : {}),
        childStillRunning: !childTornDown
      },
      sequence: reattach.sequence
    };
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
    const everyMs = this.host.options().agentToolReattachNoProgressTimeoutMs;
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

  async cancelAgentTool(runId: string, reason?: unknown): Promise<void> {
    const row = this._readAgentToolRun(runId);
    if (!row) return;
    if (this._isAgentToolRowHardTerminal(row.status)) return;
    const message =
      reason instanceof Error
        ? reason.message
        : String(reason ?? "cancelled by parent");
    // A detached run ends `aborted` first, and its report delivers that
    // once: a check that would see the child's abort below finds the run
    // cancelled. An awaited run is left to its attempt, which sees the
    // child's abort.
    if (row.detached === 1) await this.host.tasks.cancel(runId, message);
    try {
      const child = await this.host.children.resolve(row.agent_type, runId);
      const adapter = this._asAgentToolChildAdapter(child);
      await adapter.cancelAgentToolRun(runId, reason);
    } catch {
      // Best-effort child teardown; the run still ends `aborted`.
    }
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
      const callback = this.host.hooks.method(onFinishName);
      if (typeof callback !== "function") {
        throw new Error(
          `runAgentTool: detached.onFinish "${onFinishName}" is not a method on ${this.host.className}. ` +
            'Pass the NAME of a method (e.g. "onImportDone"), not a closure — ' +
            "closures cannot be rehydrated after the Durable Object is evicted."
        );
      }
    } else if (detached.notify) {
      // `notify` sugar: auto-target the chat-agent notify hook if present.
      // A no-op on a base Agent that does not implement it.
      const notifyHook = this.host.hooks.method(DETACHED_NOTIFY_CALLBACK);
      if (typeof notifyHook === "function") {
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

  /**
   * An `aborted` that the backbone's own give-up caused by cancelling the
   * child. The give-up reports it, so it is not delivered as a finish, whether
   * the parent sees it on the warm tail or on a later tick.
   */
  private _isDetachedGiveUpAbort(inspection: AgentToolRunInspection): boolean {
    return (
      inspection.status === "aborted" &&
      (inspection.error === DETACHED_BUDGET_CANCEL_REASON ||
        inspection.error === DETACHED_SILENT_CANCEL_REASON)
    );
  }

  /** Detached runs still holding a concurrency slot (not settled). */
  private _liveDetachedRunCount(): number {
    return this.host.tasks.peekList({
      definition: AGENT_TOOL_DETACHED_TASK,
      status: ["pending", "running"],
      results: false,
      limit: Number.MAX_SAFE_INTEGER
    }).length;
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
    this.host.emit("agent_tool:detached:live_count_warning", {
      liveCount,
      threshold: DETACHED_LIVE_COUNT_WARN_THRESHOLD
    });
    console.warn(
      `[agents] ${liveCount} detached agent-tool runs are live on this agent (threshold ${DETACHED_LIVE_COUNT_WARN_THRESHOLD}). Detached runs hold a concurrency slot until they finish — make sure they are completing or being cancelled, or lower \`maxConcurrentAgentTools\`.`
    );
  }

  /**
   * One attempt of a detached run. The attempt in the isolate that started
   * the run starts the child and follows its live tail; every attempt then
   * asks the child. A terminal is returned (the report delivers it). Past a
   * budget the child is cancelled and the give-up delivered; otherwise the
   * run checks again on the backbone's cadence.
   */
  async _detachedAgentToolAttempt(
    step: TaskStep
  ): Promise<TaskJson | TaskSettlement> {
    const runId = step.id;
    const local = step.local as AgentToolTaskLocal | undefined;
    const meta =
      local?.meta ?? this._agentToolTaskMeta(this.host.tasks.peek(runId));
    const budget = meta?.detached;
    if (!meta || !budget) {
      throw new Error(`Detached agent tool run ${runId} has no metadata`);
    }
    const { agentType } = meta;
    const fail = (error: unknown): TaskJson =>
      ({
        runId,
        agentType,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }) satisfies RunAgentToolResult as unknown as TaskJson;
    if (local) {
      // In the isolate that started the run: start the child, then follow
      // its tail beside the run (not in it, so no alarm waits on the tail).
      try {
        const adapter = this._asAgentToolChildAdapter(
          await this.host.children.resolve(agentType, runId)
        );
        await adapter.startAgentToolRun(local.input, { runId });
        local.childStarted?.resolve();
        this.host.ctx.waitUntil(
          this._followDetachedChild(adapter, meta, runId, budget.maxBudgetAt)
        );
      } catch (error) {
        local.childStarted?.reject(error);
        return fail(error);
      }
      // This attempt runs inside `runAgentTool`, perhaps in a turn that
      // holds the chat lane a delivery waits for: it never delivers. The
      // tail's end, or the first check, wakes the run.
      return TaskSettlement.park("child", {
        until: this._detachedNextCheck(step, budget, {
          lastSignalAt: meta.startedAt
        })
      });
    }

    if (step.checkpoint.get<boolean>("owedInInput") === true) {
      // Carried forward from a released version that recorded this outcome
      // but had not delivered it. Milestones the child still has go first.
      const owed = this.host.tasks.inputOf<RunAgentToolResult>(runId);
      if (owed) {
        // Only a run with milestones asks, and only a child still there:
        // asking would create a child that was deleted.
        const asked =
          meta.detached?.onMilestones &&
          this.host.children.has(meta.agentType, runId)
            ? await this._askDetachedChild(meta, runId)
            : null;
        if (asked?.inspection) {
          this._deliverDetachedMilestones(meta, runId, asked.inspection);
        }
        return this._deliverDetachedFromAttempt(meta, owed, step.signal);
      }
    }

    const reached = await this._askDetachedChild(meta, runId);
    const inspection = reached?.inspection ?? null;
    if (inspection) this._deliverDetachedMilestones(meta, runId, inspection);
    if (
      inspection &&
      this._isAgentToolRowHardTerminal(
        inspection.status as AgentToolRunStatus
      ) &&
      !this._isDetachedGiveUpAbort(inspection)
    ) {
      return this._deliverDetachedFromAttempt(
        meta,
        this._terminalResultFromInspection(agentType, inspection),
        step.signal
      );
    }

    const gaveUp = step.checkpoint.get("gaveUp") !== undefined;
    if (gaveUp) {
      // The give-up went out while its teardown was unconfirmed. The child's
      // own abort confirms it now: the run is settled, with no callback.
      if (inspection && this._isDetachedGiveUpAbort(inspection)) {
        return this._detachedGiveUpResult(meta, runId, false, true);
      }
      return TaskSettlement.park("child", {
        until: this._detachedNextCheck(step, budget, { gaveUp: true })
      });
    }

    // Any signal resets the no-progress window: ephemeral progress or a
    // durable milestone. A child that never signalled counts from the start
    // of the run, so a child stuck in its first step is given up on too.
    const latestMilestone = inspection?.milestones?.length
      ? inspection.milestones[inspection.milestones.length - 1].at
      : undefined;
    const lastSignalAt = Math.max(
      meta.startedAt,
      ...[inspection?.progress?.at, latestMilestone].filter(
        (at): at is number => typeof at === "number"
      )
    );
    const now = Date.now();
    const overAbsolute = now >= budget.maxBudgetAt;
    const noProgress = budget.noProgressBudgetMs;
    const overNoProgress =
      typeof noProgress === "number" &&
      noProgress > 0 &&
      Number.isFinite(noProgress) &&
      now - lastSignalAt >= noProgress;
    if (!overAbsolute && !overNoProgress) {
      return TaskSettlement.park("child", {
        until: this._detachedNextCheck(step, budget, { lastSignalAt })
      });
    }

    // Give up: cancel the child, then ask again. A child that ended on its
    // own before the cancel landed has a real result to deliver.
    let afterCancel: AgentToolRunInspection | null = null;
    let tornDown = false;
    if (reached) {
      try {
        await reached.adapter.cancelAgentToolRun(
          runId,
          overAbsolute
            ? DETACHED_BUDGET_CANCEL_REASON
            : DETACHED_SILENT_CANCEL_REASON
        );
        afterCancel = await reached.adapter.inspectAgentToolRun(runId);
        tornDown = true;
      } catch {
        // Unconfirmed: the child may still finish, and is followed.
      }
    }
    if (afterCancel) this._deliverDetachedMilestones(meta, runId, afterCancel);
    if (
      afterCancel &&
      this._isAgentToolRowHardTerminal(
        afterCancel.status as AgentToolRunStatus
      ) &&
      !this._isDetachedGiveUpAbort(afterCancel)
    ) {
      return this._deliverDetachedFromAttempt(
        meta,
        this._terminalResultFromInspection(agentType, afterCancel),
        step.signal
      );
    }
    const giveUp = this._detachedGiveUpResult(
      meta,
      runId,
      overAbsolute,
      false,
      !tornDown
    ) as unknown as RunAgentToolResult;
    try {
      await this._deliverDetachedOutcome(meta, giveUp);
    } catch {
      // The callback failed: give up again on the next check.
      return TaskSettlement.park("give-up", {
        until: Date.now() + DETACHED_DELIVERY_RETRY_MS
      });
    }
    if (tornDown) return { ...giveUp, delivered: true } as unknown as TaskJson;
    // Keep following a child that may still be running: its late real
    // result is delivered too (#1752).
    // The give-up it delivered, which replay to a client shows meanwhile.
    step.checkpoint.set("gaveUp", giveUp as unknown as TaskJson);
    return TaskSettlement.park("child", {
      until: this._detachedNextCheck(step, budget, { gaveUp: true })
    });
  }

  /**
   * Follow a detached run's live tail while this isolate lives: forward the
   * child's chunks to clients, and when the tail ends wake the run so it
   * delivers now instead of at its next check.
   */
  private async _followDetachedChild(
    adapter: AgentToolChildAdapter,
    meta: AgentToolTaskMeta,
    runId: string,
    maxBudgetAt: number
  ): Promise<void> {
    try {
      if (adapter.tailAgentToolRun) {
        const stream = await adapter.tailAgentToolRun(runId, {
          afterSequence: -1
        });
        await this._forwardAgentToolStream(
          stream,
          meta.parentToolCallId,
          runId,
          1,
          AbortSignal.timeout(Math.max(1, maxBudgetAt - Date.now()))
        );
      }
      // False when the run is not parked (its attempt is still running, or
      // it ended): it then delivers on its own.
      await this.host.tasks.settle(runId, TaskSettlement.retry(Date.now()));
    } catch {
      // The run's own checks deliver.
    }
  }

  /**
   * Deliver a detached run's terminal from one of its checks, then settle
   * it marked `delivered`. A check runs from the run's wake, with the
   * dispatch budget, so waiting for the chat lane here holds no job. A
   * failed callback checks again later; a reset re-runs the check, which
   * delivers again (at least once).
   */
  private async _deliverDetachedFromAttempt(
    meta: AgentToolTaskMeta,
    result: RunAgentToolResult,
    signal: AbortSignal
  ): Promise<TaskJson | TaskSettlement> {
    // A run cancelled meanwhile ended `aborted`; its report delivers that.
    if (signal.aborted) return result as unknown as TaskJson;
    try {
      await this._deliverDetachedOutcome(meta, result);
    } catch {
      return TaskSettlement.park("finish", {
        until: Date.now() + DETACHED_DELIVERY_RETRY_MS
      });
    }
    // An output too large for a Task value stays on the child, as for an
    // awaited run: the run settles with the rest, never failing after its
    // delivery went out.
    const recorded = this._agentToolResultForRecord(result) as Record<
      string,
      TaskJson
    >;
    return { ...recorded, delivered: true };
  }

  /** The give-up result of a detached run; `delivered` when it went out. */
  private _detachedGiveUpResult(
    meta: AgentToolTaskMeta,
    runId: string,
    overAbsolute: boolean,
    delivered: boolean,
    childStillRunning = false
  ): TaskJson {
    return {
      runId,
      agentType: meta.agentType,
      status: "interrupted",
      error: overAbsolute
        ? "detached run exceeded its budget before completing"
        : "detached run went silent past its no-progress window",
      reason: overAbsolute ? "budget-exceeded" : "no-progress",
      childStillRunning,
      ...(delivered ? { delivered: true } : {})
    } as TaskJson;
  }

  /**
   * When a waiting detached run checks on its child next: the backbone's
   * escalating cadence, never past a budget deadline (the absolute one, and
   * the no-progress one counted from `lastSignalAt` when the window is on).
   * A run that already gave up, still following a child whose teardown was
   * unconfirmed, has no deadline left: it keeps to the cadence.
   */
  private _detachedNextCheck(
    step: TaskStep,
    budget: NonNullable<AgentToolTaskMeta["detached"]>,
    {
      lastSignalAt,
      gaveUp = false
    }: { lastSignalAt?: number; gaveUp?: boolean }
  ): number {
    const now = Date.now();
    const index = Math.min(
      Math.max(0, step.attempt - 1),
      DETACHED_BACKBONE_CADENCE_S.length - 1
    );
    const window = budget.noProgressBudgetMs;
    const deadlines = gaveUp
      ? []
      : [
          budget.maxBudgetAt,
          lastSignalAt !== undefined &&
          typeof window === "number" &&
          window > 0 &&
          Number.isFinite(window)
            ? lastSignalAt + window
            : Number.POSITIVE_INFINITY
        ];
    return Math.min(
      now + DETACHED_BACKBONE_CADENCE_S[index] * 1000,
      ...deadlines
    );
  }

  /** Ask a detached run's child for its run, for at most 2 s. */
  private async _askDetachedChild(
    meta: AgentToolTaskMeta,
    runId: string
  ): Promise<
    | {
        adapter: AgentToolChildAdapter;
        inspection: AgentToolRunInspection | null;
      }
    | undefined
  > {
    return this._settleWithinRecoveryTimeout(
      (async () => {
        const adapter = this._asAgentToolChildAdapter(
          await this.host.children.resolve(meta.agentType, runId)
        );
        return {
          adapter,
          inspection: await adapter.inspectAgentToolRun(runId)
        };
      })(),
      DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS
    );
  }

  /** Deliver the configured milestones a child reports. Idempotent. */
  private _deliverDetachedMilestones(
    meta: AgentToolTaskMeta,
    runId: string,
    inspection: AgentToolRunInspection
  ): void {
    if (!inspection.milestones || !meta.detached?.onMilestones) return;
    const runInfo = this._agentToolRunInfoFromTask(meta, runId);
    for (const milestone of inspection.milestones) {
      this._maybeDeliverDetachedMilestone(meta, runInfo, milestone);
    }
  }

  /**
   * The terminal report of a detached run: broadcast its terminal frame and
   * deliver it, unless it is a give-up that already went out. A failing
   * per-run callback throws, so Tasks reports it again 30 s later.
   */
  async _onDetachedAgentToolStatus(record: TaskRecord): Promise<void> {
    const meta = this._agentToolTaskMeta(record);
    const result = this._agentToolTaskResult(record);
    if (!meta || !result) return;
    const stored = record.result as { delivered?: unknown } | undefined;
    if (stored?.delivered === true) return;
    if (record.reason === AGENT_TOOL_CLEARED_REASON) return;
    // What no check delivered: a cancel, or a child that could not take the
    // run. A report can run inside a job with no dispatch budget, so it
    // delivers without waiting for the chat lane, as an explicit cancel
    // always has.
    await this._deliverDetachedOutcome(meta, result, false);
  }

  /**
   * Deliver one outcome of a detached run: its terminal frame, the global
   * `onAgentToolFinish` and the per-run `onFinish` (or `notify`), inside
   * the host's delivery context. At least once: the handler is idempotent.
   */
  private async _deliverDetachedOutcome(
    meta: AgentToolTaskMeta,
    result: RunAgentToolResult,
    serialize = true
  ): Promise<void> {
    const completedAt = Date.now();
    this._broadcastAgentToolTerminal(
      meta.parentToolCallId,
      completedAt,
      result
    );
    const runInfo: AgentToolRunInfo = {
      ...this._agentToolRunInfoFromTask(meta, result.runId),
      status: result.status,
      completedAt
    };
    const lifecycle: AgentToolLifecycleResult = {
      status: result.status,
      ...(result.summary !== undefined ? { summary: result.summary } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.childStillRunning !== undefined
        ? { childStillRunning: result.childStillRunning }
        : {})
    };
    const callbackName = meta.detached?.onFinish;
    const invoke = async () => {
      // Global metering hook fires for detached runs too.
      try {
        await this.host.hooks.onAgentToolFinish(runInfo, lifecycle);
      } catch (error) {
        await this._safeRunOnError(error);
      }
      if (!callbackName) return;
      const callback = this.host.hooks.method(callbackName);
      if (typeof callback !== "function") return;
      try {
        await (
          callback as (
            run: AgentToolRunInfo,
            res: AgentToolLifecycleResult
          ) => Promise<void>
        )(runInfo, lifecycle);
      } catch (error) {
        this.host.emit("agent_tool:detached:delivery_failed", {
          runId: result.runId,
          kind: result.status === "interrupted" ? "give_up" : "finish",
          status: result.status,
          callback: callbackName,
          error: error instanceof Error ? error.message : String(error)
        });
        await this._safeRunOnError(error);
        throw error;
      }
    };
    // A check delivers serialized against the host's turn queue (a state-
    // mutating `onFinish` never interleaves with a turn); a report does not.
    await this.host.hooks.runDetachedDelivery(invoke, { serialize });
  }

  private async _safeRunOnError(error: unknown): Promise<void> {
    try {
      await this.host.hooks.onError(error);
    } catch {
      // Delivery hooks are best-effort; a failing onError must not wedge the
      // ledger or other detached runs.
    }
  }

  hasAgentToolRun(classOrName: SubAgentClass | string, runId: string): boolean {
    const agentType =
      typeof classOrName === "string" ? classOrName : classOrName.name;
    return this._readAgentToolRun(runId)?.agent_type === agentType;
  }

  async clearAgentToolRuns(options?: {
    olderThan?: number;
    status?: AgentToolRunStatus[];
  }): Promise<void> {
    const statusFilter = options?.status
      ? new Set<string>(options.status)
      : null;
    const retained = this._listAgentToolRuns().filter((row) => {
      if (statusFilter && !statusFilter.has(row.status)) return false;
      if (
        options?.olderThan !== undefined &&
        row.started_at >= options.olderThan
      ) {
        return false;
      }
      return true;
    });

    for (const row of retained) {
      // Its task, not its row: a detached run that gave up while its child
      // may still finish shows `interrupted` but is still open.
      const open = this.host.tasks.peek(row.run_id)?.status;
      if (open === "pending" || open === "running") {
        // The cancel aborts the run's attempt, which stops following the
        // child. A cleared detached run delivers nothing.
        await this.host.tasks.cancel(row.run_id, AGENT_TOOL_CLEARED_REASON);
      }
      // The run goes before its child is cleaned up, so a reset during the
      // cleanup leaves no cleared run behind (one a reset cut off inside the
      // cancel is dropped when the runs are next listed).
      this.host.tasks.deleteRun(row.run_id);
      if (open === "pending" || open === "running") {
        try {
          const child = await this.host.children.resolve(
            row.agent_type,
            row.run_id
          );
          await this._asAgentToolChildAdapter(child).cancelAgentToolRun(
            row.run_id,
            "clearing agent tool run"
          );
        } catch {
          // Best effort: deleting the child below stops it either way.
        }
      }
      try {
        // By name: the class an export resolves to need not carry it.
        await this.host.children.delete(row.agent_type, row.run_id);
      } catch {
        // Best effort, as the release's clear was.
      }
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

  _activeAgentToolRunCount(): number {
    const open = new Set(this._agentToolRunsStarting);
    for (const record of this.host.tasks.peekList({
      definition: AGENT_TOOL_DEFINITIONS,
      status: ["pending", "running"],
      results: false,
      limit: Number.MAX_SAFE_INTEGER
    })) {
      open.add(record.runId);
    }
    return open.size;
  }

  /** Every run this agent keeps, awaited and detached, oldest first. */
  private _listAgentToolRuns(): AgentToolRunStorageRow[] {
    // One read for both definitions (a connect's replay, a clear).
    return this.host.tasks
      .peekList({
        definition: AGENT_TOOL_DEFINITIONS,
        order: "oldest",
        limit: Number.MAX_SAFE_INTEGER
      })
      .filter((record) => !this._dropIfCleared(record))
      .map((record) => this._agentToolRowFromTask(record))
      .filter((row): row is AgentToolRunStorageRow => row !== null)
      .sort((left, right) => left.started_at - right.started_at);
  }

  /**
   * Delete a run a clear cancelled but a reset stopped before it was
   * deleted. Returns whether it was one.
   */
  private _dropIfCleared(record: TaskRecord): boolean {
    if (
      record.status !== "aborted" ||
      record.reason !== AGENT_TOOL_CLEARED_REASON
    ) {
      return false;
    }
    this.host.tasks.deleteRun(record.runId);
    return true;
  }

  /** A run's task, read in the shape of a released `cf_agent_tool_runs` row. */
  private _agentToolRowFromTask(
    record: TaskRecord | undefined
  ): AgentToolRunStorageRow | null {
    const meta = this._agentToolTaskMeta(record);
    if (!record || !meta) return null;
    // A detached run that gave up while its child may still finish shows
    // the give-up it delivered until the child's own end.
    const gaveUp =
      meta.detached &&
      (record.status === "pending" || record.status === "running")
        ? this.host.tasks.checkpointOf(record.runId, "gaveUp")
        : undefined;
    const result =
      gaveUp !== undefined && typeof gaveUp === "object"
        ? (gaveUp as unknown as RunAgentToolResult)
        : this._agentToolTaskResult(record);
    return {
      run_id: record.runId,
      parent_tool_call_id: meta.parentToolCallId ?? null,
      agent_type: meta.agentType,
      input_preview:
        meta.inputPreview !== undefined
          ? JSON.stringify(meta.inputPreview)
          : null,
      status: result?.status ?? "running",
      summary: result?.summary ?? null,
      output_json: this._stringifyAgentToolOutput(result?.output),
      error_message: result?.error ?? null,
      interrupted_reason: result?.reason ?? null,
      child_still_running:
        result?.childStillRunning === undefined
          ? null
          : result.childStillRunning
            ? 1
            : 0,
      display_metadata:
        meta.display !== undefined ? JSON.stringify(meta.display) : null,
      display_order: meta.displayOrder,
      started_at: meta.startedAt,
      completed_at: record.settledAt ?? null,
      detached: meta.detached ? 1 : 0,
      detached_on_finish: meta.detached?.onFinish ?? null,
      detached_notify_source: meta.detached?.notifySource ?? null,
      detached_max_budget_at: meta.detached?.maxBudgetAt ?? null,
      finish_claimed_at: null,
      finish_delivered_at: null,
      give_up_claimed_at: null,
      give_up_delivered_at: null
    };
  }

  /**
   * Carry the runs an earlier version kept in `cf_agent_tool_runs` into
   * their tasks, once, then drop the table (a facet empties it instead) and
   * the released backbone's schedule rows.
   *
   * - A settled awaited row becomes a settled run with its result; a result
   *   too large for a Task value goes in the run's input (parted), and its
   *   record says so.
   * - A settled detached row whose delivery went out (`finish_delivered_at`,
   *   or a give-up with the child torn down) becomes a settled run marked
   *   delivered.
   * - Every other row becomes an interrupted run, which Tasks runs again:
   *   an awaited one re-attaches, a detached one asks its child and
   *   delivers what is owed (a give-up that went out is not sent again).
   */
  private _carryingForwardAgentToolRuns: Promise<void> | undefined;

  _carryForwardAgentToolRuns(): Promise<void> {
    // One pass at a time: the pass drops the table it reads.
    this._carryingForwardAgentToolRuns ??=
      this._carryForwardAgentToolRunsOnce().finally(() => {
        this._carryingForwardAgentToolRuns = undefined;
      });
    return this._carryingForwardAgentToolRuns;
  }

  private async _carryForwardAgentToolRunsOnce(): Promise<void> {
    const sql = this.host.ctx.storage.sql;
    if (!hasTable(sql, "cf_agent_tool_runs")) return;
    // `SELECT *`: a table from an old version may lack later columns.
    const rows = sql
      .exec("SELECT * FROM cf_agent_tool_runs ORDER BY started_at ASC")
      .toArray() as Array<
      Partial<AgentToolRunStorageRow> & {
        run_id: string;
        agent_type: string;
        status: AgentToolRunStatus;
        started_at: number;
        event_delivery?: string | null;
      }
    >;
    // A facet empties the table instead of dropping it: a facet dropping
    // old indexed tables at its first start after an upgrade can reset its
    // tree's storage on a deployment (RUNTIME-FACTS). An emptied table is
    // skipped at the next start.
    const facet = this.host.isFacet();
    if (facet && rows.length === 0) return;
    for (const row of rows) {
      try {
        await this.host.tasks.importRun(this._agentToolRunFromLegacyRow(row));
      } catch (error) {
        // A row that cannot be carried stays, and keeps the table, without
        // stopping the others or the start.
        await this._safeRunOnError(error);
        continue;
      }
      // `importRun` writes a run once, so a reset before this delete
      // carries nothing twice.
      sql.exec("DELETE FROM cf_agent_tool_runs WHERE run_id = ?", row.run_id);
    }
    for (const schedule of await this.host.schedules.listSchedules()) {
      if (schedule.callback === LEGACY_DETACHED_RECONCILE_CALLBACK) {
        await this.host.schedules.cancelSchedule(schedule.id);
      }
    }
    const left = sql
      .exec("SELECT COUNT(*) AS n FROM cf_agent_tool_runs")
      .one() as { n: number };
    if (left.n === 0 && !facet) sql.exec("DROP TABLE cf_agent_tool_runs");
  }

  /** The Task run a released `cf_agent_tool_runs` row becomes. */
  private _agentToolRunFromLegacyRow(
    row: Partial<AgentToolRunStorageRow> & {
      run_id: string;
      agent_type: string;
      status: AgentToolRunStatus;
      started_at: number;
      event_delivery?: string | null;
    }
  ): Parameters<Tasks["importRun"]>[0] {
    const inputPreview = this._parseAgentToolJson(row.input_preview ?? null);
    const display = this._parseAgentToolJson(row.display_metadata ?? null);
    const milestones = this._parseAgentToolJson(
      row.detached_on_milestones ?? null
    ) as string[] | { names?: string[]; mode?: "react" | "narrate" } | null;
    const milestoneNames = Array.isArray(milestones)
      ? milestones
      : milestones?.names;
    const detached = row.detached === 1;
    const meta: AgentToolTaskMeta = {
      agentType: row.agent_type,
      ...(row.parent_tool_call_id != null
        ? { parentToolCallId: row.parent_tool_call_id }
        : {}),
      ...(inputPreview !== undefined
        ? { inputPreview: inputPreview as TaskJson }
        : {}),
      ...(display !== undefined ? { display: display as TaskJson } : {}),
      displayOrder: row.display_order ?? 0,
      ...(row.event_delivery === "terminal"
        ? { eventDelivery: "terminal" as const }
        : {}),
      startedAt: row.started_at,
      ...(detached
        ? {
            detached: {
              ...(row.detached_on_finish != null
                ? { onFinish: row.detached_on_finish }
                : {}),
              ...(row.detached_notify_source != null
                ? { notifySource: row.detached_notify_source }
                : {}),
              maxBudgetAt:
                row.detached_max_budget_at ??
                row.started_at + this.host.options().detachedMaxBudgetMs,
              ...(row.detached_no_progress_budget_ms != null
                ? { noProgressBudgetMs: row.detached_no_progress_budget_ms }
                : {}),
              ...(milestoneNames?.length
                ? {
                    onMilestones: {
                      names: milestoneNames,
                      mode: Array.isArray(milestones)
                        ? ("narrate" as const)
                        : (milestones?.mode ?? "narrate")
                    }
                  }
                : {})
            }
          }
        : {})
    };
    const base = {
      runId: row.run_id,
      definition: detached ? AGENT_TOOL_DETACHED_TASK : AGENT_TOOL_TASK,
      metadata: meta,
      retain: true,
      createdAt: row.started_at
    };
    const rerun = (
      checkpoint?: Record<string, TaskJson>,
      input?: TaskJson
    ) => ({
      ...base,
      status: "running" as const,
      attempt: 1,
      ...(checkpoint ? { checkpoint } : {}),
      ...(input !== undefined ? { input } : {})
    });
    const open = row.status === "starting" || row.status === "running";
    if (open) return rerun();
    const result = this._resultFromAgentToolRow({
      run_id: row.run_id,
      agent_type: row.agent_type,
      status: row.status,
      output_json: row.output_json ?? null,
      summary: row.summary ?? null,
      error_message: row.error_message ?? null,
      interrupted_reason: row.interrupted_reason ?? null,
      child_still_running: row.child_still_running ?? null
    });
    const settled = (value: TaskJson, input?: TaskJson) => ({
      ...base,
      status: "completed" as const,
      attempt: 0,
      result: value,
      ...(input !== undefined ? { input } : {}),
      settledAt: row.completed_at ?? row.started_at
    });
    if (detached) {
      const gaveUp = row.give_up_delivered_at != null;
      if (row.status === "interrupted") {
        // The give-up went out and the child was torn down: settled.
        if (gaveUp && row.child_still_running === 0) {
          return settled({ ...result, delivered: true } as unknown as TaskJson);
        }
        // Still owed, or the child may still finish: run it again.
        return rerun(
          gaveUp ? { gaveUp: result as unknown as TaskJson } : undefined
        );
      }
      if (row.finish_delivered_at != null) {
        return settled({ ...result, delivered: true } as unknown as TaskJson);
      }
      // A terminal whose delivery is owed: the next attempt delivers the
      // recorded outcome (kept as the run's input), whether or not the
      // child is still there to ask.
      return rerun({ owedInInput: true }, result as unknown as TaskJson);
    }
    if (!this._fitsAgentToolRecord(result)) {
      // Too large for a Task value: the whole result is the run's input.
      const { output: _output, ...rest } = result;
      return settled(
        { ...rest, outputInInput: true } as unknown as TaskJson,
        result as unknown as TaskJson
      );
    }
    return settled({
      ...result,
      // An older version may have kept no output: ask the child.
      ...(result.status === "completed" && result.output === undefined
        ? { outputOnChild: true }
        : {})
    } as unknown as TaskJson);
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

  /** A run, read from its task in the shape of a released row. */
  private _readAgentToolRun(runId: string): AgentToolRunStorageRow | null {
    const record = this.host.tasks.peek(runId);
    if (record && this._dropIfCleared(record)) return null;
    return this._agentToolRowFromTask(record);
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
    row: Pick<
      AgentToolRunStorageRow,
      | "run_id"
      | "agent_type"
      | "status"
      | "output_json"
      | "summary"
      | "error_message"
      | "interrupted_reason"
      | "child_still_running"
    >
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
      this.host.broadcast(body);
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
    // Detached runs are always delivered in full.
    return (
      this._agentToolTaskMeta(this.host.tasks.peek(runId))?.eventDelivery ===
      "terminal"
    );
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
    // A replay works from a snapshot of the runs: one cleared meanwhile has
    // no task, and resolving it would create its child again.
    if (replay && !this.host.tasks.peek(row.run_id)) return sequence;
    const deadline = this._agentToolRecoveryDeadline(timeoutMs);
    const resolving = this.host.children.resolve(row.agent_type, row.run_id);
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
    const chunks = await this._settleWithinRecoveryTimeout(
      this._readAgentToolChunks(adapter, row.run_id),
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
            await this.host.hooks.onAgentToolStreamProgress();
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
    const meta = this._agentToolTaskMeta(this.host.tasks.peek(runId));
    if (!meta) return;
    const runInfo = this._agentToolRunInfoFromTask(meta, runId);
    void Promise.resolve(this.host.hooks.onProgress(runInfo, snapshot)).catch(
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
      this._maybeDeliverDetachedMilestone(meta, runInfo, {
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
    meta: AgentToolTaskMeta,
    runInfo: AgentToolRunInfo,
    milestone: AgentToolMilestone
  ): void {
    const configured = meta.detached?.onMilestones;
    if (!configured?.names.includes(milestone.name)) return;
    const mode = configured.mode;
    void Promise.resolve(
      this.host.hooks.deliverDetachedMilestone(runInfo, milestone, mode)
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

    this.host.emit("agent_tool:recovery:reattach", {
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
          const existing = await this._readAgentToolChunks(adapter, row.run_id);
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

  async _replayAgentToolRuns(connection: Connection): Promise<void> {
    for (const row of this._listAgentToolRuns()) {
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

  /**
   * Every stored chunk of a child's run. `getAgentToolChunks` answers one
   * page per call (at most `REPLAY_PAGE_BYTES`, as an RPC reply must stay
   * under 32 MiB), so this reads page after page.
   */
  private async _readAgentToolChunks(
    adapter: AgentToolChildAdapter,
    runId: string
  ): Promise<AgentToolStoredChunk[]> {
    const chunks: AgentToolStoredChunk[] = [];
    await allChunks(
      (afterSequence) =>
        adapter.getAgentToolChunks(
          runId,
          afterSequence === undefined ? undefined : { afterSequence }
        ),
      undefined,
      (chunk) => chunks.push(chunk)
    );
    return chunks;
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
