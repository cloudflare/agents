import type { RetryOptions } from "../retries";
import type { SchedulerCallbacks, SchedulerHandlers } from "./types";

/** Events emitted while a Scheduler creates, executes, retries, or cancels work. */
export type SchedulerEventType =
  | "schedule:create"
  | "schedule:cancel"
  | "schedule:execute"
  | "schedule:retry"
  | "schedule:error"
  | "schedule:duplicate_warning";

/**
 * Optional callbacks and policy for a Scheduler capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface SchedulerOptions<
  Handlers extends SchedulerHandlers = SchedulerCallbacks
> {
  /**
   * Named callbacks this Scheduler can run. Each schedule row persists a
   * callback name; registration in a field initializer re-binds the names on
   * every Durable Object wake, so register unconditionally. Names not in
   * this map fall back to methods on the installed host, which is how
   * `Agent`'s name-based scheduling API is implemented.
   */
  readonly callbacks?: Handlers;

  /** Default callback retry policy. */
  readonly retry?: RetryOptions;

  /** Seconds before an in-flight interval is treated as abandoned. Default: 30. */
  readonly hungScheduleTimeoutSeconds?: number;

  /** Observe terminal callback errors. Runs as capability code without host context. */
  readonly onError?: (error: unknown) => void | Promise<void>;
}
