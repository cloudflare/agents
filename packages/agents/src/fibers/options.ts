import type { FiberDurationString } from "./duration";
import type { FiberStepConfig } from "./types";

/** Events emitted while Fibers accepts, executes, retries, or settles runs. */
export type FiberEventType =
  | "fiber:accepted"
  | "fiber:attempt:started"
  | "fiber:attempt:interrupted"
  | "fiber:step:started"
  | "fiber:step:retry"
  | "fiber:step:completed"
  | "fiber:waiting"
  | "fiber:completed"
  | "fiber:failed"
  | "fiber:cancelled"
  | "fiber:deleted";

/**
 * Policy for a Fibers capability. All fields are defaults an individual
 * `step.do()` config can override.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface FibersOptions {
  /** Default step retry policy. */
  readonly retries?: FiberStepConfig["retries"];

  /** Default timeout of one step callback attempt. Default: 5 minutes. */
  readonly stepTimeout?: number | FiberDurationString;

  /**
   * Maximum due runs claimed in one alarm invocation. Remaining due runs
   * keep their deadlines and continue on an immediate follow-up alarm.
   * Default: 10.
   */
  readonly maxRunsPerAlarm?: number;

  /** Observe terminal run failures. Runs as capability code without host context. */
  readonly onError?: (error: unknown) => void | Promise<void>;
}
