/**
 * Shared chat-recovery incident math.
 *
 * `@internal` — sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API. See
 * `design/rfc-chat-recovery-foundation.md`.
 *
 * `@cloudflare/ai-chat` and `@cloudflare/think` previously hand-maintained a
 * byte-identical incident-budget decision (`_beginChatRecoveryIncident`) apart
 * from a package log prefix, the pending-interaction predicate name, and Think's
 * extra client-tool rehydration guard. This module is now the single source of
 * that decision — one pure function both packages call, with one test surface.
 *
 * Pure here means: no Durable Object storage, no global clock, no broadcasts.
 * The caller still owns storage I/O (reading the existing incident, sweeping
 * stale incidents, persisting the result), the progress counter, the
 * pending-interaction predicate, and event emission. This function receives the
 * already-resolved inputs and returns the next incident, whether it is
 * exhausted, and the observability events to emit — keeping the budget logic
 * unit-testable against a deterministic clock with no Workers runtime.
 *
 * The serialized `ChatRecoveryIncident` shape, the storage keys, and the
 * incident-id formula are all part of the persisted cutover contract (see the
 * RFC's "Cutover invariants" table) and MUST NOT change without a migration.
 */

import type {
  ChatRecoveryConfig,
  ChatRecoveryProgressContext,
  ResolvedChatRecoveryConfig
} from "./lifecycle";

/**
 * Whether a recovery is retrying an unanswered user turn or continuing a
 * partial assistant turn. Intentionally NOT part of the incident identity (see
 * {@link chatRecoveryIncidentId}).
 */
export type ChatRecoveryKind = "retry" | "continue";

/**
 * Durable per-incident recovery record.
 *
 * PERSISTED CONTRACT — this shape round-trips across deploys (including the
 * deploy that ships the shared engine, which is itself a deploy-mid-recovery).
 * Fields are added as optional so older persisted incidents keep recovering.
 */
export type ChatRecoveryIncident = {
  incidentId: string;
  requestId: string;
  /** Stable request ID for the whole continuation chain (the recovery root). */
  recoveryRootRequestId?: string;
  recoveryKind: ChatRecoveryKind;
  attempt: number;
  maxAttempts: number;
  status:
    | "detected"
    | "scheduled"
    | "attempting"
    | "completed"
    | "skipped"
    | "exhausted"
    | "failed";
  firstSeenAt: number;
  lastAttemptAt: number;
  /**
   * Epoch ms of the last attempt that observed forward progress. The recovery
   * budget is keyed to this (`now - lastProgressAt > noProgressTimeoutMs`), so a
   * turn that keeps producing content survives churn indefinitely while a
   * genuinely stuck turn is sealed within the window (#1637). Optional for
   * backward-compat — falls back to `firstSeenAt`.
   */
  lastProgressAt?: number;
  reason?: string;
  /**
   * High-water mark of the durable, monotonic recovery-progress counter
   * observed for this incident. Distinguishes a turn making forward progress
   * but repeatedly interrupted by isolate resets (deploys) — which must NOT
   * exhaust the budget — from one that genuinely fails to advance. Sourced from
   * a persisted counter, never the compactable transcript (#1628).
   */
  progress?: number;
  /**
   * Value of the durable progress counter when this incident opened. The
   * runaway-loop work budget is `progress - workBaseline`, compared against
   * `maxRecoveryWork`. Optional for backward-compat — a missing baseline is
   * treated as the current marker (zero work so far), so an in-flight incident
   * from an older build is never falsely sealed.
   */
  workBaseline?: number;
};

// ── Persisted storage keys (cutover contract) ──────────────────────────────

export const CHAT_RECOVERY_INCIDENT_KEY_PREFIX = "cf:chat-recovery:incident:";
/**
 * Durable, monotonic forward-progress counter for recovery budget resets.
 * Bumped at production time when new content is streamed, so it reflects
 * genuinely new content and is immune to reconnects/re-persists; never
 * recomputed from the (compactable) transcript.
 */
export const CHAT_RECOVERY_PROGRESS_KEY = "cf:chat-recovery:progress";
/**
 * Durable record of an in-progress recovery so a "recovering…" status (#1620)
 * can be broadcast live and survive the set/clear happening in different
 * isolates (a continuation runs in a later alarm invocation).
 */
export const CHAT_RECOVERING_KEY = "cf:chat:recovering";
/**
 * Durable record of the last turn that ended in a terminal error / abandoned
 * recovery (#1645). Replayed on the next reconnect via the resume handshake;
 * cleared when a later turn supersedes it.
 */
export const CHAT_LAST_TERMINAL_KEY = "cf:chat:last-terminal";

// ── Budget defaults and tuning constants ───────────────────────────────────

/**
 * Secondary backstop only. The primary recovery bound is the no-progress wall
 * clock; with alarm debounce this cap rarely binds (it catches a pathological
 * tight alarm-loop). Kept high so the no-progress window seals first under
 * normal deploy cadence (#1637).
 */
export const DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS = 10;
/**
 * Runaway-loop guard default. `Infinity` = no SDK-imposed work cap: a turn that
 * keeps making forward progress is never terminated by the framework on its own
 * (rfc-chat-recovery-work-budget). Integrators bound a content-emitting runaway
 * by setting `maxRecoveryWork` or a `shouldKeepRecovering` predicate.
 */
export const DEFAULT_CHAT_RECOVERY_MAX_WORK = Number.POSITIVE_INFINITY;
export const DEFAULT_CHAT_RECOVERY_STABLE_TIMEOUT_MS = 10_000;
/**
 * Delay before retrying a recovery that timed out waiting for stable state.
 * Gives an actively-churning isolate (e.g. a deploy in flight) time to settle.
 */
export const CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS = 3;
export const DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE =
  "The assistant was interrupted and could not recover. Please try again.";
/**
 * Incidents that have not seen a new attempt within this window are assumed
 * abandoned and swept so durable storage does not grow without bound.
 */
export const CHAT_RECOVERY_INCIDENT_TTL_MS = 60 * 60 * 1000;
/** Max keys per Durable Object KV `delete([...])` call. */
export const KV_DELETE_MAX_KEYS = 128;
/**
 * PRIMARY recovery bound (#1637): seal an incident that has made no forward
 * progress for this long. Keyed to `lastProgressAt`, which resets on every
 * progress-bearing attempt — so a turn that keeps producing content survives
 * deploy churn indefinitely, while a genuinely stuck turn dies within 5 min.
 */
export const DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Alarm debounce: recovery alarms bunched within this window collapse into a
 * single attempt. A deploy rollout drops/reconnects the socket several times
 * over ~11–22s; without this, one logical deploy would burn several attempts.
 */
export const CHAT_RECOVERY_ALARM_DEBOUNCE_MS = 30 * 1000;
/**
 * Staleness bound for the live "recovering…" flag (#1620). A flag older than
 * this is treated as abandoned so it can neither pin the indicator on forever
 * nor suppress a genuinely-new recovering signal. NOT a recovery budget.
 */
export const CHAT_RECOVERING_FLAG_TTL_MS = 15 * 60 * 1000;

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Resolve a raw `chatRecovery` config field into the fully-defaulted form the
 * engine reasons about. Identical defaulting in both packages today.
 */
export function resolveChatRecoveryConfig(
  raw: ChatRecoveryConfig | undefined
): ResolvedChatRecoveryConfig {
  const custom = typeof raw === "object" && raw !== null ? raw : undefined;
  return {
    enabled: raw !== false,
    maxAttempts: Math.max(
      1,
      Math.floor(custom?.maxAttempts ?? DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS)
    ),
    stableTimeoutMs: Math.max(
      0,
      Math.floor(
        custom?.stableTimeoutMs ?? DEFAULT_CHAT_RECOVERY_STABLE_TIMEOUT_MS
      )
    ),
    terminalMessage:
      custom?.terminalMessage ?? DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE,
    noProgressTimeoutMs: Math.max(
      0,
      Math.floor(
        custom?.noProgressTimeoutMs ??
          DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS
      )
    ),
    maxRecoveryWork:
      typeof custom?.maxRecoveryWork === "number" && custom.maxRecoveryWork >= 0
        ? custom.maxRecoveryWork
        : DEFAULT_CHAT_RECOVERY_MAX_WORK,
    ...(custom?.shouldKeepRecovering
      ? { shouldKeepRecovering: custom.shouldKeepRecovering }
      : {}),
    ...(custom?.onExhausted ? { onExhausted: custom.onExhausted } : {})
  };
}

/**
 * Stable identifier for a recovery incident.
 *
 * `recoveryKind` is intentionally NOT part of the identity: a single
 * interrupted turn can flip between "retry" (no chunks persisted) and
 * "continue" (partial chunks exist) across restarts, and the attempt budget
 * must be shared so recovery stays bounded by `maxAttempts`. This formula is a
 * cutover invariant.
 */
export function chatRecoveryIncidentId(input: {
  requestId: string;
  recoveryRootRequestId?: string | null;
  latestUserMessageId?: string | null;
  recoveryKind: ChatRecoveryKind;
}): string {
  return [
    input.recoveryRootRequestId ?? input.requestId,
    input.latestUserMessageId ?? ""
  ].join(":");
}

/** Durable storage key for an incident record. */
export function chatRecoveryIncidentKey(incidentId: string): string {
  return `${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}${encodeURIComponent(incidentId)}`;
}

/**
 * Select incident keys that have been inactive past the TTL. Pure over a map of
 * stored incidents; the caller performs the batched delete.
 */
export function selectStaleIncidentKeys(
  entries: Map<string, ChatRecoveryIncident | undefined>,
  now: number
): string[] {
  const staleKeys: string[] = [];
  for (const [key, incident] of entries) {
    const lastActive = incident?.lastAttemptAt ?? incident?.firstSeenAt ?? 0;
    if (now - lastActive > CHAT_RECOVERY_INCIDENT_TTL_MS) {
      staleKeys.push(key);
    }
  }
  return staleKeys;
}

/**
 * Sweep recovery incidents inactive past the TTL from durable storage. Lists by
 * the incident key prefix, selects stale keys (`selectStaleIncidentKeys`), and
 * batch-deletes them — the DO KV `delete([...])` accepts up to
 * `KV_DELETE_MAX_KEYS` per call, collapsing N awaited round-trips into
 * ceil(N / 128). Shared by `AIChatAgent` and `Think` so the sweep policy lives in
 * one place. See `design/rfc-chat-recovery-foundation.md`.
 */
export async function sweepStaleChatRecoveryIncidents(
  storage: Pick<DurableObjectStorage, "list" | "delete">,
  now: number
): Promise<void> {
  const entries = await storage.list<ChatRecoveryIncident>({
    prefix: CHAT_RECOVERY_INCIDENT_KEY_PREFIX
  });
  const staleKeys = selectStaleIncidentKeys(entries, now);
  for (let i = 0; i < staleKeys.length; i += KV_DELETE_MAX_KEYS) {
    await storage.delete(staleKeys.slice(i, i + KV_DELETE_MAX_KEYS));
  }
}

/**
 * Summarize a child agent's persisted recovery incidents for the parent's
 * agent-tool reattach decision: `"in-progress"` if any incident is still live
 * (detected/scheduled/attempting), else `"failed"` if any terminalized
 * (exhausted/failed), else `"none"`. In-progress takes precedence so a parent
 * never gives up on a child that is still recovering. Shared by `AIChatAgent`
 * and `Think`. See `design/rfc-chat-recovery-foundation.md`.
 */
export async function classifyAgentToolChildRecovery(
  storage: Pick<DurableObjectStorage, "list">
): Promise<"in-progress" | "failed" | "none"> {
  const entries = await storage.list<ChatRecoveryIncident>({
    prefix: CHAT_RECOVERY_INCIDENT_KEY_PREFIX
  });
  let failed = false;
  for (const incident of entries.values()) {
    if (
      incident.status === "detected" ||
      incident.status === "scheduled" ||
      incident.status === "attempting"
    ) {
      return "in-progress";
    }
    if (incident.status === "exhausted" || incident.status === "failed") {
      failed = true;
    }
  }
  return failed ? "failed" : "none";
}

/**
 * Read the durable monotonic recovery-progress counter (0 when unset). The value
 * feeds the no-progress budget decision; shared by `AIChatAgent` and `Think`.
 */
export async function readChatRecoveryProgress(
  storage: Pick<DurableObjectStorage, "get">
): Promise<number> {
  return (await storage.get<number>(CHAT_RECOVERY_PROGRESS_KEY)) ?? 0;
}

/**
 * Advance the durable recovery-progress counter by one. Called when genuinely new
 * content is durably flushed (real, reconnect-immune forward progress); shared by
 * `AIChatAgent` and `Think`.
 */
export async function bumpChatRecoveryProgress(
  storage: Pick<DurableObjectStorage, "get" | "put">
): Promise<void> {
  const current = (await storage.get<number>(CHAT_RECOVERY_PROGRESS_KEY)) ?? 0;
  await storage.put(CHAT_RECOVERY_PROGRESS_KEY, current + 1);
}

/**
 * Throttle window for crediting a parent turn's recovery progress from forwarded
 * sub-agent (agent-tool) stream chunks (N9). Forwarding a child's chunks IS
 * forward progress for the parent, but the credit must not write storage per
 * token.
 */
export const AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS = 5_000;

/**
 * Per-isolate throttle gate for agent-tool stream-progress crediting (N9). The
 * `_lastBumpAt` clock is in-memory, so it resets per isolate and the first
 * forwarded chunk after a restart always credits. `shouldCredit(now)` returns
 * `true` at most once per `AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS` window and
 * records the time on each credit. Shared by `AIChatAgent` and `Think`.
 */
export class AgentToolStreamProgressThrottle {
  private _lastBumpAt = 0;
  shouldCredit(now: number): boolean {
    if (now - this._lastBumpAt < AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS) {
      return false;
    }
    this._lastBumpAt = now;
    return true;
  }
}

/**
 * Throttle window for crediting recovery progress from mid-segment streaming
 * content (text/reasoning/tool-input deltas). A milestone chunk credits
 * unconditionally; deltas credit at most once per window so a long single
 * segment registers forward progress across crashes without writing storage per
 * token. 5s is far finer than the 300s no-progress budget, so any crash gap
 * longer than this window over an actively-streaming segment still credits.
 */
export const CHAT_STREAM_PROGRESS_CREDIT_THROTTLE_MS = 5_000;

/**
 * Per-isolate throttle gate for crediting recovery progress from mid-segment
 * streaming-content chunks — the delta arm of {@link shouldCreditStreamProgress}.
 * The `_lastBumpAt` clock is in-memory, so it resets per isolate and the first
 * delta after a restart always credits. Shared by `AIChatAgent` and `Think`.
 */
export class StreamProgressCreditThrottle {
  private _lastBumpAt = 0;
  shouldCredit(now: number): boolean {
    if (now - this._lastBumpAt < CHAT_STREAM_PROGRESS_CREDIT_THROTTLE_MS) {
      return false;
    }
    this._lastBumpAt = now;
    return true;
  }
}

// ── Terminal + recovering status storage glue ──────────────────────────────
//
// Durable records for the terminal-error / "recovering…" reconnect UX. The
// keys (`CHAT_LAST_TERMINAL_KEY`, `CHAT_RECOVERING_KEY`) and the flag TTL are
// cutover-contract constants above; these helpers were byte-identical in both
// packages apart from the recovering-broadcast wire-type enum and broadcast
// wrapper, which are passed in. Shared by `AIChatAgent` and `Think`.

/** Durable record of the last turn that ended in a terminal error (#1645). */
export type ChatTerminalRecord = { requestId: string; body: string };

/**
 * Persist a durable record of the last terminal turn so a client that
 * (re)connects after the turn ended still learns its outcome (#1645). Kept
 * until a later turn supersedes it ({@link clearChatTerminal}); a single record
 * is sufficient because only the most recent terminal is relevant.
 */
export async function recordChatTerminal(
  storage: Pick<DurableObjectStorage, "put">,
  requestId: string,
  body: string
): Promise<void> {
  await storage.put(CHAT_LAST_TERMINAL_KEY, { requestId, body });
}

/** Clear the durable terminal record once a later turn supersedes it (#1645). */
export async function clearChatTerminal(
  storage: Pick<DurableObjectStorage, "delete">
): Promise<void> {
  await storage.delete(CHAT_LAST_TERMINAL_KEY);
}

/** Read the pending terminal record, or `null` if none is stored (#1645). */
export async function pendingChatTerminal(
  storage: Pick<DurableObjectStorage, "get">
): Promise<ChatTerminalRecord | null> {
  return (
    (await storage.get<ChatTerminalRecord>(CHAT_LAST_TERMINAL_KEY)) ?? null
  );
}

/** Durable record shape for the live "recovering…" flag (#1620). */
type RecoveringRecord = { requestId?: string; at?: number };

/**
 * Build the on-connect "recovering…" replay frame (#1620), or `null` when no
 * (non-stale) recovery is in progress. A client that connects between recovery
 * attempts (no active stream) reads the turn as working rather than frozen. A
 * record older than the flag TTL is treated as abandoned (its terminal-clear
 * never ran) and skipped, so a dead recovery can't show "recovering…" forever.
 * `messageType` is the package's recovering wire-type enum.
 */
export async function buildChatRecoveringFrame(
  storage: Pick<DurableObjectStorage, "get">,
  messageType: string,
  now: number
): Promise<Record<string, unknown> | null> {
  const recovering = await storage.get<RecoveringRecord>(CHAT_RECOVERING_KEY);
  if (
    !recovering ||
    now - (recovering.at ?? 0) >= CHAT_RECOVERING_FLAG_TTL_MS
  ) {
    return null;
  }
  return {
    type: messageType,
    recovering: true,
    ...(recovering.requestId ? { id: recovering.requestId } : {})
  };
}

/**
 * Set or clear the live "recovering…" status (#1620). Persists a durable record
 * (so set/clear stay consistent across the isolates a recovery spans) and
 * broadcasts a recovering frame — but only on a genuine transition, so a
 * deploy/reconnect storm (which re-detects recovery many times) doesn't spam
 * the wire. A flag older than the TTL is stale: the owning incident was
 * abandoned without a terminal (e.g. the DO went idle before recovery could
 * resolve), so it is treated as not-recovering and can neither pin the
 * indicator on forever nor suppress a genuinely-new recovering signal.
 * `messageType` is the package's recovering wire-type enum; `broadcast` is the
 * package's chat-broadcast wrapper.
 */
export async function setChatRecovering(
  active: boolean,
  requestId: string | undefined,
  deps: {
    storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
    messageType: string;
    broadcast: (frame: Record<string, unknown>) => void;
    now: number;
  }
): Promise<void> {
  const { storage, messageType, broadcast, now } = deps;
  const existing = await storage.get<RecoveringRecord>(CHAT_RECOVERING_KEY);
  const activeExisting =
    existing && now - (existing.at ?? 0) < CHAT_RECOVERING_FLAG_TTL_MS;
  if (active) {
    if (activeExisting) return; // already recovering — idempotent, no re-broadcast
    await storage.put(CHAT_RECOVERING_KEY, {
      ...(requestId ? { requestId } : {}),
      at: now
    });
  } else {
    if (!existing) return; // not recovering — nothing to clear
    await storage.delete(CHAT_RECOVERING_KEY);
    requestId = requestId ?? existing.requestId;
  }
  broadcast({
    type: messageType,
    recovering: active,
    ...(requestId ? { id: requestId } : {})
  });
}

// ── Incident budget evaluation ─────────────────────────────────────────────

/**
 * Observability event produced by an incident evaluation or a status
 * transition, emitted by the caller. The `detected`/`attempt` events come from
 * the budget evaluation (begin path); the `scheduled` event comes from
 * `ChatRecoveryEngine.scheduleRecovery`; the `completed`/`skipped`/`failed`
 * events come from `ChatRecoveryEngine.updateIncident`. `reason` is carried only
 * by the `skipped`/`failed` transitions that record a cause.
 */
export type ChatRecoveryIncidentEvent = {
  type:
    | "chat:recovery:detected"
    | "chat:recovery:attempt"
    | "chat:recovery:scheduled"
    | "chat:recovery:completed"
    | "chat:recovery:skipped"
    | "chat:recovery:failed";
  incidentId: string;
  requestId: string;
  attempt: number;
  maxAttempts: number;
  recoveryKind: ChatRecoveryKind;
  reason?: string;
};

export type EvaluateChatRecoveryIncidentInput = {
  /** Recovery identity for this turn. */
  identity: {
    requestId: string;
    recoveryRootRequestId?: string | null;
    latestUserMessageId?: string | null;
    recoveryKind: ChatRecoveryKind;
  };
  /** Fully-resolved recovery config. */
  config: ResolvedChatRecoveryConfig;
  /** The existing incident for this identity, or `null` if this is fresh. */
  existing: ChatRecoveryIncident | null;
  /** Current value of the durable monotonic progress counter. */
  currentProgress: number;
  /**
   * Whether the turn is parked on a pending CLIENT interaction (an
   * `input-available` client-tool part or an `approval-requested` part). Such a
   * turn is waiting on the human, not stuck, so it is budget-free.
   */
  awaitingClientInteraction: boolean;
  /** Injected clock (epoch ms) for deterministic tests. */
  now: number;
  /**
   * Invoked when `config.shouldKeepRecovering` throws. Lets each package keep
   * its own log prefix. A throwing predicate is treated as "keep recovering".
   */
  onShouldKeepRecoveringError?: (error: unknown) => void;
};

export type EvaluateChatRecoveryIncidentResult = {
  /** The next incident record to persist. */
  incident: ChatRecoveryIncident;
  /** Whether this incident is now sealed as exhausted. */
  exhausted: boolean;
  /** Observability events to emit, in order. */
  events: ChatRecoveryIncidentEvent[];
};

/**
 * Compute the next recovery incident and budget decision.
 *
 * This is the durable recovery budget — a faithful extraction of
 * `_beginChatRecoveryIncident` from both `AIChatAgent` and `Think`. The
 * instruments are decoupled by what they catch:
 *
 *  - STUCK — no-progress window: `lastProgressAt` resets on every
 *    progress-bearing attempt, so a turn that keeps producing content survives
 *    churn indefinitely; a stuck turn is sealed after `noProgressTimeoutMs`.
 *  - DEBOUNCE — alarms bunched within `CHAT_RECOVERY_ALARM_DEBOUNCE_MS` collapse
 *    into one attempt, so a single rollout's reconnect storm isn't N attempts.
 *  - ALARM-LOOP — the attempt cap (resets on progress) catches a tight
 *    no-progress alarm loop.
 *  - RUNAWAY — the work budget seals a loop that keeps emitting content but
 *    never converges. Keyed to WORK done, not wall-clock. Defaults to no cap.
 *  - CALLER — `shouldKeepRecovering` lets the integrator express a
 *    token/cost/step budget the SDK should not hardcode. Consulted only when no
 *    hard bound has already sealed the incident, and never on first detection.
 *
 * A turn parked on a pending client interaction is budget-free: every bound is
 * suppressed and the no-progress clock kept fresh.
 */
export async function evaluateChatRecoveryIncident(
  input: EvaluateChatRecoveryIncidentInput
): Promise<EvaluateChatRecoveryIncidentResult> {
  const {
    identity,
    config,
    existing,
    currentProgress,
    awaitingClientInteraction,
    now
  } = input;

  const incidentId = chatRecoveryIncidentId(identity);
  const recoveryRootRequestId =
    identity.recoveryRootRequestId ?? identity.requestId;

  // Forward-progress detection. A mid-turn deploy resets the Durable Object;
  // the interrupted continuation is re-detected on the next wake. A turn that
  // followed real progress (more durably-produced content than the last attempt
  // saw) is environmental churn, not a poison turn.
  const prevProgress = existing?.progress ?? 0;
  const madeProgress = existing != null && currentProgress > prevProgress;

  // While a client interaction is pending the turn is budget-free, and the
  // no-progress clock is kept fresh so the turn has a full window once the human
  // finally answers.
  const lastProgressAt =
    madeProgress || awaitingClientInteraction
      ? now
      : (existing?.lastProgressAt ?? existing?.firstSeenAt ?? now);
  const noProgressExceeded =
    existing != null &&
    !awaitingClientInteraction &&
    now - lastProgressAt > config.noProgressTimeoutMs;

  // Reuse the durable progress counter as a work meter. Baseline is captured
  // when the incident opens; `work` is what the turn produced since.
  const workBaseline = existing?.workBaseline ?? currentProgress;
  const progress = Math.max(prevProgress, currentProgress);
  const work = progress - workBaseline;
  const workBudgetExceeded =
    existing != null &&
    Number.isFinite(config.maxRecoveryWork) &&
    work > config.maxRecoveryWork;

  const debounced =
    existing != null &&
    !madeProgress &&
    now - existing.lastAttemptAt < CHAT_RECOVERY_ALARM_DEBOUNCE_MS;

  const attempt = madeProgress
    ? 1
    : debounced
      ? (existing?.attempt ?? 1)
      : (existing?.attempt ?? 0) + 1;

  // Consult the caller predicate only when no hard bound has already sealed the
  // incident — a buggy/expensive hook must not run after we've decided, and a
  // throwing hook must not wedge the turn (log and treat as "continue"). Never
  // called on first detection (existing == null).
  let abortedByCaller = false;
  if (
    existing != null &&
    !awaitingClientInteraction &&
    config.shouldKeepRecovering &&
    !noProgressExceeded &&
    !workBudgetExceeded &&
    attempt <= config.maxAttempts
  ) {
    try {
      const ctx: ChatRecoveryProgressContext = {
        incidentId,
        requestId: identity.requestId,
        recoveryRootRequestId,
        attempt,
        maxAttempts: config.maxAttempts,
        recoveryKind: identity.recoveryKind,
        work,
        ageMs: now - (existing.firstSeenAt ?? now)
      };
      const decision = await config.shouldKeepRecovering(ctx);
      abortedByCaller = decision === false;
    } catch (error) {
      input.onShouldKeepRecoveringError?.(error);
    }
  }

  const exhausted =
    !awaitingClientInteraction &&
    (noProgressExceeded ||
      workBudgetExceeded ||
      abortedByCaller ||
      attempt > config.maxAttempts);

  const incident: ChatRecoveryIncident = {
    incidentId,
    requestId: identity.requestId,
    recoveryRootRequestId,
    recoveryKind: identity.recoveryKind,
    attempt,
    maxAttempts: config.maxAttempts,
    status: exhausted ? "exhausted" : "attempting",
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastAttemptAt: now,
    lastProgressAt,
    progress,
    workBaseline,
    ...(exhausted
      ? {
          reason: workBudgetExceeded
            ? "work_budget_exceeded"
            : noProgressExceeded
              ? "no_progress_timeout"
              : abortedByCaller
                ? "recovery_aborted"
                : "max_attempts_exceeded"
        }
      : {})
  };

  const events: ChatRecoveryIncidentEvent[] = [];
  if (!existing) {
    events.push({
      type: "chat:recovery:detected",
      incidentId,
      requestId: identity.requestId,
      attempt,
      maxAttempts: config.maxAttempts,
      recoveryKind: identity.recoveryKind
    });
  }
  events.push({
    type: "chat:recovery:attempt",
    incidentId,
    requestId: identity.requestId,
    attempt,
    maxAttempts: config.maxAttempts,
    recoveryKind: identity.recoveryKind
  });

  return { incident, exhausted, events };
}
