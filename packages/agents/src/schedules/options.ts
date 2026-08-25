import type { LifecycleObject } from "../lifecycle/current-agent";
import type { RetryOptions } from "../retries";
import type { Schedule } from "./types";

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

/** Opaque persisted owner used by host adapters such as Agent facets. */
export type SchedulerOwner = {
  readonly key: string;
  readonly data: string;
};

/** @internal Explicit host adapter used to extend Scheduler behavior. */
export interface SchedulerIntegration<Host extends LifecycleObject> {
  readonly host: Host;
  readonly storage: DurableObjectStorage;
  readonly now: () => number;
  readonly createId: () => string;
  readonly sql: <T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => T[];
  readonly rawSql: SqlStorage["exec"];
  readonly retryDefaults: () => Required<RetryOptions>;
  readonly hungScheduleTimeoutSeconds: () => number;
  readonly validateSchedule: (
    when: Date | string | number,
    callback: string,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ) => void;
  readonly hasCallback: (callback: string) => boolean;
  readonly invokeCallback: (
    callback: string,
    payload: unknown,
    schedule: Schedule<unknown>
  ) => void | Promise<void>;
  readonly rearm: () => void | Promise<void>;
  readonly isDestroyed: () => boolean;
  readonly onError: (error: unknown) => void | Promise<void>;
}
