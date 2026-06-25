import type { Agent, SubAgentClass } from "./index";

export type AgentToolRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "interrupted";

export type AgentToolTerminalStatus = Extract<
  AgentToolRunStatus,
  "completed" | "error" | "aborted" | "interrupted"
>;

/**
 * Machine-readable cause of an `interrupted` seal (#1630 follow-up). Lets a
 * caller branch on WHY a run was abandoned without parsing the human-readable
 * `error` prose, which is not a stable contract.
 *
 * - `no-progress` — the child went silent for a full no-progress window while
 *   the parent was tailing it (genuinely stalled / hung).
 * - `window-exceeded` — a finite `agentToolReattachMaxWindowMs` ceiling elapsed
 *   while the child was still non-terminal. Only fires when an integrator opts
 *   into a hard wall-clock cap (the default ceiling is `Infinity`).
 * - `not-tailable` — the child runtime cannot live-tail, so the parent could
 *   not re-attach to its stream to follow it to terminal.
 * - `inspect-timeout` — inspecting the child timed out during parent recovery.
 * - `inspect-failed` — inspecting the child failed during parent recovery.
 * - `recovery-deadline` — the overall parent-recovery deadline elapsed before
 *   this run could be reconciled.
 * - `budget-exceeded` — a detached run's absolute `maxBudgetMs` ceiling elapsed
 *   before it reached a terminal. The parent gave up watching and tore the
 *   child down. Like `window-exceeded` this is a soft seal: a child that
 *   completes anyway can still repair the run and re-fire the completion hook.
 */
export type AgentToolInterruptedReason =
  | "no-progress"
  | "window-exceeded"
  | "not-tailable"
  | "inspect-timeout"
  | "inspect-failed"
  | "recovery-deadline"
  | "budget-exceeded";

/**
 * Structured failure envelope an `agentTool()` returns when a sub-agent run
 * does not complete. Instead of an opaque error string the parent model would
 * parrot back to the user, the caller (or an orchestration harness) gets a
 * machine-readable signal:
 *
 * - `status` mirrors the underlying terminal status (`error` | `aborted` |
 *   `interrupted`).
 * - `retryable` is `true` only for a transient interruption — the child was
 *   reset or superseded by a deploy / parent recovery and never reached a
 *   logical outcome, so re-dispatching the same run is the right move. A
 *   genuine `error` or an intentional `aborted` is `false`.
 * - `error` stays human-readable for logs and UI.
 */
export type AgentToolFailure = {
  ok: false;
  status: Exclude<AgentToolTerminalStatus, "completed">;
  error: string;
  retryable: boolean;
  /** Present only when `status` is `interrupted` — machine-readable cause. */
  reason?: AgentToolInterruptedReason;
  /**
   * Present only when `status` is `interrupted`. `true` when the child facet was
   * still non-terminal (running / advancing) at the moment the parent stopped
   * waiting; `false` once the parent has torn the child down so it is no longer
   * doing work. Lets a caller decide between re-dispatching vs. reconnecting.
   */
  childStillRunning?: boolean;
};

export type AgentToolDisplayMetadata = {
  name?: string;
  icon?: string;
} & Record<string, unknown>;

/**
 * Reserved chunk type a sub-agent emits via `reportProgress` while it runs.
 * Rides the child's own UI-message stream as a **transient** data part, so it
 * re-broadcasts to the parent's clients (via the parent's tail) and surfaces in
 * `useAgentToolEvents` without persisting into the child's stored message parts.
 * See `design/rfc-detached-agent-tools.md` §"Progress and milestone signaling".
 */
export const AGENT_TOOL_PROGRESS_PART = "data-agent-progress";

/**
 * Reserved chunk type a sub-agent emits via `reportProgress({ milestone })`.
 * Unlike the ephemeral progress part this rides the child's stream as a
 * **persisted** data part, so it survives eviction, replays on drill-in, and
 * re-resolves milestone waiters. See `design/rfc-detached-agent-tools.md`.
 */
export const AGENT_TOOL_MILESTONE_PART = "data-agent-milestone";

/**
 * Ephemeral progress signal a running sub-agent emits with `reportProgress`. The
 * well-known fields drive generic UI (a bar + status line) with no per-app
 * convention; `data` is an app-specific escape hatch that is **live-only** by
 * default (not persisted) unless `reportProgress(p, { persist: true })`. Naming a
 * `milestone` promotes the signal to the **durable** tier: it persists as one row
 * per milestone, replays, and (with `data`) is retained.
 */
export type AgentToolProgress<T = unknown> = {
  /** 0..1 — drives a progress bar. */
  fraction?: number;
  /** Human-readable status line, e.g. "Ingested 40k/80k rows". */
  message?: string;
  /** Coarse stage label, e.g. "scaffolding" | "deploying". */
  phase?: string;
  /**
   * Present ⇒ a **durable** milestone: persisted, replayable, and surfaced as a
   * distinct row in `AgentToolRunState.milestones` / `inspectAgentToolRun`. Use
   * for named phase boundaries ("schema-ready", "preview-ready", "deployed").
   */
  milestone?: string;
  /** App-specific payload; live-only for progress, persisted for milestones. */
  data?: T;
};

/**
 * A durable milestone a sub-agent reached, projected onto `AgentToolRunState`
 * and `inspectAgentToolRun`. `sequence` is monotonic per run so replay/live
 * races dedupe on `(runId, sequence)`.
 */
export type AgentToolMilestone = {
  name: string;
  /** Monotonic per-run ordinal; dedupe key for replay vs live races. */
  sequence: number;
  /** Epoch ms the milestone was reached. */
  at: number;
  /** App-specific payload carried with the milestone (persisted). */
  data?: unknown;
};

/**
 * Latest progress snapshot persisted on the child run row and surfaced through
 * `inspectAgentToolRun` + `AgentToolRunState`. Only the safe-to-inspect fields
 * are retained by default; `at` is the emit timestamp (drives the resetting
 * no-progress budget).
 */
export type AgentToolProgressSnapshot = {
  fraction?: number;
  message?: string;
  phase?: string;
  /**
   * Set when this signal was a durable milestone (`reportProgress({ milestone })`).
   * Lets an `onProgress` consumer branch on milestone vs. ephemeral progress.
   */
  milestone?: string;
  /** Epoch ms of the latest signal. */
  at: number;
  /** Present only when the emitter opted into persisting `data`. */
  data?: unknown;
};

export type AgentToolRunInfo = {
  runId: string;
  parentToolCallId?: string;
  agentType: string;
  inputPreview?: unknown;
  status: AgentToolRunStatus;
  display?: AgentToolDisplayMetadata;
  /**
   * Caller-controlled `metadata.source` for chat-agent `detached.notify`
   * completions. Present only for detached notify runs that supplied one.
   */
  notifySource?: string;
  displayOrder: number;
  startedAt: number;
  completedAt?: number;
};

export type AgentToolLifecycleResult = {
  status: AgentToolTerminalStatus;
  summary?: string;
  error?: string;
  /** Present only when `status` is `interrupted` — machine-readable cause. */
  reason?: AgentToolInterruptedReason;
  /**
   * Present only when `status` is `interrupted`. Whether the child facet was
   * still non-terminal when the parent stopped waiting (before any teardown).
   */
  childStillRunning?: boolean;
};

/**
 * Configuration for a detached ("background") agent-tool run. See
 * `design/rfc-detached-agent-tools.md`.
 *
 * Callbacks are referenced by **method name** on the dispatching agent (the same
 * durable, eviction-surviving pattern as `Agent.schedule`) — never closures,
 * which cannot be rehydrated after the Durable Object is evicted.
 *
 * `Self` is threaded from `runAgentTool(cls, options)` so the method names are
 * type-checked against the calling agent's own methods.
 */
export type DetachedAgentToolConfig<Self = Record<string, unknown>> = {
  /**
   * Method invoked once per terminal delivery. Branch on `result.status`:
   * `"completed" | "error" | "aborted" | "interrupted"`. A budget give-up
   * arrives as `status: "interrupted"` with `reason: "budget-exceeded"`; because
   * `interrupted` is soft, a child that later completes can fire the hook again
   * with `"completed"`, so a give-up never hides a late real result. Make the
   * handler idempotent.
   */
  onFinish?: Extract<keyof Self, string>;
  /**
   * Absolute safety ceiling — a backstop against a child that runs forever. On
   * expiry the parent gives up watching (delivers `onFinish` with
   * `interrupted` / `budget-exceeded`) and tears the child down. Defaults to the
   * parent-level `detachedMaxBudgetMs`.
   */
  maxBudgetMs?: number;
  /**
   * Per-run override of the resetting no-progress window (ms). Once the child
   * emits its first `reportProgress`, the parent gives up if it then goes silent
   * for this long (resets on each signal). Defaults to the parent-level
   * `detachedNoProgressBudgetMs` (1h). `0`/`Infinity` disables it.
   */
  noProgressBudgetMs?: number;
  /**
   * Chat-agent convenience (`@cloudflare/think` / `AIChatAgent`): when the run
   * finishes, inject a message into the chat so the model can react to the
   * result, instead of you wiring `onFinish` by hand. Sugar that auto-targets
   * the agent's `_cfDetachedNotifyFinish` hook; ignored on a base `Agent` that
   * does not implement it, and ignored when `onFinish` is also set (an explicit
   * `onFinish` wins). Pass `{ source }` to fit the injected message into your
   * app's existing metadata taxonomy. Override `formatDetachedCompletion()` to
   * customize the injected text.
   */
  notify?: boolean | { source?: string };
  /**
   * Chat-agent convenience: milestone names that, when the detached run reaches
   * them, surface an idempotent synthetic message in the chat BEFORE the run
   * finishes. Each `(runId, name)` fires at most once (idempotency-keyed),
   * whether observed live or reconciled after eviction. Override the wording via
   * `formatDetachedMilestone()`. Requires a chat host (`@cloudflare/think`); a
   * no-op on a base `Agent`.
   *
   * Two delivery modes (the string-array shorthand defaults to `"narrate"`):
   * - `"narrate"` (default) — inject a synthetic **assistant** message directly
   *   (no inference): a cheap, honest status line ("Found 2 sources…") that does
   *   not trigger a model turn. Best for pure progress narration.
   * - `"react"` — inject a **user-role** turn so the model responds to the
   *   milestone (steer, start dependent work, narrate with context). Costs a
   *   model turn. Opt in for milestones the agent should *act on*.
   */
  onMilestones?: string[] | { names: string[]; mode?: "react" | "narrate" };
};

export type RunAgentToolOptions<
  Input = unknown,
  Self = Record<string, unknown>
> = {
  input: Input;
  runId?: string;
  parentToolCallId?: string;
  displayOrder?: number;
  signal?: AbortSignal;
  inputPreview?: unknown;
  display?: AgentToolDisplayMetadata;
  /**
   * Run the sub-agent **detached**: dispatch it, let the current turn continue,
   * and (optionally) get a durable callback when it finishes. `true` is
   * fire-and-forget (observe via `agent-tool-event` frames + the global
   * `onAgentToolFinish` hook); an object adds the targeted, eviction-surviving
   * `onFinish` callback. A detached run does NOT inherit `options.signal` — it
   * must outlive the spawning turn; cancel it explicitly via `cancelAgentTool`.
   */
  detached?: boolean | DetachedAgentToolConfig<Self>;
};

/**
 * Result of dispatching a detached run. Returns immediately after dispatch
 * rather than after completion.
 */
export type DetachedRunAgentToolResult = {
  runId: string;
  agentType: string;
  /**
   * `"running"` on a successful dispatch; `"error"` if dispatch itself failed
   * (e.g. the `maxConcurrentAgentTools` cap was exceeded — rejected
   * synchronously, no child started, no callback wired).
   */
  status: "running" | "error";
  error?: string;
};

export type RunAgentToolResult<Output = unknown> = {
  runId: string;
  agentType: string;
  status: AgentToolTerminalStatus;
  output?: Output;
  summary?: string;
  error?: string;
  /**
   * Present only when `status` is `interrupted` — a machine-readable cause so
   * callers don't pattern-match the `error` prose (#1630 follow-up).
   */
  reason?: AgentToolInterruptedReason;
  /**
   * Present only when `status` is `interrupted`. `true` when the child facet was
   * still non-terminal (running / advancing) at the moment the parent stopped
   * waiting and before any teardown; `false` once the parent has torn the child
   * down so it is no longer doing work.
   */
  childStillRunning?: boolean;
};

export type ChatCapableAgentClass<T extends Agent = Agent> = SubAgentClass<T>;

export type AgentToolRunInspection<Output = unknown> = {
  runId: string;
  status: Exclude<AgentToolRunStatus, "interrupted">;
  requestId?: string;
  streamId?: string;
  output?: Output;
  summary?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  /**
   * Latest progress snapshot the child has persisted, so a rehydrated parent
   * (recovery / backbone reconcile) can reconstruct "where is this run" and
   * reset the resetting no-progress budget without having tailed the live
   * stream. Absent until the child emits its first `reportProgress`.
   */
  progress?: AgentToolProgressSnapshot;
  /**
   * Durable milestones the child has persisted, ordered by `sequence`. Lets a
   * rehydrated parent (recovery / backbone reconcile) replay milestone-gated
   * work and milestone notifications without having observed the live stream.
   */
  milestones?: AgentToolMilestone[];
};

export type AgentToolStoredChunk = {
  sequence: number;
  body: string;
};

export type AgentToolChildAdapter<Input = unknown, Output = unknown> = {
  startAgentToolRun(
    input: Input,
    options: { runId: string; signal?: AbortSignal }
  ): Promise<AgentToolRunInspection<Output>>;
  cancelAgentToolRun(runId: string, reason?: unknown): Promise<void>;
  inspectAgentToolRun(
    runId: string
  ): Promise<AgentToolRunInspection<Output> | null>;
  getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]>;
  tailAgentToolRun?(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>>;
};

export type AgentToolEvent =
  | {
      kind: "started";
      runId: string;
      agentType: string;
      inputPreview?: unknown;
      order: number;
      display?: AgentToolDisplayMetadata;
    }
  | {
      kind: "chunk";
      runId: string;
      body: string;
    }
  | {
      kind: "finished";
      runId: string;
      summary: string;
    }
  | {
      kind: "error";
      runId: string;
      error: string;
    }
  | {
      kind: "aborted";
      runId: string;
      reason?: string;
    }
  | {
      kind: "interrupted";
      runId: string;
      error: string;
      /** Machine-readable cause of the interrupt (#1630 follow-up). */
      reason?: AgentToolInterruptedReason;
      /**
       * Whether the child facet was still non-terminal when the parent stopped
       * waiting (before any teardown). Lets a UI distinguish a still-running
       * child from one the parent has torn down.
       */
      childStillRunning?: boolean;
    };

export type AgentToolEventMessage = {
  type: "agent-tool-event";
  parentToolCallId?: string;
  sequence: number;
  replay?: true;
  event: AgentToolEvent;
};

export type AgentToolRunPart = { type: string };

export type AgentToolRunState<
  Part extends AgentToolRunPart = AgentToolRunPart
> = {
  runId: string;
  agentType: string;
  parentToolCallId?: string;
  inputPreview?: unknown;
  order: number;
  display?: AgentToolDisplayMetadata;
  status: "running" | "completed" | "error" | "aborted" | "interrupted";
  /**
   * Message parts reconstructed from the child agent's streamed chunks.
   *
   * The default stays framework-neutral so importing `agents` does not require
   * an AI SDK peer. AI SDK consumers can use
   * `AgentToolRunState<UIMessage["parts"][number]>` when they need its exact
   * discriminated union.
   */
  parts: Part[];
  summary?: string;
  error?: string;
  /**
   * Present only when `status` is `interrupted` — machine-readable cause and
   * whether the child is still running, mirrored from the wire event so a UI
   * can render the reason without parsing `error` (#1630 follow-up).
   */
  reason?: AgentToolInterruptedReason;
  childStillRunning?: boolean;
  /**
   * Latest progress snapshot, projected from the child's transient
   * `data-agent-progress` signals so a UI can render a bar / ETA / phase label
   * for a running (especially detached / background) run without drilling in.
   */
  progress?: AgentToolProgressSnapshot;
  /**
   * Durable milestones the run has reached, ordered by `sequence` (deduped
   * across replay/live races). Drives milestone chips / a phase timeline.
   */
  milestones?: AgentToolMilestone[];
  subAgent: { agent: string; name: string };
};

export type AgentToolEventState<
  Part extends AgentToolRunPart = AgentToolRunPart
> = {
  runsById: Record<string, AgentToolRunState<Part>>;
  runsByToolCallId: Record<string, AgentToolRunState<Part>[]>;
  unboundRuns: AgentToolRunState<Part>[];
};
