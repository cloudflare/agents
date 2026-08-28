import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  RunHostFunctionDispatcherContract,
  RunHostFunctionLimitName,
  RunHostFunctionManifestEntry,
  RunHostFunctionResponse,
  RunWorkerErrorClassification,
  RunWorkerErrorRecord,
  RunWorkerLimits,
  RunWorkerResponse
} from "./dynamic-worker-protocol";
import { parseRunData, type RunDataPath } from "./run-data";
import { getRunUtf8ByteLength, truncateRunUtf8 } from "./run-utf8";
import type { RunLog } from "./run-types";

type RunInternalErrorMetadata = {
  readonly name: string;
  readonly message: string;
} & Exclude<
  RunWorkerErrorClassification,
  | { readonly code?: undefined }
  | { readonly code: "RUN_INVALID_INPUT" }
  | { readonly code: "RUN_DETACHED_HOST_FUNCTION" }
>;

const RUN_LOG_TRUNCATION_WARNING = "Console output truncated.";

const runArrayIsArray = Array.isArray;
const runArrayJoin = Array.prototype.join;
const runArrayPush = Array.prototype.push;
const runNumberIsSafeInteger = Number.isSafeInteger;
const runObjectIs = Object.is;
const runObjectKeys = Object.keys;
const runPromiseThen = Promise.prototype.then;
const runPromiseFinally = Promise.prototype.finally;
const runReflectApply = Reflect.apply;
const runReflectGet = Reflect.get;
const runReflectHas = Reflect.has;
const runReflectSetPrototypeOf = Reflect.setPrototypeOf;
const runArrayPrototype = Array.prototype;
const runString = String;
const runWeakMapGet = WeakMap.prototype.get;
const runWeakMapSet = WeakMap.prototype.set;
const runInternalErrors = new WeakMap<object, RunInternalErrorMetadata>();
const RUN_LOG_TRUNCATION_WARNING_BYTES = getRunUtf8ByteLength(
  RUN_LOG_TRUNCATION_WARNING
);

function runNoop(): void {
  // Retained terminal handler for containment of unobserved settlements.
}

/**
 * Create an array whose writes cannot reach guest-installed numeric setters
 * on Array.prototype. Native push assigns through the prototype chain, so
 * package-owned arrays written during or after guest execution stay detached.
 */
function createRunShieldedArray<Value>(): Value[] {
  const values: Value[] = [];
  runReflectSetPrototypeOf(values, null);
  return values;
}

function brandRunInternalError(
  error: object,
  metadata: RunInternalErrorMetadata
): void {
  runReflectApply(runWeakMapSet, runInternalErrors, [error, metadata]);
}

class RunHostFunctionError extends Error {
  // Class fields use define semantics, so a guest-installed prototype `name`
  // setter cannot intercept construction of package-owned errors.
  override readonly name = "RunHostFunctionError";
  readonly code = "RUN_HOST_FUNCTION_ERROR";

  constructor(hostFailureId: number) {
    super("Host function failed.");
    brandRunInternalError(this, {
      name: "RunHostFunctionError",
      message: "Host function failed.",
      code: "RUN_HOST_FUNCTION_ERROR",
      hostFailureId
    });
  }
}

class RunHostFunctionLimitError extends Error {
  override readonly name = "RunHostFunctionLimitError";
  readonly code = "RUN_HOST_FUNCTION_LIMIT";

  constructor(limit: RunHostFunctionLimitName, hostFunction: string) {
    super("Host function call limit exceeded.");
    brandRunInternalError(this, {
      name: "RunHostFunctionLimitError",
      message: "Host function call limit exceeded.",
      code: "RUN_HOST_FUNCTION_LIMIT",
      limit,
      hostFunction
    });
  }
}

class RunWorkerProtocolError extends Error {
  override readonly name = "RunWorkerProtocolError";
  readonly code = "RUN_WORKER_ERROR";

  constructor(hostFunction: string) {
    super("Run host function protocol failed.");
    brandRunInternalError(this, {
      name: "RunWorkerProtocolError",
      message: "Run host function protocol failed.",
      code: "RUN_WORKER_ERROR",
      hostFunction
    });
  }
}

class RunSerializationError extends Error {
  override readonly name = "RunSerializationError";
  readonly code = "RUN_SERIALIZATION_ERROR";

  constructor(path: "result");
  constructor(
    path: "hostFunction.arguments" | "hostFunction.result",
    hostFunction: string
  );
  constructor(path: RunDataPath, hostFunction?: string) {
    super("Run data could not be serialized.");
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
        case "RUN_HOST_FUNCTION_LIMIT":
          return {
            ...diagnostic,
            code: metadata.code,
            limit: metadata.limit,
            hostFunction: truncateRunUtf8(metadata.hostFunction, 256)
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
            ...(metadata.hostFunction === undefined
              ? {}
              : { hostFunction: truncateRunUtf8(metadata.hostFunction, 256) })
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

/**
 * Mutable per-run host-call accounting shared by every generated stub. The
 * started-call total is always `nextCallId - 1`, so it carries no separate
 * counter that could disagree.
 */
interface RunHostCallState {
  readonly limits: RunWorkerLimits;
  pendingCount: number;
  readonly pendingHostFunctions: Record<string, string>;
  nextCallId: number;
}

/** The internal lazy promise-like returned by every generated host call. */
type RunLazyHostCall = {
  then: (onFulfilled?: unknown, onRejected?: unknown) => unknown;
  catch: (onRejected?: unknown) => unknown;
  finally: (onFinally?: unknown) => unknown;
};

/**
 * Wrap one dispatch so it starts exactly once on first promise observation
 * and never starts for a completely ignored call. The dispatched promise
 * keeps terminal handlers so an unobserved settlement stays contained.
 */
function createRunLazyHostCall(start: () => Promise<unknown>): RunLazyHostCall {
  let dispatched: Promise<unknown> | undefined;
  const ensure = (): Promise<unknown> => {
    if (dispatched === undefined) {
      dispatched = start();
      runReflectApply(runPromiseThen, dispatched, [runNoop, runNoop]);
    }
    return dispatched;
  };
  return {
    then: (onFulfilled?: unknown, onRejected?: unknown) =>
      runReflectApply(runPromiseThen, ensure(), [onFulfilled, onRejected]),
    catch: (onRejected?: unknown) =>
      runReflectApply(runPromiseThen, ensure(), [undefined, onRejected]),
    finally: (onFinally?: unknown) =>
      runReflectApply(runPromiseFinally, ensure(), [onFinally])
  };
}

/** Read one pending host-function name for the detached-call diagnostic. */
function readFirstPendingHostFunction(
  pendingHostFunctions: Record<string, string>
): string {
  // Index access avoids the guest-replaceable array iterator protocol.
  const firstCallId = runObjectKeys(pendingHostFunctions)[0];
  const hostFunction =
    firstCallId === undefined ? undefined : pendingHostFunctions[firstCallId];
  return hostFunction === undefined ? "unknown" : hostFunction;
}

/**
 * Create the lazy call stub generated code invokes for one host function.
 * Every dispatcher interaction is contained here so raw transport failures
 * never escape into guest-visible errors.
 */
function createRunHostFunctionStub(
  dispatcher: RunHostFunctionDispatcherContract,
  namespace: string,
  functionName: string,
  state: RunHostCallState
): (...args: unknown[]) => RunLazyHostCall {
  const dispatch = async (args: unknown[]): Promise<unknown> => {
    const hostFunction = `${namespace}.${functionName}`;
    if (state.nextCallId > state.limits.maxHostFunctionCalls) {
      throw new RunHostFunctionLimitError("maxHostFunctionCalls", hostFunction);
    }
    if (state.pendingCount >= state.limits.maxConcurrentHostFunctionCalls) {
      throw new RunHostFunctionLimitError(
        "maxConcurrentHostFunctionCalls",
        hostFunction
      );
    }
    const parsedArguments = parseRunData(args, "hostFunction.arguments");
    if (parsedArguments.status === "rejected") {
      throw new RunSerializationError(parsedArguments.path, hostFunction);
    }

    state.pendingCount++;
    const callId = state.nextCallId++;
    state.pendingHostFunctions[callId] = hostFunction;
    try {
      let responsePromise: Promise<RunHostFunctionResponse>;
      try {
        responsePromise = dispatcher.callHostFunction(
          callId,
          namespace,
          functionName,
          parsedArguments.value
        );
      } catch {
        throw new RunSerializationError("hostFunction.arguments", hostFunction);
      }

      let response: RunHostFunctionResponse;
      try {
        response = await responsePromise;
      } catch {
        throw new RunSerializationError("hostFunction.result", hostFunction);
      }
      if (response.status === "completed") return response.value;
      if (response.status === "serializationFailed") {
        throw new RunSerializationError("hostFunction.result", hostFunction);
      }
      if (
        response.status === "failed" &&
        runNumberIsSafeInteger(response.failureId) &&
        response.failureId === callId
      ) {
        throw new RunHostFunctionError(response.failureId);
      }
      throw new RunWorkerProtocolError(hostFunction);
    } finally {
      state.pendingCount--;
      delete state.pendingHostFunctions[callId];
    }
  };
  return (...args: unknown[]): RunLazyHostCall =>
    createRunLazyHostCall(() => dispatch(args));
}

/** Generated Worker entrypoint that contains guest execution and host RPC. */
export default class RunExecutor extends WorkerEntrypoint {
  /** Execute the wrapped caller source with its validated host-function manifest. */
  async evaluate(
    dispatcher: RunHostFunctionDispatcherContract,
    manifest: readonly RunHostFunctionManifestEntry[],
    limits: RunWorkerLimits
  ): Promise<RunWorkerResponse> {
    const logs = createRunShieldedArray<RunLog>();
    // Serialization must see an ordinary array once guest code has finished.
    const finalizeRunLogs = (): RunLog[] => {
      runReflectSetPrototypeOf(logs, runArrayPrototype);
      return logs;
    };
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
          logs: finalizeRunLogs()
        };
      }
    }

    const retainedLogBytes = createRunShieldedArray<number>();
    let retainedBytes = 0;
    let logsTruncated = false;
    const capture =
      (level: RunLog["level"]) =>
      (...args: unknown[]): void => {
        if (logsTruncated) return;
        const messages = createRunShieldedArray<string>();
        for (let index = 0; index < args.length; index++) {
          runReflectApply(runArrayPush, messages, [
            formatRunLogValue(args[index])
          ]);
        }
        const message: string = runReflectApply(runArrayJoin, messages, [" "]);
        // Every retained entry charges at least one byte so empty messages
        // cannot grow the retained buffer without bound.
        const messageBytes = getRunUtf8ByteLength(message) || 1;
        if (retainedBytes + messageBytes > limits.maxLogBytes) {
          // First overflow: stop capture, drop trailing complete entries as
          // needed, and append exactly one in-budget truncation warning.
          logsTruncated = true;
          while (
            logs.length > 0 &&
            retainedBytes + RUN_LOG_TRUNCATION_WARNING_BYTES >
              limits.maxLogBytes
          ) {
            const removedBytes = retainedLogBytes[logs.length - 1];
            retainedBytes -= removedBytes === undefined ? 0 : removedBytes;
            logs.length -= 1;
            retainedLogBytes.length -= 1;
          }
          runReflectApply(runArrayPush, logs, [
            { level: "warn", message: RUN_LOG_TRUNCATION_WARNING }
          ]);
          retainedBytes += RUN_LOG_TRUNCATION_WARNING_BYTES;
          return;
        }
        runReflectApply(runArrayPush, logs, [{ level, message }]);
        runReflectApply(runArrayPush, retainedLogBytes, [messageBytes]);
        retainedBytes += messageBytes;
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

    // SAFETY: A null-prototype record keeps guest mutations of
    // Object.prototype (for example a numeric-index setter) away from
    // pending-call accounting writes.
    const pendingHostFunctions = Object.create(null) as Record<string, string>;
    const hostCallState: RunHostCallState = {
      limits,
      pendingCount: 0,
      pendingHostFunctions,
      nextCallId: 1
    };
    const hostNamespaces = manifest.map(({ namespace, functions }) =>
      Object.freeze(
        Object.fromEntries(
          functions.map((functionName) => [
            functionName,
            createRunHostFunctionStub(
              dispatcher,
              namespace,
              functionName,
              hostCallState
            )
          ])
        )
      )
    );

    try {
      const value = await __runUser__(...hostNamespaces);
      if (hostCallState.pendingCount > 0) {
        return {
          status: "failed",
          error: {
            name: "RunDetachedHostFunctionError",
            message:
              "Generated code returned while a host function call was unsettled.",
            code: "RUN_DETACHED_HOST_FUNCTION",
            hostFunction: truncateRunUtf8(
              readFirstPendingHostFunction(hostCallState.pendingHostFunctions),
              256
            )
          },
          logs: finalizeRunLogs()
        };
      }
      const parsedResult = parseRunData(value, "result");
      if (parsedResult.status === "rejected") {
        throw new RunSerializationError(parsedResult.path);
      }
      return {
        status: "completed",
        value: parsedResult.value,
        logs: finalizeRunLogs()
      };
    } catch (cause: unknown) {
      return {
        status: "failed",
        error: createRunErrorRecord(cause),
        logs: finalizeRunLogs()
      };
    }
  }
}

/** Imported by the executor prefix after this checked module is emitted. */
declare function __runUser__(...hostNamespaces: object[]): Promise<unknown>;
