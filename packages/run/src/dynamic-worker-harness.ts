const RUN_DYNAMIC_WORKER_EXECUTOR_SOURCE = String.raw`
import { WorkerEntrypoint } from "cloudflare:workers";
import __runUser__ from "./run.js";

class RunHostFunctionError extends Error {
  constructor() {
    super("Host function failed.");
    this.name = "RunHostFunctionError";
    this.code = "RUN_HOST_FUNCTION_ERROR";
  }
}

class RunSerializationError extends Error {
  constructor() {
    super("Run data could not be serialized.");
    this.name = "RunSerializationError";
    this.code = "RUN_SERIALIZATION_ERROR";
  }
}

function __runFormatLogValue(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "bigint": return String(value) + "n";
    case "number": return Object.is(value, -0) ? "-0" : String(value);
    case "string": return value;
    case "function": return "[Function]";
    case "object":
      try {
        return Array.isArray(value) ? "[Array]" : "[Object]";
      } catch {
        return "[Unformattable]";
      }
    default: return String(value);
  }
}

function __runErrorString(error, property, fallback) {
  try {
    const value = error[property];
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

function __runErrorRecord(error) {
  if (error instanceof RunHostFunctionError) {
    return {
      name: "RunHostFunctionError",
      message: "Host function failed.",
      stack: __runErrorString(error, "stack", undefined),
      code: "RUN_HOST_FUNCTION_ERROR"
    };
  }
  if (error instanceof RunSerializationError) {
    return {
      name: "RunSerializationError",
      message: "Run data could not be serialized.",
      stack: __runErrorString(error, "stack", undefined),
      code: "RUN_SERIALIZATION_ERROR"
    };
  }
  if (error instanceof Error) {
    return {
      name: __runErrorString(error, "name", "Error"),
      message: __runErrorString(
        error,
        "message",
        "Generated code threw an error."
      ),
      stack: __runErrorString(error, "stack", undefined)
    };
  }
  try {
    return { name: "Error", message: String(error) };
  } catch {
    return { name: "Error", message: "Generated code threw an unknown value." };
  }
}

export default class RunExecutor extends WorkerEntrypoint {
  async evaluate(dispatcher, manifest) {
    const logs = [];
    const capture = (level) => (...args) => {
      logs.push({ level, message: args.map(__runFormatLogValue).join(" ") });
    };
    globalThis.console = Object.freeze({
      debug: capture("debug"),
      info: capture("info"),
      log: capture("log"),
      warn: capture("warn"),
      error: capture("error")
    });

    const hostNamespaces = manifest.map(({ namespace, functions }) =>
      Object.freeze(Object.fromEntries(functions.map((functionName) => [
        functionName,
        async (...args) => {
          let response;
          try {
            response = await dispatcher.callHostFunction(
              namespace,
              functionName,
              args
            );
          } catch (error) {
            if (error && error.name === "DataCloneError") {
              throw new RunSerializationError();
            }
            throw error;
          }
          if (response.status !== "completed") {
            throw new RunHostFunctionError();
          }
          return response.value;
        }
      ])))
    );

    try {
      return {
        status: "completed",
        value: await __runUser__(...hostNamespaces),
        logs
      };
    } catch (error) {
      return { status: "failed", error: __runErrorRecord(error), logs };
    }
  }
}
`;

/** Names exposed to caller source for one host function namespace. */
export interface RunHostFunctionManifestEntry {
  /** Exact namespace passed as a generated function parameter. */
  readonly namespace: string;
  /** Exact callable property names exposed in the namespace. */
  readonly functions: readonly string[];
}

/** Build the two package-owned modules loaded for one Run invocation. */
export function createDynamicWorkerModules(
  source: string,
  manifest: readonly RunHostFunctionManifestEntry[]
): Record<string, string> {
  const parameters = manifest.map(({ namespace }) => namespace).join(", ");
  return {
    "executor.js": RUN_DYNAMIC_WORKER_EXECUTOR_SOURCE,
    "run.js": `export default async function __runUser__(${parameters}) {\n${source}\n}`
  };
}
