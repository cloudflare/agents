import type { EventBus } from "../../kernel/events.js";

/**
 * Context-overflow guard (audit 14 §2): classifies chat errors, and — both
 * opt-in — reactively compacts + retries a turn that errored with an
 * overflow, or proactively compacts mid-turn once reported token usage
 * crosses a threshold. Both reuse the session's compaction (injected as
 * `compact`); this module has no opinion on how compaction works.
 */

export type ChatErrorClassification = "context_overflow" | "rate_limit" | "transient" | "fatal" | "unknown";

const OVERFLOW_PHRASES = [
  "prompt is too long",
  "context_length_exceeded",
  "maximum context length",
  "input is too long",
  "too many tokens",
  "exceeds the model's context window",
];

function messageOf(err: unknown): string | undefined {
  if (typeof err === "string") return err;
  if (err instanceof Error && typeof err.message === "string") return err.message;
  return undefined;
}

function causeOf(err: unknown): unknown {
  if (err instanceof Error && "cause" in err) return (err as Error & { cause?: unknown }).cause;
  return undefined;
}

/**
 * Matches common provider phrasings for a context-window overflow,
 * case-insensitively, against `error.message` and walking the `.cause`
 * chain. Non-Error values are inspected directly when they're strings.
 */
export function defaultContextOverflowClassifier(error: unknown): ChatErrorClassification {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = messageOf(current);
    if (message) {
      const lower = message.toLowerCase();
      if (OVERFLOW_PHRASES.some((phrase) => lower.includes(phrase))) {
        return "context_overflow";
      }
    }
    current = causeOf(current);
  }
  return "unknown";
}

export interface OverflowGuard {
  /** Step hook: returns true if a proactive compaction ran. */
  maybeCompactBeforeStep(usage: { inputTokens?: number } | undefined, requestId: string): Promise<boolean>;
  /** Error hook: returns "retry" if the turn should re-run. */
  handleTurnError(error: unknown, requestId: string): Promise<"retry" | "terminal" | "unhandled">;
}

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_COMPACTIONS = 1;
const PROACTIVE_THRESHOLD_RATIO = 0.9;

export function createOverflowGuard(deps: {
  config?: { reactive?: boolean; maxRetries?: number; proactive?: { maxInputTokens: number; maxCompactions?: number } };
  classify?: (e: unknown) => ChatErrorClassification | void;
  compact: () => Promise<{ shortened: boolean }>;
  bus: EventBus;
}): OverflowGuard {
  const classify = deps.classify ?? defaultContextOverflowClassifier;
  const reactiveEnabled = deps.config?.reactive ?? false;
  const maxRetries = deps.config?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const proactiveConfig = deps.config?.proactive;
  const maxCompactions = proactiveConfig?.maxCompactions ?? DEFAULT_MAX_COMPACTIONS;

  /** Reactive retry attempts used, keyed by requestId. */
  const reactiveAttempts = new Map<string, number>();
  /** Proactive compactions used this turn, keyed by requestId. */
  const proactiveCounts = new Map<string, number>();

  async function maybeCompactBeforeStep(
    usage: { inputTokens?: number } | undefined,
    requestId: string,
  ): Promise<boolean> {
    if (!proactiveConfig) return false;
    if (usage?.inputTokens === undefined) return false;

    const used = proactiveCounts.get(requestId) ?? 0;
    if (used >= maxCompactions) return false;

    const threshold = proactiveConfig.maxInputTokens * PROACTIVE_THRESHOLD_RATIO;
    if (usage.inputTokens < threshold) return false;

    const { shortened } = await deps.compact();
    const attempt = used + 1;
    proactiveCounts.set(requestId, attempt);
    deps.bus.emit("chat:context:compacted", { reason: "proactive", shortened, requestId, attempt });
    return true;
  }

  async function handleTurnError(error: unknown, requestId: string): Promise<"retry" | "terminal" | "unhandled"> {
    if (!reactiveEnabled) return "unhandled";

    const classification = classify(error) ?? "unknown";
    if (classification !== "context_overflow") return "unhandled";

    const used = reactiveAttempts.get(requestId) ?? 0;
    if (used >= maxRetries) return "terminal";

    const { shortened } = await deps.compact();
    const attempt = used + 1;
    reactiveAttempts.set(requestId, attempt);
    deps.bus.emit("chat:context:compacted", { reason: "reactive", shortened, requestId, attempt });

    return shortened ? "retry" : "terminal";
  }

  return { maybeCompactBeforeStep, handleTurnError };
}
