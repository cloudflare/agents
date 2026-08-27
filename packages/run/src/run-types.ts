/** A trusted host function callable only from its configured child namespace. */
export type HostFunction = (...args: never[]) => unknown;

/** Exact namespaced host functions granted to one Dynamic Worker invocation. */
export type HostFunctions = Readonly<
  Record<string, Readonly<Record<string, HostFunction>>>
>;

/** Optional resource limits for one Dynamic Worker invocation. */
export interface RunLimits {
  /** Parent-owned wall timeout in milliseconds. */
  timeoutMs?: number;
  /** Dynamic Worker CPU budget in milliseconds. */
  cpuMs?: number;
  /** Dynamic Worker subrequest budget. */
  subRequests?: number;
  /** Maximum submitted source size in UTF-8 bytes. */
  maxSourceBytes?: number;
  /** Maximum captured console message size in UTF-8 bytes. */
  maxLogBytes?: number;
  /** Maximum number of started host function calls. */
  maxHostFunctionCalls?: number;
  /** Maximum number of simultaneously unsettled host function calls. */
  maxConcurrentHostFunctionCalls?: number;
}

/** Inputs for one fresh, Workers-only Dynamic Worker invocation. */
export interface RunOptions {
  /** Worker Loader binding used to create a fresh child Worker. */
  loader: WorkerLoader;
  /** JavaScript async function body executed inside the fresh child Worker. */
  source: string;
  /** Exact host functions that provide the child's only application authority. */
  hostFunctions?: HostFunctions;
  /** Caller cancellation signal for the current invocation. */
  signal?: AbortSignal;
  /** Resource limit overrides for the current invocation. */
  limits?: RunLimits;
}

/** One ordered console call captured inside the child Worker. */
export interface RunLog {
  /** Captured console method. */
  level: "debug" | "info" | "log" | "warn" | "error";
  /** Child-formatted message; raw console arguments never cross RPC. */
  message: string;
}

/** Successful completion from a fresh Dynamic Worker invocation. */
export interface RunResult<Output = unknown> {
  /** Stable successful terminal status. */
  status: "completed";
  /** Caller-asserted output transported through Workers RPC. */
  value: Output;
  /** Ordered console output captured before completion. */
  logs: RunLog[];
}

/** Stable machine-readable failure codes from `run()`. */
export type RunErrorCode =
  | "RUN_ABORTED"
  | "RUN_TIMEOUT"
  | "RUN_INVALID_INPUT"
  | "RUN_SOURCE_TOO_LARGE"
  | "RUN_COMPILE_ERROR"
  | "RUN_EXECUTION_ERROR"
  | "RUN_HOST_FUNCTION_ERROR"
  | "RUN_HOST_FUNCTION_LIMIT"
  | "RUN_DETACHED_HOST_FUNCTION"
  | "RUN_SERIALIZATION_ERROR"
  | "RUN_RESOURCE_LIMIT"
  | "RUN_WORKER_ERROR";

/** Bounded, privacy-safe context for a `RunError`. */
export interface RunErrorDetails {
  /** Fixed input or transfer category; never a transferred value. */
  path?: string;
  /** Exact bounded host function name. */
  hostFunction?: string;
  /** Configured resource limit involved in the failure. */
  limit?: keyof RunLimits;
  /** Observed finite value when the runtime reports one. */
  observed?: number;
  /** Configured finite value involved in the failure. */
  allowed?: number;
}

/** Invocation-scoped context available only inside an active host function. */
export interface HostFunctionContext {
  /** Signal aborted when the current Run invocation terminates early. */
  signal: AbortSignal;
}
