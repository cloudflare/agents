import { createDynamicWorkerModules } from "./dynamic-worker-harness";
import type {
  RunHostFunctionManifestEntry,
  RunWorkerErrorRecord,
  RunWorkerLimits,
  RunWorkerResponse
} from "./dynamic-worker-protocol";
import { createRunHostFunctionDispatch } from "./host-function-dispatch";
import type {
  RunHostFunctionDispatcher,
  TakeRunHostFunctionFailure
} from "./host-function-dispatch";
import { RunError } from "./run-error";
import { parseRunLimits } from "./run-limits";
import type { RunResolvedLimits } from "./run-limits";
import type { RunLog, RunOptions, RunResult } from "./run-types";

const RUN_CHILD_COMPATIBILITY_DATE = "2026-08-27";
const RUN_CHILD_COMPATIBILITY_FLAGS = ["nodejs_compat"];

interface RunWorkerEntrypoint {
  evaluate(
    dispatcher: RunHostFunctionDispatcher,
    manifest: readonly RunHostFunctionManifestEntry[],
    limits: RunWorkerLimits
  ): Promise<unknown>;
}

function disposeRunResource(resource: unknown): void {
  try {
    if (
      (typeof resource !== "object" && typeof resource !== "function") ||
      resource === null
    ) {
      return;
    }
    const dispose = Reflect.get(resource, Symbol.dispose);
    if (typeof dispose === "function") {
      Reflect.apply(dispose, resource, []);
    }
  } catch {
    // Cleanup is best effort and must not mask the execution result.
  }
}

function parseRunLogs(value: unknown): RunLog[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const logs: RunLog[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const level = Reflect.get(entry, "level");
    const message = Reflect.get(entry, "message");
    if (
      (level !== "debug" &&
        level !== "info" &&
        level !== "log" &&
        level !== "warn" &&
        level !== "error") ||
      typeof message !== "string"
    ) {
      return undefined;
    }
    logs.push({ level, message });
  }
  return logs;
}

function parseRunWorkerErrorRecord(
  value: unknown
): RunWorkerErrorRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const name = Reflect.get(value, "name");
  const message = Reflect.get(value, "message");
  const stack = Reflect.get(value, "stack");
  if (
    typeof name !== "string" ||
    typeof message !== "string" ||
    (stack !== undefined && typeof stack !== "string")
  ) {
    return undefined;
  }

  const diagnostic = {
    name,
    message,
    ...(stack === undefined ? {} : { stack })
  };
  const code = Reflect.get(value, "code");
  const path = Reflect.get(value, "path");
  const hostFunction = Reflect.get(value, "hostFunction");
  const hostFailureId = Reflect.get(value, "hostFailureId");
  const limit = Reflect.get(value, "limit");
  switch (code) {
    case undefined:
      return path === undefined &&
        hostFunction === undefined &&
        hostFailureId === undefined &&
        limit === undefined
        ? diagnostic
        : undefined;
    case "RUN_HOST_FUNCTION_ERROR":
      return path === undefined &&
        hostFunction === undefined &&
        limit === undefined &&
        typeof hostFailureId === "number" &&
        Number.isSafeInteger(hostFailureId) &&
        hostFailureId > 0
        ? { ...diagnostic, code, hostFailureId }
        : undefined;
    case "RUN_HOST_FUNCTION_LIMIT":
      return path === undefined &&
        hostFailureId === undefined &&
        typeof hostFunction === "string" &&
        (limit === "maxHostFunctionCalls" ||
          limit === "maxConcurrentHostFunctionCalls")
        ? { ...diagnostic, code, hostFunction, limit }
        : undefined;
    case "RUN_DETACHED_HOST_FUNCTION":
      return path === undefined &&
        hostFailureId === undefined &&
        limit === undefined &&
        typeof hostFunction === "string"
        ? { ...diagnostic, code, hostFunction }
        : undefined;
    case "RUN_INVALID_INPUT":
      return path === "hostFunctions.namespace" &&
        hostFunction === undefined &&
        hostFailureId === undefined &&
        limit === undefined
        ? { ...diagnostic, code, path }
        : undefined;
    case "RUN_SERIALIZATION_ERROR":
      if (hostFailureId !== undefined || limit !== undefined) return undefined;
      if (path === "result" && hostFunction === undefined) {
        return { ...diagnostic, code, path };
      }
      return (path === "hostFunction.arguments" ||
        path === "hostFunction.result") &&
        typeof hostFunction === "string"
        ? { ...diagnostic, code, path, hostFunction }
        : undefined;
    case "RUN_WORKER_ERROR":
      return path === undefined &&
        hostFailureId === undefined &&
        limit === undefined &&
        (hostFunction === undefined || typeof hostFunction === "string")
        ? {
            ...diagnostic,
            code,
            ...(hostFunction === undefined ? {} : { hostFunction })
          }
        : undefined;
    default:
      return undefined;
  }
}

function parseRunWorkerResponse(value: unknown): RunWorkerResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const status = Reflect.get(value, "status");
  const logs = parseRunLogs(Reflect.get(value, "logs"));
  if (!logs) return undefined;

  if (status === "completed") {
    return { status, value: Reflect.get(value, "value"), logs };
  }
  if (status !== "failed") return undefined;

  const error = parseRunWorkerErrorRecord(Reflect.get(value, "error"));
  return error === undefined ? undefined : { status, error, logs };
}

function readRunFailureDiagnostic(
  cause: unknown,
  property: "name" | "message"
): string | undefined {
  if (
    (typeof cause !== "object" && typeof cause !== "function") ||
    cause === null
  ) {
    return undefined;
  }
  try {
    const value = Reflect.get(cause, property);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function createRunWorkerError(cause: unknown): RunError {
  const name = readRunFailureDiagnostic(cause, "name");
  const message = readRunFailureDiagnostic(cause, "message");
  if (
    name === "SyntaxError" ||
    message?.includes("Uncaught SyntaxError:") === true
  ) {
    return new RunError("Run source could not be compiled.", {
      code: "RUN_COMPILE_ERROR",
      cause
    });
  }
  if (
    name === "DataCloneError" ||
    message?.includes("could not be cloned") === true ||
    message?.includes("Serialized RPC") === true
  ) {
    return new RunError("Run data could not be serialized.", {
      code: "RUN_SERIALIZATION_ERROR",
      cause
    });
  }
  if (message?.includes("CPU time limit") === true) {
    return new RunError("Dynamic Worker exceeded its CPU limit.", {
      code: "RUN_RESOURCE_LIMIT",
      cause,
      details: { limit: "cpuMs" }
    });
  }
  if (message?.toLowerCase().includes("subrequest") === true) {
    return new RunError("Dynamic Worker exceeded its subrequest limit.", {
      code: "RUN_RESOURCE_LIMIT",
      cause,
      details: { limit: "subRequests" }
    });
  }
  return new RunError("Dynamic Worker execution failed.", {
    code: "RUN_WORKER_ERROR",
    cause
  });
}

function createRunExecutionError(
  response: Extract<RunWorkerResponse, { status: "failed" }>,
  takeHostFunctionFailure: TakeRunHostFunctionFailure,
  limits: RunResolvedLimits
): RunError {
  let error: RunError;
  if (response.error.code === "RUN_HOST_FUNCTION_ERROR") {
    const failure = takeHostFunctionFailure(response.error.hostFailureId);
    if (failure.status === "missing") {
      return new RunError("Dynamic Worker returned an unknown host failure.", {
        code: "RUN_WORKER_ERROR",
        logs: response.logs
      });
    }
    error = new RunError("Host function failed.", {
      code: "RUN_HOST_FUNCTION_ERROR",
      cause: failure.cause,
      details: { hostFunction: failure.hostFunction },
      logs: response.logs
    });
  } else if (response.error.code === "RUN_HOST_FUNCTION_LIMIT") {
    // The parent's own validated limit values are the trusted numbers here.
    const allowed = limits[response.error.limit];
    error = new RunError("Host function call limit exceeded.", {
      code: "RUN_HOST_FUNCTION_LIMIT",
      details: {
        hostFunction: response.error.hostFunction,
        limit: response.error.limit,
        observed: allowed + 1,
        allowed
      },
      logs: response.logs
    });
  } else if (response.error.code === "RUN_DETACHED_HOST_FUNCTION") {
    error = new RunError(
      "Generated code returned before a host function call settled.",
      {
        code: "RUN_DETACHED_HOST_FUNCTION",
        details: { hostFunction: response.error.hostFunction },
        logs: response.logs
      }
    );
  } else {
    const details =
      response.error.path === undefined &&
      response.error.hostFunction === undefined
        ? undefined
        : {
            ...(response.error.path === undefined
              ? {}
              : { path: response.error.path }),
            ...(response.error.hostFunction === undefined
              ? {}
              : { hostFunction: response.error.hostFunction })
          };
    const code =
      response.error.code === "RUN_SERIALIZATION_ERROR" ||
      response.error.code === "RUN_INVALID_INPUT" ||
      response.error.code === "RUN_WORKER_ERROR"
        ? response.error.code
        : "RUN_EXECUTION_ERROR";
    error = new RunError(
      code === "RUN_WORKER_ERROR"
        ? "Dynamic Worker host protocol failed."
        : response.error.message,
      {
        code,
        ...(details === undefined ? {} : { details }),
        logs: response.logs
      }
    );
  }

  if (response.error.stack !== undefined) error.stack = response.error.stack;
  return error;
}

function createRunAbortedError(reason: unknown): RunError {
  return new RunError("Run was aborted.", {
    code: "RUN_ABORTED",
    ...(reason === undefined ? {} : { cause: reason })
  });
}

function getRunAbortSignalAbortedGetter(): (() => unknown) | undefined {
  const descriptor = Reflect.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted"
  );
  return descriptor?.get;
}

const RUN_ABORT_SIGNAL_ABORTED_GETTER = getRunAbortSignalAbortedGetter();

function isRunAbortSignal(signal: unknown): signal is AbortSignal {
  try {
    // The native accessor is the brand check: forged prototypes and hostile
    // proxies fail here instead of escaping later as raw platform errors.
    return (
      signal instanceof AbortSignal &&
      (RUN_ABORT_SIGNAL_ABORTED_GETTER === undefined ||
        typeof Reflect.apply(RUN_ABORT_SIGNAL_ABORTED_GETTER, signal, []) ===
          "boolean")
    );
  } catch {
    return false;
  }
}

function throwInvalidRunOption(
  path: "options" | "loader" | "signal" | "source"
): never {
  throw new RunError("Run options violate the supported interface.", {
    code: "RUN_INVALID_INPUT",
    details: { path }
  });
}

interface ParsedRunOptions {
  readonly loader: WorkerLoader;
  readonly loadWorker: WorkerLoader["load"];
  readonly source: string;
  readonly hostFunctions: RunOptions["hostFunctions"];
  readonly signal: AbortSignal | undefined;
  readonly limits: RunOptions["limits"];
}

/** Snapshot and validate caller options once so later reads cannot change. */
function parseRunOptions(options: RunOptions): ParsedRunOptions {
  if (typeof options !== "object" || options === null) {
    return throwInvalidRunOption("options");
  }
  let loader: WorkerLoader;
  let loadWorker: unknown;
  let source: unknown;
  let hostFunctions: RunOptions["hostFunctions"];
  let signal: unknown;
  let limits: RunOptions["limits"];
  try {
    ({ loader, source, hostFunctions, signal, limits } = options);
    loadWorker =
      (typeof loader === "object" || typeof loader === "function") &&
      loader !== null
        ? loader.load
        : undefined;
  } catch {
    return throwInvalidRunOption("options");
  }
  if (typeof loadWorker !== "function") return throwInvalidRunOption("loader");
  if (typeof source !== "string") return throwInvalidRunOption("source");
  if (signal !== undefined && !isRunAbortSignal(signal)) {
    return throwInvalidRunOption("signal");
  }
  return {
    loader,
    // SAFETY: The runtime function check above proves this callable snapshot.
    loadWorker: loadWorker as WorkerLoader["load"],
    source,
    hostFunctions,
    signal,
    limits
  };
}

/** Execute an async JavaScript function body in one fresh Cloudflare Dynamic Worker. */
export async function run<Output = unknown>(
  options: RunOptions
): Promise<RunResult<Output>> {
  const {
    loader,
    loadWorker,
    source,
    hostFunctions,
    signal,
    limits: configuredLimits
  } = parseRunOptions(options);
  const limits = parseRunLimits(configuredLimits);
  const hostAbort = new AbortController();
  const {
    dispatcher,
    manifest: hostManifest,
    takeHostFunctionFailure
  } = createRunHostFunctionDispatch(
    hostFunctions === undefined ? {} : hostFunctions,
    hostAbort.signal,
    limits
  );

  if (signal?.aborted) throw createRunAbortedError(signal.reason);

  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > limits.maxSourceBytes) {
    throw new RunError("Run source exceeds the configured size limit.", {
      code: "RUN_SOURCE_TOO_LARGE",
      details: {
        limit: "maxSourceBytes",
        observed: sourceBytes,
        allowed: limits.maxSourceBytes
      }
    });
  }

  let modules: Record<string, string>;
  try {
    modules = createDynamicWorkerModules(source, hostManifest);
  } catch (cause: unknown) {
    throw createRunWorkerError(cause);
  }

  // A caller abort during synchronous preflight is observed before loading.
  if (signal?.aborted) throw createRunAbortedError(signal.reason);

  let terminalError: RunError | undefined;
  let rejectTerminal: (error: RunError) => void = () => undefined;
  const terminalPromise = new Promise<never>((_resolve, reject) => {
    rejectTerminal = reject;
  });
  // Race handlers may attach later or never, so contain the rejection now.
  terminalPromise.catch(() => undefined);
  const settleTerminal = (error: RunError): void => {
    if (terminalError !== undefined) return;
    terminalError = error;
    hostAbort.abort(error);
    rejectTerminal(error);
  };
  // The first terminal event wins: a failure observed after cancellation has
  // already settled must surrender to the settled terminal error.
  const failTerminal = (error: RunError): never => {
    if (terminalError === undefined) {
      terminalError = error;
      hostAbort.abort(error);
    }
    throw terminalError;
  };
  const onCallerAbort = (): void => {
    settleTerminal(createRunAbortedError(signal?.reason));
  };

  // The wall timer starts immediately before loading and therefore covers
  // child loading, entrypoint lookup, execution, awaited host work, and the
  // terminal protocol, but not synchronous preflight validation above.
  const wallTimer = setTimeout(() => {
    settleTerminal(
      new RunError("Run timed out.", {
        code: "RUN_TIMEOUT",
        details: { limit: "timeoutMs", allowed: limits.timeoutMs }
      })
    );
  }, limits.timeoutMs);
  try {
    signal?.addEventListener("abort", onCallerAbort, { once: true });
  } catch {
    clearTimeout(wallTimer);
    throwInvalidRunOption("signal");
  }

  try {
    let worker: WorkerStub;
    try {
      worker = loadWorker.call(loader, {
        compatibilityDate: RUN_CHILD_COMPATIBILITY_DATE,
        compatibilityFlags: RUN_CHILD_COMPATIBILITY_FLAGS,
        mainModule: "executor.js",
        modules,
        env: undefined,
        globalOutbound: null,
        limits: { cpuMs: limits.cpuMs, subRequests: limits.subRequests }
      });
    } catch (cause: unknown) {
      return failTerminal(createRunWorkerError(cause));
    }
    try {
      // A re-entrant caller abort inside loader.load() must win over success.
      if (terminalError !== undefined) return failTerminal(terminalError);

      let entrypoint: RunWorkerEntrypoint;
      try {
        // SAFETY: Run controls the generated default entrypoint and defines its sole RPC method above.
        entrypoint = worker.getEntrypoint() as unknown as RunWorkerEntrypoint;
      } catch (cause: unknown) {
        return failTerminal(createRunWorkerError(cause));
      }

      try {
        // A re-entrant caller abort during entrypoint acquisition must win
        // before generated code starts.
        if (terminalError !== undefined) return failTerminal(terminalError);

        let evaluated: Promise<unknown>;
        try {
          evaluated = Promise.resolve(
            entrypoint.evaluate(dispatcher, hostManifest, {
              maxLogBytes: limits.maxLogBytes,
              maxHostFunctionCalls: limits.maxHostFunctionCalls,
              maxConcurrentHostFunctionCalls:
                limits.maxConcurrentHostFunctionCalls
            })
          );
        } catch (cause: unknown) {
          return failTerminal(createRunWorkerError(cause));
        }

        let rawResponse: unknown;
        try {
          rawResponse = await Promise.race([evaluated, terminalPromise]);
        } catch (cause: unknown) {
          // Disposal below cancels the child; contain its late settlement.
          evaluated.catch(() => undefined);
          if (cause === terminalError && cause !== undefined) throw cause;
          return failTerminal(createRunWorkerError(cause));
        }
        // The race can select an already-settled evaluation even when a
        // terminal event settled first, so first-event-wins is re-checked.
        if (terminalError !== undefined) {
          evaluated.catch(() => undefined);
          return failTerminal(terminalError);
        }

        let response: RunWorkerResponse | undefined;
        try {
          response = parseRunWorkerResponse(rawResponse);
        } catch (cause: unknown) {
          return failTerminal(
            new RunError("Dynamic Worker returned an invalid response.", {
              code: "RUN_WORKER_ERROR",
              cause
            })
          );
        }
        if (!response) {
          return failTerminal(
            new RunError("Dynamic Worker returned an invalid response.", {
              code: "RUN_WORKER_ERROR"
            })
          );
        }
        if (response.status === "failed") {
          return failTerminal(
            createRunExecutionError(response, takeHostFunctionFailure, limits)
          );
        }

        // SAFETY: Output is explicitly a caller assertion; Workers RPC supplied the runtime value.
        const value = response.value as Output;
        return { status: "completed", value, logs: response.logs };
      } finally {
        disposeRunResource(entrypoint);
      }
    } finally {
      disposeRunResource(worker);
    }
  } finally {
    clearTimeout(wallTimer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
