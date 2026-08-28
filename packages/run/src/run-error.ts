import { truncateRunUtf8 } from "./run-utf8";
import type { RunErrorCode, RunErrorDetails, RunLog } from "./run-types";

const RUN_ERROR_DETAIL_MAX_BYTES = 256;

function createBoundedRunErrorDetails(
  details: RunErrorDetails
): RunErrorDetails {
  return Object.freeze({
    ...(details.path === undefined
      ? {}
      : { path: truncateRunUtf8(details.path, RUN_ERROR_DETAIL_MAX_BYTES) }),
    ...(details.hostFunction === undefined
      ? {}
      : {
          hostFunction: truncateRunUtf8(
            details.hostFunction,
            RUN_ERROR_DETAIL_MAX_BYTES
          )
        }),
    ...(details.limit === undefined ? {} : { limit: details.limit }),
    ...(details.observed === undefined ? {} : { observed: details.observed }),
    ...(details.allowed === undefined ? {} : { allowed: details.allowed })
  });
}

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
    if (options.details !== undefined) {
      this.details = createBoundedRunErrorDetails(options.details);
    }
    if (Object.hasOwn(options, "cause")) this.cause = options.cause;
  }
}
