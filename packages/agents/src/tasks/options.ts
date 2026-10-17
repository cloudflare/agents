import type { TaskDurationString } from "./duration";
import type { TaskCallbacks, TaskHandlers, TaskRetryConfig } from "./types";

/** Events emitted while Tasks accepts, executes, retries, or settles runs. */
export type TaskEventType =
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
  | "task:deleted";

/**
 * Definitions and policy for a Tasks capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TasksOptions<Handlers extends TaskHandlers = TaskCallbacks> {
  /**
   * Named Task definitions this capability can run. Each run row persists a
   * definition name; declaring the map in the constructor re-registers the
   * names on every Durable Object wake, so recovery of in-flight runs is
   * correct by construction. Names outside this map are rejected unless a
   * composition-root resolver supplies them.
   */
  readonly definitions?: Handlers;

  /** Default step retry policy, overridable per `step.do()`. */
  readonly retries?: TaskRetryConfig;

  /** Default timeout of one step callback attempt. Default: 5 minutes. */
  readonly stepTimeout?: number | TaskDurationString;

  /**
   * Observe terminal run failures, including those Tasks records without
   * running the handler (a missing definition, a spent interruption retry
   * budget, a passed deadline). Runs inside the host invocation context.
   */
  readonly onError?: (
    error: unknown,
    run: TaskFailedRun
  ) => void | Promise<void>;
}

/** The run an `onError` observation belongs to. */
export interface TaskFailedRun {
  readonly runId: string;
  readonly definition: string;
}
