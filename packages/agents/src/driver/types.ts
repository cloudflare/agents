export type DriverSubmissionStatus = "queued" | "admitted";

export type DriverError = {
  readonly name: string;
  readonly message: string;
};

/** One durable submission in a scope's FIFO queue. */
export type DriverSubmission<Input = unknown> = {
  readonly seq: number;
  /** The id the owning runtime registered under. */
  readonly runtimeId: string;
  readonly scope: string;
  readonly operationId: string;
  readonly input: Input;
  readonly status: DriverSubmissionStatus;
  readonly streamId: string | null;
  readonly submittedAt: number;
  readonly admittedAt: number | null;
  readonly attempts: number;
  readonly failure: DriverError | null;
  readonly cancelRequested: boolean;
};

export type DriverEnqueueResult<Input = unknown> = {
  readonly accepted: boolean;
  readonly submission: DriverSubmission<Input>;
};

/**
 * What the runtime's own durable record says about one operation.
 *
 * `waiting` without `notBefore` parks the scope: the driver holds no job for
 * it until {@link DriverHandle.wake} (or the next startup) drives it again.
 * With `notBefore`, the driver re-inspects at that time.
 */
export type DriverInspection<Result> =
  | { readonly status: "not-admitted" }
  | { readonly status: "active" }
  | { readonly status: "waiting"; readonly notBefore?: number }
  | { readonly status: "completed"; readonly result: Result }
  | { readonly status: "failed"; readonly error: DriverError };

/**
 * The outcome of one bounded drive pass.
 *
 * `continue` drives the same operation again on the next job cycle.
 * `waiting` with `notBefore` drives it again at that time. `waiting` without
 * `notBefore` parks the scope until {@link DriverHandle.wake}: use it for
 * input the runtime cannot predict, such as a human approval.
 */
export type DriverDriveResult<Result> =
  | { readonly status: "continue" }
  | { readonly status: "waiting"; readonly notBefore?: number }
  | { readonly status: "completed"; readonly result: Result };

export type DriverCancellation<Result = unknown> =
  | { readonly status: "cancelled" }
  | { readonly status: "not-found" }
  | { readonly status: "completed"; readonly result: Result }
  | { readonly status: "pending"; readonly notBefore?: number };

/**
 * The durable execution a harness plugs into a {@link Driver}.
 *
 * The runtime owns its own state; the driver owns the submission queue and
 * the wake loop. Every method may be called again after an eviction, so each
 * one must read the runtime's durable record rather than process memory.
 */
export interface DriverRuntime<Input, Result> {
  inspect(
    scope: string,
    operationId: string
  ): Promise<DriverInspection<Result>>;
  admit(scope: string, operationId: string, input: Input): Promise<void>;
  drive(
    scope: string,
    operationId: string,
    signal: AbortSignal
  ): Promise<DriverDriveResult<Result>>;
  cancel(
    scope: string,
    operationId: string
  ): Promise<DriverCancellation<Result>>;
}

/** Per-runtime settlement hooks and retry policy for {@link Driver.register}. */
export type DriverRegistrationOptions<Input, Result> = {
  readonly settle?: (
    submission: DriverSubmission<Input>,
    result: Result
  ) => void | Promise<void>;
  readonly fail?: (
    submission: DriverSubmission<Input>,
    error: DriverError
  ) => void | Promise<void>;
  /** Job reschedule interval while a drive is in flight. Default 30s. */
  readonly heartbeatMs?: number;
  /** Consecutive thrown drives before the operation fails. Default 3. */
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
};

export type DriverSubmitOptions = {
  readonly operationId?: string;
  readonly streamId?: string;
};

export type DriverReceipt = {
  readonly operationId: string;
  readonly scope: string;
  readonly accepted: boolean;
  readonly submittedAt: number;
};

/** One registered runtime's view of the driver. */
export interface DriverHandle<Input> {
  readonly id: string;
  submit(
    scope: string,
    input: Input,
    options?: DriverSubmitOptions
  ): Promise<DriverReceipt>;
  pending(scope?: string): Promise<DriverSubmission<Input>[]>;
  /** Drive a scope now, including one parked on an open-ended wait. */
  wake(scope: string): Promise<boolean>;
  defer(scope: string, time: number): Promise<boolean>;
  cancel(operationId: string): Promise<boolean>;
  waitForIdle(scope?: string): Promise<void>;
}
