import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  RunHostFunctionDispatcherContract,
  RunHostFunctionManifestEntry,
  RunHostFunctionResponse,
  RunWorkerErrorRecord,
  RunWorkerResponse
} from "./dynamic-worker-protocol";
import type { RunLog } from "./run-types";

type RunInternalErrorCode =
  | "RUN_HOST_FUNCTION_ERROR"
  | "RUN_SERIALIZATION_ERROR";

const runArrayIsArray = Array.isArray;
const runObjectIs = Object.is;
const runReflectApply = Reflect.apply;
const runReflectGet = Reflect.get;
const runString = String;
const runWeakSetAdd = WeakSet.prototype.add;
const runWeakSetHas = WeakSet.prototype.has;
const runHostFunctionErrors = new WeakSet<object>();
const runSerializationErrors = new WeakSet<object>();

class RunHostFunctionError extends Error {
  readonly code = "RUN_HOST_FUNCTION_ERROR";

  constructor() {
    super("Host function failed.");
    this.name = "RunHostFunctionError";
    runReflectApply(runWeakSetAdd, runHostFunctionErrors, [this]);
  }
}

class RunSerializationError extends Error {
  readonly code = "RUN_SERIALIZATION_ERROR";

  constructor() {
    super("Run data could not be serialized.");
    this.name = "RunSerializationError";
    runReflectApply(runWeakSetAdd, runSerializationErrors, [this]);
  }
}

function readRunErrorString(
  error: unknown,
  property: "name" | "message" | "stack"
): string | undefined {
  if (
    (typeof error !== "object" && typeof error !== "function") ||
    error === null
  ) {
    return undefined;
  }
  try {
    const value = runReflectGet(error, property);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasRunErrorBrand(set: WeakSet<object>, value: object): boolean {
  try {
    return runReflectApply(runWeakSetHas, set, [value]);
  } catch {
    return false;
  }
}

function createInternalRunErrorRecord(
  error: object,
  name: string,
  message: string,
  code: RunInternalErrorCode
): RunWorkerErrorRecord {
  const stack = readRunErrorString(error, "stack");
  return { name, message, code, ...(stack === undefined ? {} : { stack }) };
}

function createRunErrorRecord(error: unknown): RunWorkerErrorRecord {
  if (
    typeof error === "object" &&
    error !== null &&
    hasRunErrorBrand(runHostFunctionErrors, error)
  ) {
    return createInternalRunErrorRecord(
      error,
      "RunHostFunctionError",
      "Host function failed.",
      "RUN_HOST_FUNCTION_ERROR"
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    hasRunErrorBrand(runSerializationErrors, error)
  ) {
    return createInternalRunErrorRecord(
      error,
      "RunSerializationError",
      "Run data could not be serialized.",
      "RUN_SERIALIZATION_ERROR"
    );
  }
  if (
    (typeof error === "object" || typeof error === "function") &&
    error !== null
  ) {
    const stack = readRunErrorString(error, "stack");
    return {
      name: readRunErrorString(error, "name") ?? "Error",
      message:
        readRunErrorString(error, "message") ??
        "Generated code threw an error.",
      ...(stack === undefined ? {} : { stack })
    };
  }
  try {
    return { name: "Error", message: runString(error) };
  } catch {
    return { name: "Error", message: "Generated code threw an unknown value." };
  }
}

function formatRunLogValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "bigint":
      return `${runString(value)}n`;
    case "number":
      return runObjectIs(value, -0) ? "-0" : runString(value);
    case "string":
      return value;
    case "function":
      return "[Function]";
    case "object":
      try {
        return runArrayIsArray(value) ? "[Array]" : "[Object]";
      } catch {
        return "[Unformattable]";
      }
    default:
      return runString(value);
  }
}

export default class RunExecutor extends WorkerEntrypoint {
  async evaluate(
    dispatcher: RunHostFunctionDispatcherContract,
    manifest: readonly RunHostFunctionManifestEntry[]
  ): Promise<RunWorkerResponse> {
    const logs: RunLog[] = [];
    const capture =
      (level: RunLog["level"]) =>
      (...args: unknown[]): void => {
        logs.push({
          level,
          message: args.map(formatRunLogValue).join(" ")
        });
      };
    Object.defineProperty(globalThis, "console", {
      configurable: true,
      value: Object.freeze({
        debug: capture("debug"),
        info: capture("info"),
        log: capture("log"),
        warn: capture("warn"),
        error: capture("error")
      })
    });

    const hostNamespaces = manifest.map(({ namespace, functions }) =>
      Object.freeze(
        Object.fromEntries(
          functions.map((functionName) => [
            functionName,
            async (...args: unknown[]): Promise<unknown> => {
              let response: RunHostFunctionResponse;
              try {
                response = await dispatcher.callHostFunction(
                  namespace,
                  functionName,
                  args
                );
              } catch (cause: unknown) {
                if (readRunErrorString(cause, "name") === "DataCloneError") {
                  throw new RunSerializationError();
                }
                throw cause;
              }
              if (response.status !== "completed") {
                throw new RunHostFunctionError();
              }
              return response.value;
            }
          ])
        )
      )
    );

    try {
      return {
        status: "completed",
        value: await __runUser__(...hostNamespaces),
        logs
      };
    } catch (cause: unknown) {
      return { status: "failed", error: createRunErrorRecord(cause), logs };
    }
  }
}

/** Imported by the executor prefix after this checked module is emitted. */
declare function __runUser__(...hostNamespaces: object[]): Promise<unknown>;
