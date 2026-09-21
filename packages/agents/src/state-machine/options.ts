import type { StateMachineDurationString } from "./duration";
import type { Streams } from "../streams/streams";
import type { StateMachineDefinitions, StateMachineRetryConfig } from "./types";

/**
 * Events emitted while StateMachine accepts, executes, retries, or settles runs.
 *
 * The first eleven are the complete set a function definition emits, in the
 * order the engine emits them; the rest are machine-only.
 */
export type StateMachineEventType =
  | "task:accepted"
  | "task:attempt:started"
  | "task:attempt:interrupted"
  | "task:step:started"
  | "task:step:retry"
  | "task:step:completed"
  | "task:waiting"
  | "task:completed"
  | "task:failed"
  | "task:cancelled"
  | "task:deleted"
  | "task:transition:started"
  | "task:checkpoint"
  | "task:mailbox"
  | "task:ask"
  | "task:answer"
  | "task:child"
  | "task:faulted"
  | "task:orphaned"
  | "task:paused"
  | "task:resumed"
  | "task:compensating"
  | "task:step:compensated"
  | "task:step:compensation-failed";

/**
 * Definitions and policy for a StateMachine capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface StateMachineOptions<
  Definitions extends Record<string, unknown> = StateMachineDefinitions
> {
  /**
   * Named Task definitions this capability can run — a Workflows-shaped
   * function or a durable state machine, in the same map. Each run row
   * persists a definition name; declaring the map in the constructor
   * re-registers the names on every Durable Object wake, so recovery of
   * in-flight runs is correct by construction. Names outside this map are
   * rejected unless a composition-root resolver supplies them.
   */
  readonly definitions?: Definitions & StateMachineDefinitions;

  /** Default step retry policy, overridable per `step.do()`. */
  readonly retries?: StateMachineRetryConfig;

  /** Default timeout of one step callback attempt. Default: 5 minutes. */
  readonly stepTimeout?: number | StateMachineDurationString;

  /**
   * The per-transition watchdog for machine runs: a transition that neither
   * returns nor heartbeats within it is aborted. Defaults to `stepTimeout`.
   * Off for a durable function, whose steps carry their own timeouts.
   */
  readonly turnTimeout?: number | StateMachineDurationString;

  /**
   * Progress rule A: consecutive transitions tolerated that change no
   * checkpoint, park on nothing, and credit no durable work. Default 1.
   */
  readonly stallLimit?: number;

  /**
   * Progress rule B: transitions allowed since the last park. Exceeding it
   * fails the run with `StateMachineTransitionBudgetError`. Default 1000.
   */
  readonly transitionBudget?: number;

  /** Max unconsumed mailbox rows per run before `send` throws. Default 1000. */
  readonly mailboxLimit?: number;

  /**
   * The Streams capability engine-owned streams are written through
   * (`ctx.stream()`). Install it on the same Lifecycle; without it,
   * `ctx.stream()` throws.
   */
  readonly streams?: Streams;

  /**
   * Observe terminal run failures, including those StateMachine records without
   * running the handler (a missing definition, a spent interruption retry
   * budget, a passed deadline). Runs inside the host invocation context.
   */
  readonly onError?: (
    error: unknown,
    run: StateMachineFailedRun
  ) => void | Promise<void>;
}

/** The run an `onError` observation belongs to. */
export interface StateMachineFailedRun {
  readonly runId: string;
  readonly definition: string;
}
