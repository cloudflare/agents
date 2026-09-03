import type { DurableObject } from "cloudflare:workers";
import { withInvocationScope } from "../observability/tracing/tracer";
import { isInternalJsStubProp } from "../utils";
import {
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  type AgentCaller,
  type AgentCallerIdentity
} from "./current-agent";

/**
 * Contextual RPC entry points for Lifecycle Objects.
 *
 * A contextual stub (see `agent-stub.ts`) routes every method call through
 * `_cf_invoke` on the callee, which re-enters the SDK invocation context with
 * the caller attached. Workers RPC dispatches only prototype members of a
 * class instance and refuses own properties (`tryGetProperty` in workerd's
 * `worker-rpc.c++`), so these entry points cannot be installed on the
 * instance the way Lifecycle installs `fetch` and `alarm`. They are defined
 * once on the host's class prototype instead, at `Lifecycle.install` time, and
 * a class that already declares one of them (Agent overrides
 * `_cf_rpcIdentity` with facet-aware naming) keeps its own.
 */

/** Marks a class prototype that already carries the entry points. */
const INSTALLED = Symbol.for("cloudflare.agents.rpcEntry");

/** The members a contextual stub reaches on its callee. */
export type ContextualRpcHost = {
  _cf_invoke(
    method: string,
    args: ReadonlyArray<unknown>,
    caller: AgentCaller
  ): Promise<unknown>;
  _cf_rpcIdentity(): AgentCallerIdentity;
};

/** A method resolved on an RPC host, ready to apply. */
type RpcMethod = (this: unknown, ...args: ReadonlyArray<unknown>) => unknown;

/** Why a method name could not be dispatched on an RPC host. */
export class RpcMethodNotCallable extends Error {
  readonly _tag = "RpcMethodNotCallable" as const;

  constructor(
    readonly method: string,
    readonly hostClassName: string
  ) {
    super(`"${method}" is not callable on ${hostClassName} over RPC.`);
  }
}

/**
 * Resolve a method name on an RPC host with native-stub semantics: JS-internal
 * probes, `Object.prototype` members, and non-functions are refused so a
 * caller reaches nothing a native stub would deny.
 *
 * @param host - The object receiving the call.
 * @param method - The requested method name.
 * @returns The function to apply, or `RpcMethodNotCallable`.
 */
export function resolveRpcMethod(
  host: object,
  method: string
):
  | { readonly kind: "ok"; readonly value: RpcMethod }
  | { readonly kind: "err"; readonly error: RpcMethodNotCallable } {
  // SAFETY: property lookup by name on an arbitrary host; the value is checked
  // to be a function before it is treated as one.
  const value = (host as Record<string, unknown>)[method];
  if (
    isInternalJsStubProp(method) ||
    method in Object.prototype ||
    typeof value !== "function"
  ) {
    return {
      kind: "err",
      error: new RpcMethodNotCallable(method, host.constructor.name)
    };
  }
  // SAFETY: checked above to be a function; parameters are the RPC args.
  return { kind: "ok", value: value as RpcMethod };
}

/** Durable Object surface the generic entry points rely on. */
type EntryHost = DurableObject<object> & {
  readonly ctx: DurableObjectState;
  readonly lifecycle: { start(props?: Record<string, unknown>): Promise<void> };
};

/**
 * Run `method` on `host` inside a fresh invocation whose context records
 * `caller`, so `getCurrentAgent().caller` is readable throughout the call. No
 * native I/O handles cross the hop, and lifecycle startup is not forced:
 * the resolver already started the object, and a re-created instance sees the
 * same startup timing it would over a raw stub.
 *
 * @param host - The object receiving the call.
 * @param method - The requested method name.
 * @param args - The call's arguments.
 * @param caller - The caller record the callee will observe.
 * @returns The method's result, or a rejection for an unreachable member.
 */
export function invokeWithCaller(
  host: object,
  method: string,
  args: ReadonlyArray<unknown>,
  caller: AgentCaller
): Promise<unknown> {
  const resolved = resolveRpcMethod(host, method);
  if (resolved.kind === "err") {
    // Native RPC has no error channel besides rejection; the tagged error
    // becomes the rejection so the caller sees the same message a native
    // stub would produce for an unreachable member.
    return Promise.reject(resolved.error);
  }
  return agentContext.run(
    {
      agent: host,
      connection: undefined,
      request: undefined,
      email: undefined,
      caller
    },
    () =>
      withInvocationScope(() =>
        Promise.resolve(resolved.value.apply(host, [...args]))
      )
  );
}

/**
 * Dispatch one contextual call to `target`: directly when it is a local
 * object, through `_cf_invoke` when it is an RPC stub. Facet paths use this
 * at every hop so the original caller reaches the final object unchanged.
 *
 * @param target - A local Lifecycle Object or a stub to one.
 * @param method - The requested method name.
 * @param args - The call's arguments.
 * @param caller - The caller record the callee will observe.
 * @param local - Whether `target` is the object itself rather than a stub.
 * @returns The method's result.
 */
export function dispatchWithCaller(
  target: unknown,
  method: string,
  args: ReadonlyArray<unknown>,
  caller: AgentCaller,
  local: "local" | "stub"
): Promise<unknown> {
  if (local === "local") {
    return invokeWithCaller(target as object, method, args, caller);
  }
  // SAFETY: every Lifecycle Object's class carries `_cf_invoke` after
  // `Lifecycle.install`; a stub to one reaches it over native RPC.
  return (target as ContextualRpcHost)._cf_invoke(method, args, caller);
}

/** Identity of a plain Lifecycle Object: class name and Durable Object id. */
function lifecycleObjectIdentity(host: EntryHost): AgentCallerIdentity {
  return {
    className: host.constructor.name,
    sessionId: host.ctx.id.toString(),
    sessionName: host.ctx.id.name
  };
}

/**
 * Define the contextual RPC entry points on `host`'s class prototype, once
 * per class. Members the class already declares anywhere on its chain are
 * left alone.
 *
 * @param host - A Durable Object whose class should accept contextual calls.
 */
export function installContextualRpcEntry(host: DurableObject<object>): void {
  const proto: unknown = Object.getPrototypeOf(host);
  if (typeof proto !== "object" || proto === null) return;
  // SAFETY: a class prototype is a plain object keyed by member name; the
  // marker and the two entry points are the only keys touched.
  const target = proto as Record<string | symbol, unknown>;
  if (target[INSTALLED] === true) return;
  Object.defineProperty(target, INSTALLED, { value: true });

  const entries: ContextualRpcHost & {
    __unsafe_ensureInitialized(props?: Record<string, unknown>): Promise<void>;
  } = {
    _cf_invoke(this: object, method, args, caller) {
      return invokeWithCaller(this, method, args, caller);
    },
    _cf_rpcIdentity(this: EntryHost) {
      return lifecycleObjectIdentity(this);
    },
    // Lets the same resolver (`getAgentByName`) start a plain Lifecycle
    // Object before handing out its stub, as it does for Agents.
    __unsafe_ensureInitialized(this: EntryHost, props) {
      return this.lifecycle.start(props);
    }
  };
  for (const [name, fn] of Object.entries(entries)) {
    if (name in target) continue;
    Object.defineProperty(target, name, {
      value: fn,
      configurable: true,
      writable: true
    });
  }
}
