import { createDynamicWorkerModules } from "./dynamic-worker-harness";
import type {
  RunHostFunctionManifestEntry,
  RunWorkerErrorRecord,
  RunWorkerResponse
} from "./dynamic-worker-protocol";
import { createRunHostFunctionDispatch } from "./host-function-dispatch";
import type {
  RunHostFunctionDispatcher,
  TakeRunHostFunctionFailure
} from "./host-function-dispatch";
import { RunError } from "./run-error";
import type { RunLog, RunOptions, RunResult } from "./run-types";

const RUN_CHILD_COMPATIBILITY_DATE = "2026-08-27";
const RUN_CHILD_COMPATIBILITY_FLAGS = ["nodejs_compat"];
const RUN_DEFAULT_CPU_MS = 5_000;
const RUN_DEFAULT_SUBREQUESTS = 256;

interface RunWorkerEntrypoint {
  evaluate(
    dispatcher: RunHostFunctionDispatcher,
    manifest: readonly RunHostFunctionManifestEntry[]
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
  switch (code) {
    case undefined:
      return path === undefined &&
        hostFunction === undefined &&
        hostFailureId === undefined
        ? diagnostic
        : undefined;
    case "RUN_HOST_FUNCTION_ERROR":
      return path === undefined &&
        hostFunction === undefined &&
        typeof hostFailureId === "number" &&
        Number.isSafeInteger(hostFailureId) &&
        hostFailureId > 0
        ? { ...diagnostic, code, hostFailureId }
        : undefined;
    case "RUN_INVALID_INPUT":
      return path === "hostFunctions.namespace" &&
        hostFunction === undefined &&
        hostFailureId === undefined
        ? { ...diagnostic, code, path }
        : undefined;
    case "RUN_SERIALIZATION_ERROR":
      if (hostFailureId !== undefined) return undefined;
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
    message?.includes("could not be cloned") === true
  ) {
    return new RunError("Run data could not be serialized.", {
      code: "RUN_SERIALIZATION_ERROR",
      cause
    });
  }
  return new RunError("Dynamic Worker execution failed.", {
    code: "RUN_WORKER_ERROR",
    cause
  });
}

function createRunExecutionError(
  response: Extract<RunWorkerResponse, { status: "failed" }>,
  takeHostFunctionFailure: TakeRunHostFunctionFailure
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

/** Execute an async JavaScript function body in one fresh Cloudflare Dynamic Worker. */
export async function run<Output = unknown>(
  options: RunOptions
): Promise<RunResult<Output>> {
  const configuredHostFunctions =
    options.hostFunctions === undefined ? {} : options.hostFunctions;
  const {
    dispatcher,
    manifest: hostManifest,
    takeHostFunctionFailure
  } = createRunHostFunctionDispatch(configuredHostFunctions);

  let worker: WorkerStub;
  try {
    worker = options.loader.load({
      compatibilityDate: RUN_CHILD_COMPATIBILITY_DATE,
      compatibilityFlags: RUN_CHILD_COMPATIBILITY_FLAGS,
      mainModule: "executor.js",
      modules: createDynamicWorkerModules(options.source, hostManifest),
      env: undefined,
      globalOutbound: null,
      limits: {
        cpuMs: RUN_DEFAULT_CPU_MS,
        subRequests: RUN_DEFAULT_SUBREQUESTS
      }
    });
  } catch (cause: unknown) {
    throw createRunWorkerError(cause);
  }

  try {
    let entrypoint: RunWorkerEntrypoint;
    try {
      // SAFETY: Run controls the generated default entrypoint and defines its sole RPC method above.
      entrypoint = worker.getEntrypoint() as unknown as RunWorkerEntrypoint;
    } catch (cause: unknown) {
      throw createRunWorkerError(cause);
    }

    try {
      let rawResponse: unknown;
      try {
        rawResponse = await entrypoint.evaluate(dispatcher, hostManifest);
      } catch (cause: unknown) {
        throw createRunWorkerError(cause);
      }

      let response: RunWorkerResponse | undefined;
      try {
        response = parseRunWorkerResponse(rawResponse);
      } catch (cause: unknown) {
        throw new RunError("Dynamic Worker returned an invalid response.", {
          code: "RUN_WORKER_ERROR",
          cause
        });
      }
      if (!response) {
        throw new RunError("Dynamic Worker returned an invalid response.", {
          code: "RUN_WORKER_ERROR"
        });
      }
      if (response.status === "failed") {
        throw createRunExecutionError(response, takeHostFunctionFailure);
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
}
