import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  RunHostFunctionDispatcherContract,
  RunHostFunctionManifestEntry,
  RunHostFunctionResponse,
  RunWorkerErrorRecord,
  RunWorkerResponse
} from "./dynamic-worker-protocol";
import type { RunDataParseResult, RunDataPath } from "./run-data";
import type { RunLog } from "./run-types";

type RunInternalErrorMetadata = {
  readonly name: string;
  readonly message: string;
} & (
  | {
      readonly code: "RUN_HOST_FUNCTION_ERROR";
      readonly hostFailureId: number;
    }
  | ({ readonly code: "RUN_SERIALIZATION_ERROR" } & (
      | { readonly path: "result"; readonly hostFunction?: never }
      | {
          readonly path: "hostFunction.arguments" | "hostFunction.result";
          readonly hostFunction: string;
        }
    ))
  | {
      readonly code: "RUN_WORKER_ERROR";
      readonly hostFunction: string;
    }
);

const runArrayIsArray = Array.isArray;
const runArrayJoin = Array.prototype.join;
const runArrayPush = Array.prototype.push;
const runMathCeil = Math.ceil;
const runNumberIsSafeInteger = Number.isSafeInteger;
const runObjectIs = Object.is;
const runReflectApply = Reflect.apply;
const runReflectGet = Reflect.get;
const runReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const runReflectGetPrototypeOf = Reflect.getPrototypeOf;
const runReflectHas = Reflect.has;
const runString = String;
const runStringCharCodeAt = String.prototype.charCodeAt;
const runStringSlice = String.prototype.slice;
const runErrorTextEncoder = new TextEncoder();
const runTextEncoderEncode = TextEncoder.prototype.encode;
const runWeakMapGet = WeakMap.prototype.get;
const runWeakMapSet = WeakMap.prototype.set;
const runInternalErrors = new WeakMap<object, RunInternalErrorMetadata>();

function getRunTypedArrayByteLengthGetter(): (this: object) => number {
  const prototype = runReflectGetPrototypeOf(Uint8Array.prototype);
  const getter =
    prototype === null
      ? undefined
      : runReflectGetOwnPropertyDescriptor(prototype, "byteLength")?.get;
  if (getter === undefined) {
    throw new Error("Run UTF-8 byte measurement is unavailable.");
  }
  return getter;
}

const runTypedArrayByteLengthGetter = getRunTypedArrayByteLengthGetter();

function getRunUtf8ByteLength(value: string): number {
  const encoded = runReflectApply(runTextEncoderEncode, runErrorTextEncoder, [
    value
  ]);
  return runReflectApply(runTypedArrayByteLengthGetter, encoded, []);
}

function truncateRunUtf8(value: string, maximumBytes: number): string {
  if (getRunUtf8ByteLength(value) <= maximumBytes) return value;

  const suffix = "…";
  const contentBytes = maximumBytes - getRunUtf8ByteLength(suffix);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = runMathCeil((low + high) / 2);
    const candidate = runReflectApply(runStringSlice, value, [0, middle]);
    if (getRunUtf8ByteLength(candidate) <= contentBytes) low = middle;
    else high = middle - 1;
  }
  if (
    low > 0 &&
    runReflectApply(runStringCharCodeAt, value, [low - 1]) >= 0xd800 &&
    runReflectApply(runStringCharCodeAt, value, [low - 1]) <= 0xdbff
  ) {
    low--;
  }
  return `${runReflectApply(runStringSlice, value, [0, low])}${suffix}`;
}

function brandRunInternalError(
  error: object,
  metadata: RunInternalErrorMetadata
): void {
  runReflectApply(runWeakMapSet, runInternalErrors, [error, metadata]);
}

class RunHostFunctionError extends Error {
  readonly code = "RUN_HOST_FUNCTION_ERROR";

  constructor(hostFailureId: number) {
    super("Host function failed.");
    this.name = "RunHostFunctionError";
    brandRunInternalError(this, {
      name: "RunHostFunctionError",
      message: "Host function failed.",
      code: "RUN_HOST_FUNCTION_ERROR",
      hostFailureId
    });
  }
}

class RunWorkerProtocolError extends Error {
  readonly code = "RUN_WORKER_ERROR";

  constructor(hostFunction: string) {
    super("Run host function protocol failed.");
    this.name = "RunWorkerProtocolError";
    brandRunInternalError(this, {
      name: "RunWorkerProtocolError",
      message: "Run host function protocol failed.",
      code: "RUN_WORKER_ERROR",
      hostFunction
    });
  }
}

class RunSerializationError extends Error {
  readonly code = "RUN_SERIALIZATION_ERROR";

  constructor(path: "result");
  constructor(
    path: "hostFunction.arguments" | "hostFunction.result",
    hostFunction: string
  );
  constructor(path: RunDataPath, hostFunction?: string) {
    super("Run data could not be serialized.");
    this.name = "RunSerializationError";
    const diagnostic = {
      name: "RunSerializationError",
      message: "Run data could not be serialized.",
      code: "RUN_SERIALIZATION_ERROR" as const
    };
    if (path === "result") {
      brandRunInternalError(this, { ...diagnostic, path });
    } else if (hostFunction !== undefined) {
      brandRunInternalError(this, { ...diagnostic, path, hostFunction });
    } else {
      throw new Error("Run host serialization failure has no function name.");
    }
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

function readRunInternalErrorMetadata(
  error: object
): RunInternalErrorMetadata | undefined {
  try {
    return runReflectApply(runWeakMapGet, runInternalErrors, [error]);
  } catch {
    return undefined;
  }
}

function createRunErrorDiagnostic(
  name: string,
  message: string,
  stack?: string
) {
  return {
    name: truncateRunUtf8(name, 256),
    message: truncateRunUtf8(message, 16 * 1024),
    ...(stack === undefined ? {} : { stack: truncateRunUtf8(stack, 32 * 1024) })
  };
}

function createRunErrorRecord(error: unknown): RunWorkerErrorRecord {
  if (typeof error === "object" && error !== null) {
    const metadata = readRunInternalErrorMetadata(error);
    if (metadata !== undefined) {
      const diagnostic = createRunErrorDiagnostic(
        metadata.name,
        metadata.message,
        readRunErrorString(error, "stack")
      );
      switch (metadata.code) {
        case "RUN_HOST_FUNCTION_ERROR":
          return {
            ...diagnostic,
            code: metadata.code,
            hostFailureId: metadata.hostFailureId
          };
        case "RUN_SERIALIZATION_ERROR":
          return metadata.path === "result"
            ? { ...diagnostic, code: metadata.code, path: metadata.path }
            : {
                ...diagnostic,
                code: metadata.code,
                path: metadata.path,
                hostFunction: truncateRunUtf8(metadata.hostFunction, 256)
              };
        case "RUN_WORKER_ERROR":
          return {
            ...diagnostic,
            code: metadata.code,
            hostFunction: truncateRunUtf8(metadata.hostFunction, 256)
          };
      }
    }
  }
  if (
    (typeof error === "object" || typeof error === "function") &&
    error !== null
  ) {
    return createRunErrorDiagnostic(
      readRunErrorString(error, "name") ?? "Error",
      readRunErrorString(error, "message") ?? "Generated code threw an error.",
      readRunErrorString(error, "stack")
    );
  }
  try {
    return createRunErrorDiagnostic("Error", runString(error));
  } catch {
    return createRunErrorDiagnostic(
      "Error",
      "Generated code threw an unknown value."
    );
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

/** Generated Worker entrypoint that contains guest execution and host RPC. */
export default class RunExecutor extends WorkerEntrypoint {
  /** Execute the wrapped caller source with its validated host-function manifest. */
  async evaluate(
    dispatcher: RunHostFunctionDispatcherContract,
    manifest: readonly RunHostFunctionManifestEntry[]
  ): Promise<RunWorkerResponse> {
    const logs: RunLog[] = [];
    for (const { namespace } of manifest) {
      if (runReflectHas(globalThis, namespace)) {
        return {
          status: "failed",
          error: {
            name: "RunInvalidInputError",
            message: "Host function namespace conflicts with a child global.",
            code: "RUN_INVALID_INPUT",
            path: "hostFunctions.namespace"
          },
          logs
        };
      }
    }

    const capture =
      (level: RunLog["level"]) =>
      (...args: unknown[]): void => {
        const messages: string[] = [];
        for (let index = 0; index < args.length; index++) {
          runReflectApply(runArrayPush, messages, [
            formatRunLogValue(args[index])
          ]);
        }
        runReflectApply(runArrayPush, logs, [
          {
            level,
            message: runReflectApply(runArrayJoin, messages, [" "])
          }
        ]);
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

    let nextHostFunctionCallId = 1;
    const hostNamespaces = manifest.map(({ namespace, functions }) =>
      Object.freeze(
        Object.fromEntries(
          functions.map((functionName) => [
            functionName,
            async (...args: unknown[]): Promise<unknown> => {
              const hostFunction = `${namespace}.${functionName}`;
              const parsedArguments = parseRunData(
                args,
                "hostFunction.arguments"
              );
              if (parsedArguments.status === "rejected") {
                throw new RunSerializationError(
                  parsedArguments.path,
                  hostFunction
                );
              }

              const callId = nextHostFunctionCallId++;
              let responsePromise: Promise<RunHostFunctionResponse>;
              try {
                responsePromise = dispatcher.callHostFunction(
                  callId,
                  namespace,
                  functionName,
                  parsedArguments.value
                );
              } catch {
                throw new RunSerializationError(
                  "hostFunction.arguments",
                  hostFunction
                );
              }

              let response: RunHostFunctionResponse;
              try {
                response = await responsePromise;
              } catch {
                throw new RunSerializationError(
                  "hostFunction.result",
                  hostFunction
                );
              }
              if (response.status === "completed") return response.value;
              if (response.status === "serializationFailed") {
                throw new RunSerializationError(
                  "hostFunction.result",
                  hostFunction
                );
              }
              if (
                response.status === "failed" &&
                runNumberIsSafeInteger(response.failureId) &&
                response.failureId === callId
              ) {
                throw new RunHostFunctionError(response.failureId);
              }
              throw new RunWorkerProtocolError(hostFunction);
            }
          ])
        )
      )
    );

    try {
      const value = await __runUser__(...hostNamespaces);
      const parsedResult = parseRunData(value, "result");
      if (parsedResult.status === "rejected") {
        throw new RunSerializationError(parsedResult.path);
      }
      return {
        status: "completed",
        value: parsedResult.value,
        logs
      };
    } catch (cause: unknown) {
      return { status: "failed", error: createRunErrorRecord(cause), logs };
    }
  }
}

/** Imported by the executor prefix after this checked module is emitted. */
declare function __runUser__(...hostNamespaces: object[]): Promise<unknown>;

/** Defined by the checked run-data prefix embedded before this module. */
declare function parseRunData<Value, Path extends RunDataPath>(
  value: Value,
  path: Path
): RunDataParseResult<Value, Path>;
