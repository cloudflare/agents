import type { TaskDurationString } from "./duration";
import type { TaskCallbacks, TaskHandlers, TaskStepConfig } from "./types";

/** Events emitted while Tasks accepts, executes, retries, or settles runs. */
export type TaskEventType =
  | "task:accepted"
  | "task:attempt:started"
  | "task:attempt:interrupted"
  | "task:recovery:started"
  | "task:recovery:decided"
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
  readonly retries?: TaskStepConfig["retries"];

  /** Default timeout of one step callback attempt. Default: 5 minutes. */
  readonly stepTimeout?: number | TaskDurationString;

  /**
   * Maximum due runs claimed in one alarm invocation. Remaining due runs
   * keep their deadlines and continue on an immediate follow-up alarm.
   * Default: 10.
   */
  readonly maxRunsPerAlarm?: number;

  /** Observe terminal run failures. Runs as capability code without host context. */
  readonly onError?: (error: unknown) => void | Promise<void>;
}
