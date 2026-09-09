/**
 * Policy knobs for the agent-tool parent engine. These are pure numbers —
 * no host bindings, no environment — so a capability can be constructed
 * before the Durable Object it will run in is wired up.
 */

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
// triggers) can still set `reattachMaxWindowMs` to a finite value.
export const DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS =
  Number.POSITIVE_INFINITY;

// Absolute safety ceiling on a DETACHED ("background") agent-tool run
// (rfc-detached-agent-tools). A detached run has no awaiting parent turn and no
// live observer, so unlike the re-attach window above this defaults to a FINITE
// value: an abandoned detached run otherwise holds a concurrency slot + live
// facet forever with nobody to notice the leak. On expiry the parent gives up
// watching (delivers the completion hook with `interrupted`/`budget-exceeded`)
// and tears the child down. 24h is generous enough for video renders / large
// batch jobs while still bounding a genuinely stuck run.
export const DEFAULT_DETACHED_MAX_BUDGET_MS = 24 * 60 * 60 * 1000;

// Resetting no-progress window for detached runs: once a child has emitted at
// least one `reportProgress` signal, the parent gives up if it then goes silent
// for this long (the window resets on every signal). A child that never signals
// is bounded only by the absolute `detachedMaxBudgetMs` ceiling — we never give
// up on a run merely for taking a long time, only for going silent after it
// started reporting. Matches `rfc-chat-recovery-work-budget`.
export const DEFAULT_DETACHED_NO_PROGRESS_BUDGET_MS = 60 * 60 * 1000;

// Bounded wait for one child inspection during startup recovery.
export const DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS = 2_000;

// Deadline for the whole classification sweep of a startup recovery pass.
export const DEFAULT_AGENT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS = 5_000;

// How long a detached terminal-delivery claim is leased before another delivery
// path (a backbone reconcile racing the warm fast path, or a re-delivery after
// a crash mid-handler) may re-claim it. Guards against a double-fire on the
// happy path while guaranteeing at-least-once delivery under failure.
export const DETACHED_DELIVERY_LEASE_MS = 60_000;

// Escalating cadence for the detached reconcile backbone job. The warm fast
// path makes the first entries near-moot; these bound worst-case post-eviction
// latency while keeping steady-state alarm cost low. The job completes (and
// stops waking the object) once no detached run remains outstanding.
export const DETACHED_BACKBONE_CADENCE_S = [5, 15, 30, 120];

// Detached runs hold a `maxConcurrent` slot for their ENTIRE life and have no
// observer to notice them piling up. With the default `Infinity` cap that is a
// real leak footgun, so the framework emits an edge-triggered warning when the
// live (non-terminal) detached count first crosses this threshold, rather than
// silently accumulating. (A separate detached-only cap is deferred until
// evidence shows the single cap conflates two budgets.)
export const DETACHED_LIVE_COUNT_WARN_THRESHOLD = 50;

// Conventional method name a chat agent (Think / AIChatAgent) implements to
// receive `detached: { notify: true }` completions. Resolved by name so the
// base engine stays decoupled from the chat layer.
export const DETACHED_NOTIFY_CALLBACK = "_cfDetachedNotifyFinish";

/** Policy options for the {@link import("./agent-tools").AgentTools} capability. */
export type AgentToolsOptions = {
  /**
   * Maximum number of non-terminal agent-tool runs one parent may own at
   * once. Default: `Infinity`. A host that exposes its own live knob
   * (Agent's `maxConcurrentAgentTools` field) overrides this per dispatch.
   */
  readonly maxConcurrent?: number;
  /**
   * No-progress budget (ms) for re-attaching to a still-running child after a
   * deploy / parent recovery (#1630). Resets on every forwarded chunk, so a
   * steadily-streaming child is never abandoned; only a genuinely silent child
   * seals `interrupted` after a full window. `0` skips waiting entirely;
   * `Infinity` never seals on no-progress.
   */
  readonly reattachNoProgressTimeoutMs?: number;
  /**
   * Optional hard wall-clock ceiling (ms) on a single re-attach (#1630).
   * Default `Infinity` (no implicit cap); a finite value also tears the child
   * down on `window-exceeded`.
   */
  readonly reattachMaxWindowMs?: number;
  /**
   * Absolute safety ceiling (ms) for a DETACHED run. Default 24h. Override
   * per-run via `detached: { maxBudgetMs }`.
   */
  readonly detachedMaxBudgetMs?: number;
  /**
   * Resetting no-progress window (ms) for a DETACHED run, applied only once
   * the child has reported at least one progress signal. Default 1h; `0` or
   * `Infinity` disables it (the absolute ceiling still applies).
   */
  readonly detachedNoProgressBudgetMs?: number;
};

/** @internal Every agent-tool policy knob with a concrete value. */
export type ResolvedAgentToolsOptions = {
  readonly maxConcurrent: number;
  readonly reattachNoProgressTimeoutMs: number;
  readonly reattachMaxWindowMs: number;
  readonly detachedMaxBudgetMs: number;
  readonly detachedNoProgressBudgetMs: number;
};

/** @internal Apply the documented defaults to a partial option bag. */
export function resolveAgentToolsOptions(
  options: AgentToolsOptions
): ResolvedAgentToolsOptions {
  return {
    maxConcurrent: options.maxConcurrent ?? Number.POSITIVE_INFINITY,
    reattachNoProgressTimeoutMs:
      options.reattachNoProgressTimeoutMs ??
      DEFAULT_AGENT_TOOL_REATTACH_NO_PROGRESS_TIMEOUT_MS,
    reattachMaxWindowMs:
      options.reattachMaxWindowMs ?? DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS,
    detachedMaxBudgetMs:
      options.detachedMaxBudgetMs ?? DEFAULT_DETACHED_MAX_BUDGET_MS,
    detachedNoProgressBudgetMs:
      options.detachedNoProgressBudgetMs ??
      DEFAULT_DETACHED_NO_PROGRESS_BUDGET_MS
  };
}
