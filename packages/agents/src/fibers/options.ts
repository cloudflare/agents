import type { FiberDurationString } from "./duration";
import type { FiberCallbacks, FiberHandlers, FiberStepConfig } from "./types";

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
 * Definitions and policy for a Fibers capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface FibersOptions<
  Handlers extends FiberHandlers = FiberCallbacks
> {
  /**
   * Named Fiber definitions this capability can run. Each run row persists a
   * definition name; declaring the map in the constructor re-registers the
   * names on every Durable Object wake, so recovery of in-flight runs is
   * correct by construction. Names outside this map are rejected unless a
   * composition-root resolver supplies them.
   */
  readonly definitions?: Handlers;

  /** Default step retry policy, overridable per `step.do()`. */
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
