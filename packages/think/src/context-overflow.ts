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
import {
  ChatStreamStalledError,
  TransientChatStreamError,
  classifyProviderError,
  isDurableObjectResetError
} from "agents/chat";
import type {
  ChatErrorClassification,
  ChatErrorContext,
  ContextOverflowConfig,
  PrepareStepContext
} from "./turn-types";

/**
 * Whether a classification routes the turn into bounded recovery.
 *
 * @internal
 */
export function isTransientClassification(
  classification: ChatErrorClassification | undefined
): classification is "transient" | "rate_limit" {
  return classification === "transient" || classification === "rate_limit";
}

/**
 * What {@link ThinkContextOverflow} reads from its agent.
 *
 * @internal
 */
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

/** @internal */
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
  beginRun(messages: readonly ModelMessage[]): void {
    const baseline = messages.length;
    this.#baseline = baseline;
    this.#runBaseline = baseline;
    // Kept by reference, and only when the guard is on: read only when it
    // compacts.
    this.#runPrompt = this.#options.config()?.proactive ? messages : [];
    this.#compactedHead = undefined;
    this.#proactiveCompactions = 0;
  }

  /** Where the run's own steps begin in the messages it started with. */
  #runBaseline = 0;

  /** The messages the run started with: its steps follow them. */
  #runPrompt: readonly ModelMessage[] = [];

  /** The head the last proactive compaction of this run built, if any. */
  #compactedHead: ModelMessage[] | undefined;

  /**
   * Whether the step's messages already start with the compacted head: AI
   * SDK 7 carries a step's `messages` override into later steps; AI SDK 6
   * gives each step the run's original messages and its steps again.
   */
  #carried(messages: readonly ModelMessage[]): boolean {
    const head = this.#compactedHead;
    return !head || startsWith(messages, head);
  }

  /**
   * This run's in-flight steps. Where the step's messages hold the
   * compacted head or the run's own prompt whole (at the start, or after
   * what a `beforeStep` put in front of it), what follows it. Where a
   * `beforeStep` rewrote it, what follows the first copy of the prompt's
   * last message: a step's own messages come after it, so one that repeats
   * it is never taken for the boundary.
   */
  #inFlight(messages: readonly ModelMessage[]): ModelMessage[] {
    const head = this.#compactedHead;
    const prompt = this.#runPrompt;
    for (const known of head ? [head, prompt] : [prompt]) {
      const at = indexOfRun(messages, known);
      if (at >= 0) return messages.slice(at + known.length);
    }
    const last = prompt.at(-1);
    if (last !== undefined) {
      const key = JSON.stringify(last);
      const at = messages.findIndex((m) => JSON.stringify(m) === key);
      if (at >= 0) return messages.slice(at + 1);
    }
    return messages.slice(head ? this.#baseline : this.#runBaseline);
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
    // The app's hook wins; without a verdict from it, what the provider's
    // error says (`classifyProviderError`).
    if (this.#options.classifierOverridden()) {
      try {
        const verdict = this.#options.classify(error, {
          stage: "stream",
          requestId
        });
        if (verdict) return verdict;
      } catch (err) {
        console.warn(
          `[Think] classifyChatError threw; treating as unclassified: ${err instanceof Error ? err.message : String(err)}`
        );
        return undefined;
      }
    }
    return classifyProviderError(error);
  }

  /**
   * Whether a classified stream error should trigger the opt-in
   * compact-and-retry backstop. Centralized so both stream consumers
   * (WebSocket + RPC) decide identically.
   */
  isRecoverable(classification: ChatErrorClassification | undefined): boolean {
    if (!this.reactiveEnabled) return false;
    return classification === "context_overflow";
  }

  /**
   * The `"transient"` or `"rate_limit"` class of a stream error (the app's
   * hook, else what the provider's error says), else `undefined`. Such errors
   * route into bounded chat recovery like a stream stall instead of
   * terminalizing the turn (#2085). A Durable Object reset
   * is never transient here: the restart's own recovery owns the turn.
   */
  transientClassification(
    error: unknown,
    requestId: string
  ): ChatErrorClassification | undefined {
    if (error instanceof TransientChatStreamError) return "transient";
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
    // Once compacted, a later step sends the compacted head too: on AI SDK
    // 6, where the override isn't carried, it is spliced in again.
    const keep = (): ModelMessage[] | undefined =>
      this.#compactedHead && !this.#carried(event.messages)
        ? [...this.#compactedHead, ...this.#inFlight(event.messages)]
        : undefined;
    // The proactive cap is independent of the reactive budget, so an app can
    // use either layer alone and tune each freely.
    if (this.#proactiveCompactions >= Math.max(1, guard.maxCompactions ?? 1))
      return keep();

    const prev = event.steps?.at(-1);
    const used = prev?.usage?.inputTokens ?? prev?.usage?.totalTokens;
    if (used == null || !Number.isFinite(used)) return keep();

    const headroom = guard.headroom ?? 0.9;
    if (used < guard.maxInputTokens * headroom) return keep();

    try {
      // Count the ATTEMPT (not just successful shortenings) before compacting.
      // A no-op compaction would be a no-op again on every later step, so
      // consuming the slot here is what stops it from compacting — and
      // emitting `chat:context:compacted` — on every step.
      this.#proactiveCompactions++;
      const shortened = await this.compact("proactive");
      if (!shortened) return keep();

      // Rebuild the compacted head, then splice this turn's in-flight steps
      // (which are not yet persisted to the session) back onto the tail.
      const tail = this.#inFlight(event.messages);
      const head = await this.#options.rebuildMessages();
      // Re-baseline so a second guard fire this turn keeps the new tail, and
      // keep the head for later steps on an AI SDK that doesn't carry it.
      this.#baseline = head.length;
      this.#compactedHead = head;
      return [...head, ...tail];
    } catch (err) {
      console.warn(
        `[Think] proactive context compaction failed; proceeding without it: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }
}

/**
 * Where `run` first appears whole and in order in `messages`, or -1. An empty
 * run is never found: it marks no boundary.
 */
function indexOfRun(
  messages: readonly ModelMessage[],
  run: readonly ModelMessage[]
): number {
  if (run.length === 0) return -1;
  if (startsWith(messages, run)) return 0;
  const first = JSON.stringify(run[0]);
  for (let at = 1; at + run.length <= messages.length; at++) {
    if (
      (messages[at] === run[0] || JSON.stringify(messages[at]) === first) &&
      startsWith(messages.slice(at), run)
    ) {
      return at;
    }
  }
  return -1;
}

/** Whether `messages` starts with `prefix`: the same objects, or equal JSON. */
function startsWith(
  messages: readonly ModelMessage[],
  prefix: readonly ModelMessage[]
): boolean {
  if (messages.length < prefix.length) return false;
  if (prefix.every((message, at) => messages[at] === message)) return true;
  // Cheap checks before the JSON: the first and last of the prefix.
  const end = prefix.length - 1;
  if (
    end >= 0 &&
    (JSON.stringify(messages[0]) !== JSON.stringify(prefix[0]) ||
      JSON.stringify(messages[end]) !== JSON.stringify(prefix[end]))
  ) {
    return false;
  }
  return (
    JSON.stringify(messages.slice(0, prefix.length)) === JSON.stringify(prefix)
  );
}
