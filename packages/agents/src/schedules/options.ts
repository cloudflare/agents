import type { RetryOptions } from "../retries";

/** Events emitted while a Scheduler creates, executes, retries, or cancels work. */
export type SchedulerEventType =
  | "schedule:create"
  | "schedule:cancel"
  | "schedule:execute"
  | "schedule:retry"
  | "schedule:error"
  | "schedule:duplicate_warning";

/** Optional policy for a Scheduler capability. */
export interface SchedulerOptions {
  /** Default callback retry policy. */
  readonly retry?: RetryOptions;

  /** Seconds before an in-flight interval is treated as abandoned. Default: 30. */
  readonly hungScheduleTimeoutSeconds?: number;

  /** Observe terminal callback errors. Runs as capability code without host context. */
  readonly onError?: (error: unknown) => void | Promise<void>;
}
