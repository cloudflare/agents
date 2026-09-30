export type DriverError = {
  readonly name: string;
  readonly message: string;
};

/** One operation the driver asks a runtime to step. */
export type DriverOperation<Input = unknown> = {
  /** The queue it belongs to, such as one chat. */
  readonly scope: string;
  /** Stable for the operation's whole life. */
  readonly id: string;
  readonly input: Input;
  /** Consecutive steps that threw since the last one that returned. */
  readonly attempt: number;
};

/**
 * What a runtime answers after one step.
 *
 * - `continue`: step again now.
 * - `sleep`: step again at `until` (epoch milliseconds).
 * - `park`: hold no job and no alarm until {@link DriverHandle.wake}. Use it
 *   for input nobody can predict, such as a human approval.
 * - `done`: the operation is finished. The driver removes it and steps the
 *   next operation in the same scope.
 */
export type DriverStep<Result> =
  | { readonly then: "continue" }
  | { readonly then: "sleep"; readonly until: number }
  | { readonly then: "park" }
  | { readonly then: "done"; readonly result: Result };

/**
 * The durable execution a harness plugs into a {@link Driver}.
 *
 * The driver owns the queue and decides when to call. The runtime owns its
 * own state and decides what one step does. Any step may be called again for
 * the same state after an eviction, so `step` reads the runtime's durable
 * records, never process memory, and repeating it must be safe.
 */
export interface DriverRuntime<Input, Result> {
  /** Do the next bounded piece of work on this operation. */
  step(
    operation: DriverOperation<Input>,
    signal: AbortSignal
  ): Promise<DriverStep<Result>>;
  /**
   * Stop this operation after {@link DriverHandle.stop}. Throw to have the
   * driver try again later; the operation stays queued until this resolves.
   */
  stop?(operation: DriverOperation<Input>): Promise<void>;
}

/** Per-runtime policy for {@link Driver.register}. */
export type DriverRegistrationOptions<Input> = {
  /**
   * Called when a step has thrown `maxAttempts` times in a row. The driver
   * then removes the operation and moves on. If this throws, the driver
   * retries it later without stepping the operation again.
   */
  readonly onFail?: (
    operation: DriverOperation<Input>,
    error: DriverError
  ) => void | Promise<void>;
  /** Job reschedule interval while a step is in flight. Default 30s. */
  readonly heartbeatMs?: number;
  /** Consecutive throwing steps before `onFail`. Default 3. */
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
};

export type DriverSubmitOptions = {
  /** Defaults to a random id. Submitting the same id twice is a no-op. */
  readonly id?: string;
};

export type DriverReceipt = {
  readonly id: string;
  readonly scope: string;
  readonly accepted: boolean;
  readonly submittedAt: number;
};

/** One queued or running operation, as {@link DriverHandle.pending} lists it. */
export type DriverSubmission<Input = unknown> = {
  readonly runtimeId: string;
  readonly scope: string;
  readonly id: string;
  readonly input: Input;
  /** `running` once the driver has stepped it at least once. */
  readonly status: "queued" | "running";
  readonly submittedAt: number;
  readonly startedAt: number | null;
  readonly attempt: number;
  readonly stopRequested: boolean;
};

/** One registered runtime's view of the driver. */
export interface DriverHandle<Input> {
  readonly id: string;
  /** Queue an operation in a scope. */
  submit(
    scope: string,
    input: Input,
    options?: DriverSubmitOptions
  ): Promise<DriverReceipt>;
  /** Step a scope now, including one that is parked or sleeping. */
  wake(scope: string): Promise<boolean>;
  /** Stop one operation, queued or running. */
  stop(id: string): Promise<boolean>;
  /** Queued and running operations, oldest first. */
  pending(scope?: string): Promise<DriverSubmission<Input>[]>;
  /** Resolve once no step is in flight. For tests. */
  waitForIdle(scope?: string): Promise<void>;
}
