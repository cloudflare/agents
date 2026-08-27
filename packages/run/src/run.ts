import { RpcTarget } from "cloudflare:workers";
import { createDynamicWorkerModules } from "./dynamic-worker-harness";
import type { RunHostFunctionManifestEntry } from "./dynamic-worker-harness";
import { RunError } from "./run-error";
import type { HostFunctions, RunLog, RunOptions, RunResult } from "./run-types";

const RUN_CHILD_COMPATIBILITY_DATE = "2026-08-27";
const RUN_CHILD_COMPATIBILITY_FLAGS = ["nodejs_compat"];
const RUN_DEFAULT_CPU_MS = 5_000;
const RUN_DEFAULT_SUBREQUESTS = 256;

type RunHostFunctionResponse =
  | { readonly status: "completed"; readonly value: unknown }
  | { readonly status: "failed" };

class RunHostFunctionDispatcher extends RpcTarget {
  readonly #hostFunctions: HostFunctions;

  constructor(hostFunctions: HostFunctions) {
    super();
    this.#hostFunctions = hostFunctions;
  }

  async callHostFunction(
    namespace: string,
    functionName: string,
    args: unknown[]
  ): Promise<RunHostFunctionResponse> {
    const hostFunction = this.#hostFunctions[namespace]?.[functionName];
    if (typeof hostFunction !== "function") return { status: "failed" };

    try {
      return {
        status: "completed",
        value: await Reflect.apply(hostFunction, undefined, args)
      };
    } catch {
      return { status: "failed" };
    }
  }
}

interface RunWorkerEntrypoint {
  evaluate(
    dispatcher: RunHostFunctionDispatcher,
    manifest: readonly RunHostFunctionManifestEntry[]
  ): Promise<unknown>;
}

interface RunWorkerErrorRecord {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}

type RunWorkerResponse =
  | {
      readonly status: "completed";
      readonly value: unknown;
      readonly logs: RunLog[];
    }
  | {
      readonly status: "failed";
      readonly error: RunWorkerErrorRecord;
      readonly logs: RunLog[];
    };

function disposeRunResource(resource: object): void {
  if (!(Symbol.dispose in resource)) return;
  const dispose = Reflect.get(resource, Symbol.dispose);
  if (typeof dispose !== "function") return;
  try {
    Reflect.apply(dispose, resource, []);
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

function parseRunWorkerResponse(value: unknown): RunWorkerResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const status = Reflect.get(value, "status");
  const logs = parseRunLogs(Reflect.get(value, "logs"));
  if (!logs) return undefined;

  if (status === "completed") {
    return { status, value: Reflect.get(value, "value"), logs };
  }
  if (status !== "failed") return undefined;

  const error = Reflect.get(value, "error");
  if (typeof error !== "object" || error === null) return undefined;
  const name = Reflect.get(error, "name");
  const message = Reflect.get(error, "message");
  const stack = Reflect.get(error, "stack");
  const code = Reflect.get(error, "code");
  if (
    typeof name !== "string" ||
    typeof message !== "string" ||
    (stack !== undefined && typeof stack !== "string") ||
    (code !== undefined && typeof code !== "string")
  ) {
    return undefined;
  }

  return {
    status,
    error: {
      name,
      message,
      ...(stack === undefined ? {} : { stack }),
      ...(code === undefined ? {} : { code })
    },
    logs
  };
}

function isRunCompileFailure(cause: unknown): boolean {
  if (cause instanceof SyntaxError) return true;
  if (typeof cause !== "object" || cause === null) return false;
  if (Reflect.get(cause, "name") === "SyntaxError") return true;
  const message = Reflect.get(cause, "message");
  return (
    typeof message === "string" && message.includes("Uncaught SyntaxError:")
  );
}

function isRunSerializationFailure(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  if (Reflect.get(cause, "name") === "DataCloneError") return true;
  const message = Reflect.get(cause, "message");
  return typeof message === "string" && message.includes("could not be cloned");
}

function createRunWorkerError(cause: unknown): RunError {
  if (isRunCompileFailure(cause)) {
    return new RunError("Run source could not be compiled.", {
      code: "RUN_COMPILE_ERROR",
      cause
    });
  }
  if (isRunSerializationFailure(cause)) {
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

function createRunHostManifest(
  hostFunctions: HostFunctions
): RunHostFunctionManifestEntry[] {
  return Object.entries(hostFunctions).map(([namespace, functions]) => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(namespace)) {
      throw new RunError("Host function namespace is not a valid identifier.", {
        code: "RUN_INVALID_INPUT"
      });
    }
    return { namespace, functions: Object.keys(functions) };
  });
}

function createRunExecutionError(
  response: Extract<RunWorkerResponse, { status: "failed" }>
): RunError {
  const code =
    response.error.code === "RUN_HOST_FUNCTION_ERROR" ||
    response.error.code === "RUN_SERIALIZATION_ERROR"
      ? response.error.code
      : "RUN_EXECUTION_ERROR";
  const error = new RunError(
    code === "RUN_HOST_FUNCTION_ERROR"
      ? "Host function failed."
      : response.error.message,
    { code, logs: response.logs }
  );
  if (response.error.stack !== undefined) error.stack = response.error.stack;
  return error;
}

/** Execute an async JavaScript function body in one fresh Cloudflare Dynamic Worker. */
export async function run<Output = unknown>(
  options: RunOptions
): Promise<RunResult<Output>> {
  const hostFunctions = options.hostFunctions ?? {};
  const hostManifest = createRunHostManifest(hostFunctions);
  const dispatcher = new RunHostFunctionDispatcher(hostFunctions);

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
        throw createRunExecutionError(response);
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
