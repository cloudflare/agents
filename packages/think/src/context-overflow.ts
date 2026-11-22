/**
 * How Think classifies a turn's stream errors and recovers from a turn that
 * overflows the model's context window.
 *
 * Compaction normally only fires between turns (Session.compactAfter checks
 * the threshold on appendMessage). But a single long, tool-heavy turn grows
 * the prompt step-by-step inside one streamText loop and can exceed the
 * model's context window *mid-turn*, before the next pre-turn check — the
 * provider then 400s ("prompt is too long" / context_length_exceeded). The
 * `contextOverflow` config lets Think recover without baking provider
 * knowledge into core: the app classifies the error (`classifyChatError`),
 * Think reacts.
 *
 * In memory only: the per-run proactive compaction count and the turn's
 * message baseline. Turns are serialized, so one value of each is safe.
 */

import type { ModelMessage } from "ai";
import { ChatStreamStalledError, isDurableObjectResetError } from "agents/chat";
import type {
  ChatErrorClassification,
  ChatErrorContext,
  ContextOverflowConfig,
  PrepareStepContext
} from "./turn-types";

/**
 * Carries an in-stream error that `classifyChatError` marked transient out of
 * the drain loop, so it reaches the same recovery routing as a thrown error.
 * `original` is the provider error the stream reported, when it had one.
 */
export class TransientChatStreamError extends Error {
  constructor(
    message: string,
    readonly classification: ChatErrorClassification,
    readonly original: unknown
  ) {
    super(message);
    this.name = "TransientChatStreamError";
  }
}

/** Whether a classification routes the turn into bounded recovery. */
export function isTransientClassification(
  classification: ChatErrorClassification | undefined
): classification is "transient" | "rate_limit" {
  return classification === "transient" || classification === "rate_limit";
}

/** What {@link ThinkContextOverflow} reads from its agent. */
export interface ThinkContextOverflowOptions {
  readonly config: () => ContextOverflowConfig | undefined;
  /** Whether the agent overrides `classifyChatError`. */
  readonly classifierOverridden: () => boolean;
  readonly classify: (
    error: unknown,
    ctx: ChatErrorContext
  ) => ChatErrorClassification | void;
  /** Compact the session for the current turn's history. */
  readonly compact: () => Promise<unknown>;
  readonly emit: (
    type: "chat:context:compacted" | "chat:request:failed",
    payload: Record<string, unknown>
  ) => void;
  readonly onChatError: (error: unknown, ctx: ChatErrorContext) => unknown;
  /**
   * The current turn's model messages rebuilt from the (compacted) history,
   * with the reminder the turn was assembled with.
   */
  readonly rebuildMessages: () => Promise<ModelMessage[]>;
}

export class ThinkContextOverflow {
  readonly #options: ThinkContextOverflowOptions;
  /**
   * Count of model messages assembled for the current turn. The proactive
   * guard splices this turn's in-flight steps (everything after it) onto a
   * freshly recompacted head.
   */
  #baseline = 0;
  /**
   * Number of times the proactive guard has compacted within the current
   * run. Capped at `contextOverflow.proactive.maxCompactions` (default `1`)
   * so a guard that keeps reading over-budget usage can't compact on every
   * step — once the head is summarized, further compaction no-ops anyway,
   * and a genuine remaining overflow falls through to the reactive backstop.
   */
  #proactiveCompactions = 0;
  /** One-time guard for the "recovery enabled but no classifier" warning. */
  #warnedMissingClassifier = false;

  constructor(options: ThinkContextOverflowOptions) {
    this.#options = options;
  }

  /** Whether the reactive compact-and-retry backstop is enabled. */
  get reactiveEnabled(): boolean {
    return this.#options.config()?.reactive === true;
  }

  /** Reactive compact-and-retry budget. */
  get maxRetries(): number {
    return this.#options.config()?.maxRetries ?? 1;
  }

  /**
   * Start a model run whose assembled messages number `baseline`. Resets
   * the proactive compaction cap.
   */
  beginRun(baseline: number): void {
    this.#baseline = baseline;
    this.#proactiveCompactions = 0;
  }

  /**
   * The app's `classifyChatError` verdict for a stream error (thrown or
   * surfaced as an in-stream error string). Call once per error: the hook may
   * be stateful or have side effects.
   */
  classifyStreamError(
    error: unknown,
    requestId: string
  ): ChatErrorClassification | undefined {
    if (!this.#options.classifierOverridden()) return undefined;
    try {
      return (
        this.#options.classify(error, { stage: "stream", requestId }) ??
        undefined
      );
    } catch (err) {
      console.warn(
        `[Think] classifyChatError threw; treating as unclassified: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  /**
   * Whether a classified stream error should trigger the opt-in
   * compact-and-retry backstop. Centralized so both stream consumers
   * (WebSocket + RPC) decide identically.
   */
  isRecoverable(classification: ChatErrorClassification | undefined): boolean {
    if (!this.reactiveEnabled) return false;
    // DX guard: enabling recovery without teaching Think which errors are
    // overflows silently does nothing. Warn once instead of failing quietly.
    if (!this.#options.classifierOverridden()) {
      if (!this.#warnedMissingClassifier) {
        this.#warnedMissingClassifier = true;
        console.warn(
          '[Think] contextOverflow.reactive is enabled but classifyChatError() is not overridden, so no error will ever be treated as a context overflow and recovery will never run. Override classifyChatError() (or assign the exported defaultContextOverflowClassifier) to return "context_overflow" for your provider\'s context-window error (e.g. Anthropic "prompt is too long", OpenAI context_length_exceeded).'
        );
      }
      return false;
    }
    return classification === "context_overflow";
  }

  /**
   * The `"transient"` or `"rate_limit"` class the app assigned a stream
   * error, else `undefined`. Such errors route into bounded chat recovery like
   * a stream stall instead of terminalizing the turn (#2085). Without a
   * `classifyChatError` override nothing is transient. A Durable Object reset
   * is never transient here: the restart's own recovery owns the turn.
   */
  transientClassification(
    error: unknown,
    requestId: string
  ): ChatErrorClassification | undefined {
    if (error instanceof TransientChatStreamError) return error.classification;
    if (error instanceof ChatStreamStalledError) return undefined;
    if (isDurableObjectResetError(error)) return undefined;
    const classification = this.classifyStreamError(error, requestId);
    return isTransientClassification(classification)
      ? classification
      : undefined;
  }

  /**
   * Compact the session in response to a context overflow (reactive backstop
   * or proactive guard). Returns whether history was actually shortened — a
   * no-op compaction means a retry would just overflow again, so the caller
   * should fall through to the terminal error rather than loop.
   *
   * This is the single emit point for `chat:context:compacted`.
   */
  async compact(
    reason: "reactive" | "proactive",
    extra?: { requestId?: string; attempt?: number }
  ): Promise<boolean> {
    try {
      const result = await this.#options.compact();
      const shortened = Boolean(result);
      this.#options.emit("chat:context:compacted", {
        reason,
        shortened,
        ...extra
      });
      return shortened;
    } catch (err) {
      console.warn(
        `[Think] context-overflow compaction failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  /**
   * Finalize a context overflow that recovery could not fix (compaction was a
   * no-op, or the retry budget is spent). Routes the error through
   * `onChatError` with `classification: "context_overflow"` and emits
   * `chat:request:failed`, so every overflow terminal is reported the same
   * way. Returns the (possibly app-reshaped) message for the caller to
   * deliver through its own transport.
   */
  finalize(requestId: string, rawError: string | undefined): string {
    const raw = rawError ?? "Context window exceeded.";
    const wrapped = this.#options.onChatError(raw, {
      requestId,
      stage: "stream",
      messagesPersisted: true,
      classification: "context_overflow"
    });
    const message =
      wrapped instanceof Error ? wrapped.message : String(wrapped);
    this.#options.emit("chat:request:failed", {
      requestId,
      stage: "stream",
      messagesPersisted: true,
      error: message
    });
    return message;
  }

  /**
   * Proactive context guard. Runs before each step. If
   * `contextOverflow.proactive` is set and the *previous* step's
   * model-reported input tokens cross the budget, compact the session in
   * place and return recompacted messages for the upcoming step.
   *
   * Keys off `usage.inputTokens` (provider-agnostic) rather than any provider
   * error string. The current turn's in-flight steps (everything after the
   * baseline) are spliced back on so no completed work is lost.
   *
   * Best-effort: any failure returns `undefined` so the step proceeds
   * unchanged and the reactive backstop can still catch a genuine overflow.
   */
  async compactBeforeStep(
    event: PrepareStepContext
  ): Promise<ModelMessage[] | undefined> {
    const guard = this.#options.config()?.proactive;
    if (!guard || guard.maxInputTokens <= 0) return undefined;
    // The proactive cap is independent of the reactive budget, so an app can
    // use either layer alone and tune each freely.
    if (this.#proactiveCompactions >= Math.max(1, guard.maxCompactions ?? 1))
      return undefined;

    const prev = event.steps?.at(-1);
    const used = prev?.usage?.inputTokens ?? prev?.usage?.totalTokens;
    if (used == null || !Number.isFinite(used)) return undefined;

    const headroom = guard.headroom ?? 0.9;
    if (used < guard.maxInputTokens * headroom) return undefined;

    try {
      // Count the ATTEMPT (not just successful shortenings) before compacting.
      // A no-op compaction would be a no-op again on every later step, so
      // consuming the slot here is what stops it from compacting — and
      // emitting `chat:context:compacted` — on every step.
      this.#proactiveCompactions++;
      const shortened = await this.compact("proactive");
      if (!shortened) return undefined;

      // Rebuild the compacted head, then splice this turn's in-flight steps
      // (which are not yet persisted to the session) back onto the tail.
      const head = await this.#options.rebuildMessages();
      const tail = event.messages.slice(this.#baseline);
      // Re-baseline so a second guard fire this turn keeps the new tail. This
      // relies on the AI SDK carrying the returned `messages` override into
      // the next step's `event.messages` (locked by the "fires twice in one
      // turn" test in assistant-agent-loop.test.ts).
      this.#baseline = head.length;
      return [...head, ...tail];
    } catch (err) {
      console.warn(
        `[Think] proactive context compaction failed; proceeding without it: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }
}
