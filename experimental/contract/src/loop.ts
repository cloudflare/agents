/**
 * loop — the unified Harness seam plus the step strategy used by the default
 * harness. A Harness takes one turn wake to quiescence. The shipped step
 * harness and foreign harnesses satisfy the same interface and differ only in
 * commit granularity.
 *
 * A parked turn retains NO in-memory state. drive() is called fresh on every
 * wake and rehydrates from the LogView. It returns void after committing a
 * terminal or suspended turn marker; the log is the snapshot.
 *
 * Discipline (residue 2): step() runs at-least-once. Committed state in
 * deps.view is the ONLY memory. Claimed effects are protected by ToolRuntime;
 * everything else must be derived from the view, not instance state.
 *
 * Allowed imports: kernel, transcript, tools, model, context.
 */

import type { BlobRef, EntryRef, Json, RetryPolicy, TurnInfo } from "./kernel";
import type { LogView, NewEntry } from "./transcript";
import type { ToolRuntime } from "./tools";
import type { LanguageModel } from "./model";
import type { ContextAssembler } from "./context";

/** The narrowed, step-agnostic surface injected for one turn wake. */
export interface TurnDeps {
  readonly turn: TurnInfo;
  readonly view: LogView;
  /** Atomically append entries at the harness's chosen commit granularity. */
  commit(entries: readonly NewEntry[]): Promise<readonly EntryRef[]>;
  /** Stream ephemeral live output. */
  write(chunk: Json): void;
  /** Store bulk content referenced by entries committed through commit(). */
  putBlob(
    data: ReadableStream<Uint8Array> | Uint8Array,
    meta: { mediaType: string }
  ): Promise<BlobRef>;
  readonly tools: ToolRuntime;
  readonly signal: AbortSignal;
}

/** Drives one turn wake to terminal or suspended quiescence. */
export interface Harness {
  drive(deps: TurnDeps): Promise<void>;
}

/**
 * The dependencies for one step of the default harness: the shared turn
 * surface plus the default harness's brain.
 */
export interface StepDeps extends TurnDeps {
  readonly model: LanguageModel;
  readonly context: ContextAssembler;
  readonly loop: AgentLoop;
}

export type StepOutcome =
  /** Step committed; drive the next step of this turn. */
  | { readonly outcome: "continue" }
  /** The turn is finished (final answer committed by this step). */
  | { readonly outcome: "completed" }
  /**
   * Waiting on the outside world (approval, pending effect, client tool).
   * The turn sleeps with NO in-memory state; a correlated entry re-admits it.
   */
  | { readonly outcome: "parked"; readonly reason: string }
  /** Retryable per policy (transient model error, stall). */
  | {
      readonly outcome: "failed";
      readonly message: string;
      readonly retryable: boolean;
    };

/** One-step strategy consumed only by the default step harness. */
export interface AgentLoop {
  step(deps: StepDeps): Promise<StepOutcome>;
}

/** Per-turn execution policy enforced by the default harness (residue 4). */
export interface LoopPolicy {
  readonly maxSteps: number;
  readonly retry: RetryPolicy;
  /** Kill a step whose model stream stops producing for this long. */
  readonly stallTimeoutMs?: number;
}

/**
 * Builds the failed turn marker committed when a turn terminates abnormally,
 * so clients see a terminal state instead of an eternal spinner.
 */
export interface TurnFailureNotice {
  build(input: {
    readonly turn: TurnInfo;
    readonly reason: "exhausted" | "aborted" | "fatal";
    readonly message: string;
  }): readonly NewEntry[];
}

/**
 * Type-only declaration of the default Harness factory. Its implementation
 * owns the while-loop and commits once per AgentLoop step.
 */
export declare function stepHarness(config: {
  readonly loop: AgentLoop;
  readonly model: LanguageModel;
  readonly context: ContextAssembler;
  readonly policy: LoopPolicy;
  readonly failureNotice?: TurnFailureNotice;
}): Harness;
