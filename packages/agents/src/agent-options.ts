/**
 * Agent's `static options`: the defaults and how a subclass's partial
 * options resolve against them.
 *
 * @internal
 */

import { DEFAULT_KEEP_ALIVE_INTERVAL_MS } from "./lifecycle/keep-alive";
import type { RetryOptions } from "./retries";

// Re-attaching to a still-running child agent-tool run (parent recovery /
// duplicate-runId re-issue) tails it to its REAL terminal result instead of
// abandoning it as `interrupted` and re-running already-completed child work
// (#1630). The budget is PROGRESS-KEYED, not a flat wall clock: it bounds how
// long the parent waits with NO forward progress from the child, and resets
// every time the child forwards a chunk. A child that keeps streaming toward
// terminal is therefore never abandoned mid-flight (the previous flat 120s
// budget abandoned healthy, still-advancing children); only a genuinely
// silent/hung child seals `interrupted` after a full no-progress window.
/** @internal */
export const DEFAULT_AGENT_TOOL_REATTACH_NO_PROGRESS_TIMEOUT_MS = 120_000;
// Optional hard wall-clock ceiling on a single re-attach. Defaults to NO cap
// (#1672): the SDK does not impose an implicit wall-clock bound on a child that
// keeps making forward
// progress — a re-attached parent follows a healthy, still-streaming child for
// as long as it advances, exactly as it would on the live (never-evicted) path.
// A hung/silent child is already bounded by the progress-keyed no-progress
// budget above, and a content-runaway is bounded uniformly (live AND recovery)
// by the child's own `maxRecoveryWork` / `shouldKeepRecovering` — not by a
// parent-only timer that would fire only after an eviction. Integrators that
// want a hard wall-clock cap (and the `window-exceeded` child teardown it
// triggers) can still set `agentToolReattachMaxWindowMs` to a finite value.
/** @internal */
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
const DEFAULT_DETACHED_MAX_BUDGET_MS = 24 * 60 * 60 * 1000;
// Resetting no-progress window for detached runs: once a child has emitted at
// least one `reportProgress` signal, the parent gives up if it then goes silent
// for this long (the window resets on every signal). A child that never signals
// is bounded only by the absolute `detachedMaxBudgetMs` ceiling — we never give
// up on a run merely for taking a long time, only for going silent after it
// started reporting. Matches `rfc-chat-recovery-work-budget`.
const DEFAULT_DETACHED_NO_PROGRESS_BUDGET_MS = 60 * 60 * 1000;

/**
 * Default options for Agent configuration.
 * Child classes can override specific options without spreading.
 */
export const DEFAULT_AGENT_STATIC_OPTIONS = {
  /** Whether to send identity (name, agent) to clients on connect */
  sendIdentityOnConnect: true,
  /**
   * Timeout in seconds before a running interval schedule is considered "hung"
   * and force-reset. Increase this if you have callbacks that legitimately
   * take longer than 30 seconds.
   */
  hungScheduleTimeoutSeconds: 30,
  /**
   * Interval in milliseconds for keepAlive() alarm heartbeats.
   * Lower values mean faster recovery after eviction but more frequent alarms.
   */
  keepAliveIntervalMs: DEFAULT_KEEP_ALIVE_INTERVAL_MS,
  /** Default retry options for schedule(), queue(), and this.retry() */
  retry: {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 3000
  } satisfies Required<RetryOptions>,
  /** Timeout for internal framework fiber recovery hooks. */
  fiberRecoveryHookTimeoutMs: 10_000,
  /** Soft deadline for one interrupted-fiber recovery scan. */
  fiberRecoveryScanDeadlineMs: 10_000,
  /**
   * Maximum age of an unmanaged interrupted-fiber row before recovery gives
   * up. Bounds repeated retries of a `onFiberRecovered()` hook that keeps
   * throwing so a poison row cannot re-trigger forever across boots.
   */
  fiberRecoveryMaxAgeMs: 24 * 60 * 60 * 1000,
  /**
   * No-progress budget (ms) for re-attaching to a still-running agent-tool
   * child after a deploy / parent recovery (#1630). Bounds how long the parent
   * waits with NO forward progress from the child; it resets on every forwarded
   * chunk, so a child that keeps streaming is never abandoned mid-flight. Only a
   * genuinely silent/hung child seals `interrupted` after a full window. Raise
   * for children with long quiet stretches between outputs.
   */
  agentToolReattachNoProgressTimeoutMs:
    DEFAULT_AGENT_TOOL_REATTACH_NO_PROGRESS_TIMEOUT_MS,
  /**
   * Optional hard wall-clock ceiling (ms) on a single agent-tool re-attach
   * (#1630). Caps the total wait even as the no-progress budget re-arms across
   * stream-closes. Defaults to `Infinity` (no implicit cap, #1672): a healthy,
   * still-advancing child is followed for as long as it makes progress — a
   * hung child is bounded by
   * the no-progress budget, and a content-runaway by the child's own
   * `maxRecoveryWork` / `shouldKeepRecovering`. Set a finite value to impose a
   * wall-clock cap (which also tears the child down on `window-exceeded`).
   */
  agentToolReattachMaxWindowMs: DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS,
  detachedMaxBudgetMs: DEFAULT_DETACHED_MAX_BUDGET_MS,
  detachedNoProgressBudgetMs: DEFAULT_DETACHED_NO_PROGRESS_BUDGET_MS,
  /**
   * Consecutive alarm invocations that may end in a Durable Object memory-limit
   * reset (the isolate exceeded its 128 MB limit) before the alarm-boundary
   * circuit breaker stops the platform's auto-retry loop and seals the looping
   * work (#1825). A small budget tolerates a genuinely transient memory spike;
   * a deterministic OOM (the work's footprint, not the platform, is the cause)
   * is bounded here regardless of whether the in-DO recovery budgets could run.
   */
  maxAlarmMemoryLimitStrikes: 3
};

/**
 * Fully resolved agent options — all fields are defined with concrete values.
 */
export interface ResolvedAgentOptions {
  sendIdentityOnConnect: boolean;
  hungScheduleTimeoutSeconds: number;
  keepAliveIntervalMs: number;
  retry: Required<RetryOptions>;
  fiberRecoveryHookTimeoutMs: number;
  fiberRecoveryScanDeadlineMs: number;
  fiberRecoveryMaxAgeMs: number;
  agentToolReattachNoProgressTimeoutMs: number;
  agentToolReattachMaxWindowMs: number;
  detachedMaxBudgetMs: number;
  detachedNoProgressBudgetMs: number;
  maxAlarmMemoryLimitStrikes: number;
}

/**
 * Configuration options for the Agent.
 * Override in subclasses via `static options`.
 * All fields are optional - defaults are applied at runtime.
 */
export interface AgentStaticOptions {
  sendIdentityOnConnect?: boolean;
  hungScheduleTimeoutSeconds?: number;
  /**
   * Interval in milliseconds for keepAlive() alarm heartbeats.
   * Default: 30000 (30 seconds). Lower values mean faster recovery
   * after eviction but more frequent alarms.
   */
  keepAliveIntervalMs?: number;
  /** Default retry options for schedule(), queue(), and this.retry(). */
  retry?: RetryOptions;
  /**
   * Timeout in milliseconds for internal framework fiber recovery hooks.
   * User-defined `onFiberRecovered()` hooks are not timed out by default.
   */
  fiberRecoveryHookTimeoutMs?: number;
  /** Soft deadline in milliseconds for one interrupted-fiber recovery scan. */
  fiberRecoveryScanDeadlineMs?: number;
  /**
   * Maximum age in milliseconds of an unmanaged interrupted-fiber row before
   * recovery stops retrying a repeatedly-throwing `onFiberRecovered()` hook
   * and discards the row (emitting `fiber:recovery:skipped` with reason
   * `max_age_exceeded`). Defaults to 24h.
   *
   * Set to `0` to retain rows indefinitely. NOTE: with `0`, a hook that keeps
   * throwing is retried forever — the recovery alarm backs off exponentially
   * (capped at 5 minutes) so it is not a busy-loop, but the Durable Object
   * stays warm (never idle-evicts) for as long as the un-recoverable row
   * exists. Prefer a finite age unless you intend to inspect/clear such rows
   * yourself.
   */
  fiberRecoveryMaxAgeMs?: number;
  /**
   * No-progress budget in milliseconds for re-attaching to a still-running
   * agent-tool child after a deploy / parent recovery (#1630). Resets on every
   * forwarded chunk, so a steadily-streaming child is never abandoned; only a
   * genuinely silent child seals `interrupted` after a full window.
   * Default: 120000 (2 minutes). Set to `0` to skip waiting (collect only an
   * already-terminal child). Set to `Infinity` to never seal on no-progress —
   * a silent-but-alive child is then followed until its stream closes (or the
   * `agentToolReattachMaxWindowMs` ceiling fires), mirroring that knob's
   * "Infinity = off" convention.
   */
  agentToolReattachNoProgressTimeoutMs?: number;
  /**
   * Optional hard wall-clock ceiling in milliseconds on a single agent-tool
   * re-attach (#1630). Caps the total wait even as the no-progress budget
   * re-arms across stream-closes. Default: `Infinity` (no implicit cap,
   * #1672) — a healthy, still-advancing child is followed for as long as it
   * makes progress, exactly
   * as on the live (never-evicted) path. Set a finite value to impose a
   * wall-clock cap (which also tears the child down on `window-exceeded`); `0`
   * also disables the ceiling.
   */
  agentToolReattachMaxWindowMs?: number;
  /**
   * Absolute safety ceiling in milliseconds for a DETACHED ("background")
   * agent-tool run dispatched via `runAgentTool(cls, { detached: ... })`
   * (rfc-detached-agent-tools). A detached run has no awaiting parent turn, so
   * on expiry the parent gives up watching — delivers the completion hook with
   * `interrupted` / `budget-exceeded` and tears the child down — rather than
   * holding a concurrency slot + live facet forever. Unlike the re-attach
   * window this defaults to a FINITE value (24h) precisely because an abandoned
   * detached run has no observer to notice the leak. Override per-run via
   * `detached: { maxBudgetMs }`.
   */
  detachedMaxBudgetMs?: number;
  /**
   * Resetting no-progress window in milliseconds for a DETACHED agent-tool run
   * (rfc-detached-agent-tools §progress). Once the child has emitted at least
   * one `reportProgress` signal, the parent gives up if the run then goes
   * silent for this long; the window resets on every subsequent signal. A child
   * that never reports progress is bounded only by `detachedMaxBudgetMs` — we
   * never give up on a run merely for taking a long time, only for going silent
   * after it began reporting. Default: 1h. Set `0`/`Infinity` to disable (rely
   * on the absolute ceiling only). Override per-run via
   * `detached: { noProgressBudgetMs }`.
   */
  detachedNoProgressBudgetMs?: number;
  /**
   * Consecutive alarm invocations that may end in a Durable Object memory-limit
   * reset (the isolate exceeded its 128 MB limit) before the alarm-boundary
   * circuit breaker stops the platform's auto-retry loop and seals the looping
   * recovery work (#1825). Default: 3. Set to `0` to seal on the first such
   * reset. The strike counter is written after the reset, so it only advances
   * when that isolate's storage still accepts writes, for example when the
   * reset error came from another isolate such as D1. A Durable Object's own
   * memory-limit reset rejects every later storage call in that invocation, so
   * chat recovery does not rely on this counter: it counts each interrupted
   * attempt in the next isolate (`chatRecovery.maxInterruptedAttempts`, #2613).
   */
  maxAlarmMemoryLimitStrikes?: number;
}

/** Fill every option a subclass left out with its default. @internal */
export function resolveAgentOptions(
  options: AgentStaticOptions | undefined
): ResolvedAgentOptions {
  const d = DEFAULT_AGENT_STATIC_OPTIONS;
  return {
    sendIdentityOnConnect:
      options?.sendIdentityOnConnect ?? d.sendIdentityOnConnect,
    hungScheduleTimeoutSeconds:
      options?.hungScheduleTimeoutSeconds ?? d.hungScheduleTimeoutSeconds,
    keepAliveIntervalMs: options?.keepAliveIntervalMs ?? d.keepAliveIntervalMs,
    retry: {
      maxAttempts: options?.retry?.maxAttempts ?? d.retry.maxAttempts,
      baseDelayMs: options?.retry?.baseDelayMs ?? d.retry.baseDelayMs,
      maxDelayMs: options?.retry?.maxDelayMs ?? d.retry.maxDelayMs
    },
    fiberRecoveryHookTimeoutMs:
      options?.fiberRecoveryHookTimeoutMs ?? d.fiberRecoveryHookTimeoutMs,
    fiberRecoveryScanDeadlineMs:
      options?.fiberRecoveryScanDeadlineMs ?? d.fiberRecoveryScanDeadlineMs,
    fiberRecoveryMaxAgeMs:
      options?.fiberRecoveryMaxAgeMs ?? d.fiberRecoveryMaxAgeMs,
    agentToolReattachNoProgressTimeoutMs:
      options?.agentToolReattachNoProgressTimeoutMs ??
      d.agentToolReattachNoProgressTimeoutMs,
    agentToolReattachMaxWindowMs:
      options?.agentToolReattachMaxWindowMs ?? d.agentToolReattachMaxWindowMs,
    detachedMaxBudgetMs: options?.detachedMaxBudgetMs ?? d.detachedMaxBudgetMs,
    detachedNoProgressBudgetMs:
      options?.detachedNoProgressBudgetMs ?? d.detachedNoProgressBudgetMs,
    maxAlarmMemoryLimitStrikes:
      options?.maxAlarmMemoryLimitStrikes ?? d.maxAlarmMemoryLimitStrikes
  };
}
