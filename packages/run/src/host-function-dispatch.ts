import { RpcTarget } from "cloudflare:workers";
import { parse } from "acorn";
import type {
  RunHostFunctionDispatcherContract,
  RunHostFunctionManifestEntry,
  RunHostFunctionResponse
} from "./dynamic-worker-protocol";
import { runWithHostFunctionContext } from "./host-function-context";
import { RunError } from "./run-error";
import { hasEnumerableInheritedProperty, parseRunData } from "./run-data";
import type { HostFunction, HostFunctions } from "./run-types";

const RUN_FORBIDDEN_HOST_NAMES = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "then"
]);

type RunHostFunctionLookup = ReadonlyMap<
  string,
  ReadonlyMap<string, HostFunction>
>;

type RunHostFunctionFailure = {
  readonly cause: unknown;
  readonly hostFunction: string;
};

type RunHostFunctionsInputPath =
  | "hostFunctions"
  | "hostFunctions.functionName"
  | "hostFunctions.namespace"
  | "hostFunctions.namespaceName";

function throwInvalidHostFunctions(path: RunHostFunctionsInputPath): never {
  throw new RunError("Host functions must use plain namespaced containers.", {
    code: "RUN_INVALID_INPUT",
    details: { path }
  });
}

function parseRunHostContainer(
  value: unknown,
  path: RunHostFunctionsInputPath
): ReadonlyArray<readonly [string, unknown]> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return throwInvalidHostFunctions(path);
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (
      (prototype !== null && prototype !== Object.prototype) ||
      hasEnumerableInheritedProperty(prototype)
    ) {
      return throwInvalidHostFunctions(path);
    }

    const entries: Array<readonly [string, unknown]> = [];
    for (const property of Reflect.ownKeys(value)) {
      if (typeof property !== "string") return throwInvalidHostFunctions(path);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        return throwInvalidHostFunctions(path);
      }
      entries.push([property, descriptor.value] as const);
    }
    return entries;
  } catch {
    return throwInvalidHostFunctions(path);
  }
}

function isRunHostIdentifier(name: string): boolean {
  if (RUN_FORBIDDEN_HOST_NAMES.has(name) || name.startsWith("__run")) {
    return false;
  }

  try {
    const program = parse(`async function __runHost__(${name}) {}`, {
      ecmaVersion: "latest",
      sourceType: "module"
    });
    const [statement] = program.body;
    const parameter =
      statement?.type === "FunctionDeclaration" ? statement.params[0] : null;
    return (
      program.body.length === 1 &&
      statement?.type === "FunctionDeclaration" &&
      statement.params.length === 1 &&
      parameter?.type === "Identifier" &&
      parameter.name === name
    );
  } catch {
    return false;
  }
}

/**
 * Parent RPC target for one invocation's validated host functions.
 *
 * This is the complete RPC surface exposed to the generated Worker; trusted
 * failure causes stay in a parent-owned store that never crosses RPC.
 */
export class RunHostFunctionDispatcher
  extends RpcTarget
  implements RunHostFunctionDispatcherContract
{
  readonly #hostFunctions: RunHostFunctionLookup;
  readonly #hostFunctionFailures: Map<number, RunHostFunctionFailure>;
  #nextCallId = 1;

  /** Construct a dispatcher over validated functions and a parent failure store. */
  constructor(
    hostFunctions: RunHostFunctionLookup,
    hostFunctionFailures: Map<number, RunHostFunctionFailure>
  ) {
    super();
    this.#hostFunctions = hostFunctions;
    this.#hostFunctionFailures = hostFunctionFailures;
  }

  /** Invoke one sequenced host call without exposing trusted failures over RPC. */
  async callHostFunction(
    callId: number,
    namespace: string,
    functionName: string,
    args: unknown[]
  ): Promise<RunHostFunctionResponse> {
    if (callId !== this.#nextCallId) {
      return { status: "protocolFailed" };
    }
    this.#nextCallId++;

    const hostFunction = this.#hostFunctions.get(namespace)?.get(functionName);
    if (hostFunction === undefined) {
      return { status: "protocolFailed" };
    }

    let value: unknown;
    try {
      const controller = new AbortController();
      value = await runWithHostFunctionContext(controller.signal, () =>
        Reflect.apply(hostFunction, undefined, args)
      );
    } catch (cause: unknown) {
      this.#hostFunctionFailures.set(callId, {
        cause,
        hostFunction: `${namespace}.${functionName}`
      });
      return { status: "failed", failureId: callId };
    }

    const parsed = parseRunData(value, "hostFunction.result");
    return parsed.status === "accepted"
      ? { status: "completed", value: parsed.value }
      : { status: "serializationFailed" };
  }
}

/** Parent-side handle that removes one escaped sanitized failure's cause. */
export type TakeRunHostFunctionFailure = (
  failureId: number
) =>
  | ({ readonly status: "found" } & RunHostFunctionFailure)
  | { readonly status: "missing" };

/** Parse and snapshot the exact host authority granted to one invocation. */
export function createRunHostFunctionDispatch(hostFunctions: HostFunctions): {
  readonly dispatcher: RunHostFunctionDispatcher;
  readonly manifest: readonly RunHostFunctionManifestEntry[];
  /** Remove and return the trusted cause for one escaped sanitized failure. */
  readonly takeHostFunctionFailure: TakeRunHostFunctionFailure;
} {
  const hostFunctionLookup = new Map<
    string,
    ReadonlyMap<string, HostFunction>
  >();
  const manifest: RunHostFunctionManifestEntry[] = [];

  for (const [namespace, namespaceValue] of parseRunHostContainer(
    hostFunctions,
    "hostFunctions"
  )) {
    if (!isRunHostIdentifier(namespace)) {
      return throwInvalidHostFunctions("hostFunctions.namespaceName");
    }

    const namespaceFunctions = new Map<string, HostFunction>();
    const functionNames: string[] = [];
    for (const [functionName, hostFunction] of parseRunHostContainer(
      namespaceValue,
      "hostFunctions.namespace"
    )) {
      if (!isRunHostIdentifier(functionName)) {
        return throwInvalidHostFunctions("hostFunctions.functionName");
      }
      if (typeof hostFunction !== "function") {
        return throwInvalidHostFunctions("hostFunctions");
      }
      // SAFETY: The runtime function check above proves this callable leaf.
      namespaceFunctions.set(functionName, hostFunction as HostFunction);
      functionNames.push(functionName);
    }

    hostFunctionLookup.set(namespace, namespaceFunctions);
    manifest.push({ namespace, functions: functionNames });
  }

  const hostFunctionFailures = new Map<number, RunHostFunctionFailure>();
  return {
    dispatcher: new RunHostFunctionDispatcher(
      hostFunctionLookup,
      hostFunctionFailures
    ),
    manifest,
    takeHostFunctionFailure: (failureId) => {
      const failure = hostFunctionFailures.get(failureId);
      if (failure === undefined) return { status: "missing" };
      hostFunctionFailures.delete(failureId);
      return { status: "found", ...failure };
    }
  };
}
