import type { RunErrorCode, RunErrorDetails, RunLog } from "./run-types";

const RUN_ERROR_DETAIL_MAX_BYTES = 256;
const runErrorTextEncoder = new TextEncoder();
const runErrorTextDecoder = new TextDecoder("utf-8", { fatal: true });

function boundRunErrorDetail(value: string): string {
  const bytes = runErrorTextEncoder.encode(value);
  if (bytes.length <= RUN_ERROR_DETAIL_MAX_BYTES) return value;

  const suffix = "…";
  const suffixBytes = runErrorTextEncoder.encode(suffix).length;
  for (let end = RUN_ERROR_DETAIL_MAX_BYTES - suffixBytes; end >= 0; end--) {
    try {
      return runErrorTextDecoder.decode(bytes.subarray(0, end)) + suffix;
    } catch {
      // Continue to the preceding complete UTF-8 boundary.
    }
  }
  return suffix;
}

function createBoundedRunErrorDetails(
  details: RunErrorDetails
): RunErrorDetails {
  return Object.freeze({
    ...(details.path === undefined
      ? {}
      : { path: boundRunErrorDetail(details.path) }),
    ...(details.hostFunction === undefined
      ? {}
      : { hostFunction: boundRunErrorDetail(details.hostFunction) }),
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
