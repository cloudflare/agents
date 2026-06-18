/**
 * Layer-B recovery decision (pure). Given the data stashed during a turn and the
 * recovered fiber's age, decide whether to byte-exactly re-attach to the AI
 * Gateway run or fall back to the framework's default (regenerate / continue).
 *
 * Kept pure + framework-agnostic so it is trivially unit-testable; the Think
 * subclass (server.ts) just calls it from `onChatRecovery`.
 */

/** What a turn stashes (via `this.stash`) so a later invocation can re-attach. */
export interface ResumeCheckpoint {
  runId: string;
  eventOffset: number;
}

export type ResumePlan =
  | { action: "reattach"; runId: string; fromEvent: number }
  | { action: "fallback"; reason: string };

export interface PlanResumeOptions {
  /** Fiber creation time (ms). Used against the gateway buffer TTL. */
  createdAt?: number;
  /** Now (ms) — injectable for tests. Defaults to Date.now(). */
  now?: number;
  /**
   * Gateway resume buffer TTL (ms). Empirically ~330–360s; default 300s leaves
   * margin so we don't attempt a re-attach the buffer has almost certainly
   * dropped (which would just 404 and waste a round-trip).
   */
  bufferTtlMs?: number;
}

function isCheckpoint(value: unknown): value is ResumeCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.runId === "string" &&
    c.runId.length > 0 &&
    typeof c.eventOffset === "number" &&
    Number.isFinite(c.eventOffset) &&
    c.eventOffset >= 0
  );
}

export function planResume(
  recoveryData: unknown,
  options: PlanResumeOptions = {}
): ResumePlan {
  if (!isCheckpoint(recoveryData)) {
    return {
      action: "fallback",
      reason: "no resume checkpoint stashed (nothing captured before eviction)"
    };
  }

  const now = options.now ?? Date.now();
  const ttl = options.bufferTtlMs ?? 300_000;
  if (options.createdAt !== undefined && now - options.createdAt > ttl) {
    return {
      action: "fallback",
      reason: `run age ${now - options.createdAt}ms exceeds buffer TTL ${ttl}ms — resume would 404`
    };
  }

  return {
    action: "reattach",
    runId: recoveryData.runId,
    fromEvent: recoveryData.eventOffset
  };
}
