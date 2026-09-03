import type {
  AgentCaller,
  AgentCallerIdentity,
  RpcCallContext
} from "./lifecycle/current-agent";
import { getCurrentAgent } from "./lifecycle/current-agent";
import { tracer } from "./observability/tracing/cloudflare";
import { isInternalJsStubProp } from "./utils";

/**
 * Contextual RPC over a native Durable Object stub.
 *
 * The Workers runtime already inherits native span context across
 * same-account bindings, so a callee's spans nest under the caller's trace
 * without help. What native RPC cannot carry is the Agents SDK's own
 * invocation context: which Agent made the call and any caller-supplied
 * hints. This module wraps a stub so every method call travels through one
 * library entry point on the callee (`_cf_invoke`, installed on every
 * Lifecycle Object's class by `Lifecycle.install`, see `lifecycle/rpc-entry.ts`)
 * that re-enters the SDK invocation context with that caller attached, making
 * it readable via `getCurrentAgent().caller`.
 *
 * Caller context is untrusted metadata: correlation ids, tracing hints,
 * tenancy hints. It is never proof of identity or authorization.
 */

/** Property a wrapped stub answers with its native stub. */
const NATIVE_STUB = Symbol.for("cloudflare.agents.nativeStub");

/**
 * The raw Durable Object stub behind a contextual stub.
 *
 * A contextual stub is a Proxy, not a runtime `Fetcher`, so it cannot be
 * passed as an RPC argument or to runtime APIs that demand a real stub. Unwrap
 * it for those cases; calls on the returned stub carry no caller context.
 *
 * @template T - The Agent class the stub targets.
 * @param stub - A stub from `getAgentByName`, contextual or native.
 * @returns The native stub, or `stub` itself when it was never wrapped.
 */
export function nativeAgentStub<T extends Rpc.DurableObjectBranded | undefined>(
  stub: DurableObjectStub<T>
): DurableObjectStub<T> {
  // SAFETY: symbol lookup on the stub; a contextual stub answers with its
  // native target and a native stub answers undefined.
  const unwrapped = (stub as unknown as Record<symbol, unknown>)[NATIVE_STUB];
  return unwrapped === undefined ? stub : (unwrapped as DurableObjectStub<T>);
}

/** Members the wrapper forwards to the native stub untouched. */
const NATIVE_STUB_MEMBERS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "fetch",
  "connect",
  "__unsafe_ensureInitialized"
]);

/** The callee-side entry point a wrapped stub dispatches through. */
type ContextualRpcCallee = {
  _cf_invoke(
    method: string,
    args: ReadonlyArray<unknown>,
    caller: AgentCaller
  ): Promise<unknown>;
};

/** A Lifecycle host that can describe itself to the Agents it calls. */
type CallerIdentitySource = {
  _cf_rpcIdentity(): AgentCallerIdentity;
};

function isCallerIdentitySource(value: unknown): value is CallerIdentitySource {
  return (
    typeof value === "object" &&
    value !== null &&
    "_cf_rpcIdentity" in value &&
    typeof value._cf_rpcIdentity === "function"
  );
}

/**
 * Describe the current invocation as the caller of an outbound RPC.
 *
 * Inside an Agent this is the Agent's identity; from a Worker handler or any
 * other code with no SDK invocation context it is `external`.
 *
 * @param context - Caller-supplied hints forwarded to the callee.
 * @returns The caller record the callee will observe.
 */
export function currentCaller(context: RpcCallContext): AgentCaller {
  const { agent } = getCurrentAgent();
  if (!isCallerIdentitySource(agent)) {
    return { kind: "external", context };
  }
  return { kind: "agent", ...agent._cf_rpcIdentity(), context };
}

/** How a wrapped stub identifies its target in spans. */
export type WrapAgentStubOptions = {
  /** Instance name the stub was resolved for. */
  readonly targetName: string;
  /** The caller record every call carries. */
  readonly caller: AgentCaller;
};

/**
 * Wrap a native Agent stub so method calls carry the caller's invocation
 * context to the callee and open a client span per call.
 *
 * The wrapper preserves the stub's public shape and type: `id`, `name`,
 * `fetch`, `connect`, disposal, and the SDK's own `_cf_`/`__unsafe_` entry
 * points go straight to the native stub. Every other string member is treated
 * as a method call; reading a remote property (a native-stub quirk) is not
 * forwarded.
 *
 * @template T - The Agent class the stub targets.
 * @param stub - The native stub returned by the namespace.
 * @param options - Target identity and caller record.
 * @returns A stub with the same type whose calls are contextual.
 */
export function wrapAgentStub<T extends Rpc.DurableObjectBranded | undefined>(
  stub: DurableObjectStub<T>,
  options: WrapAgentStubOptions
): DurableObjectStub<T> {
  // SAFETY: `_cf_invoke` is declared on Agent and reachable over native RPC on
  // every stub `getAgentByName` returns; the type-level stub omits it because
  // it is @internal.
  const callee = stub as unknown as ContextualRpcCallee;

  return new Proxy(stub, {
    get(native, prop) {
      if (prop === NATIVE_STUB) return native;
      // JS-internal probes (`constructor`, `then`, `toJSON`, …) must see the
      // native value untouched so brand checks and thenable checks behave
      // exactly as they do on the raw stub.
      if (typeof prop === "string" && isInternalJsStubProp(prop)) {
        return Reflect.get(native, prop, native);
      }
      if (
        typeof prop !== "string" ||
        NATIVE_STUB_MEMBERS.has(prop) ||
        prop.startsWith("_cf_")
      ) {
        // A native stub's members are RPC proxies themselves, so `bind` or
        // `apply` on one would go over the wire as a method named "bind".
        // Invoke through a member call expression instead.
        const value = Reflect.get(native, prop, native);
        if (typeof value !== "function") return value;
        // SAFETY: the stub's own member, called on the stub with the caller's
        // arguments; the wrapper adds no typing of its own.
        const members = native as unknown as Record<
          string | symbol,
          (...args: ReadonlyArray<unknown>) => unknown
        >;
        return (...args: ReadonlyArray<unknown>) => members[prop](...args);
      }
      return async (...args: ReadonlyArray<unknown>) =>
        tracer.withSpan(
          "agents.rpc.call",
          {
            "cloudflare.agents.rpc.method": prop,
            "cloudflare.agents.rpc.target.name": options.targetName,
            "cloudflare.agents.rpc.caller.kind": options.caller.kind
          },
          () => callee._cf_invoke(prop, args, options.caller)
        );
    }
  });
}
