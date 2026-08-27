import type { RunErrorCode, RunErrorDetails, RunLog } from "./run-types";

/** Every unsuccessful `run()` invocation rejects with this stable error type. */
export class RunError extends Error {
  /** Stable class name for Workers environments that preserve error fields. */
  override readonly name = "RunError" as const;

  /** Stable machine-readable failure code. */
  readonly code: RunErrorCode;

  /** Bounded, privacy-safe failure context. */
  readonly details?: RunErrorDetails;

  /** Best-effort child console output available at failure time. */
  readonly logs: RunLog[];

  /** Original trusted failure when the contract permits caller access. */
  override readonly cause?: unknown;

  /** Construct a classified failure returned by the Workers-only Run interface. */
  constructor(
    message: string,
    options: {
      /** Stable machine-readable failure code. */
      code: RunErrorCode;
      /** Original trusted failure when the contract permits caller access. */
      cause?: unknown;
      /** Bounded, privacy-safe failure context. */
      details?: RunErrorDetails;
      /** Best-effort child console output available at failure time. */
      logs?: RunLog[];
    }
  ) {
    super(message);
    this.code = options.code;
    this.logs = options.logs ?? [];
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}
