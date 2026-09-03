import { RpcTarget } from "cloudflare:workers";
import { decoratedMethods } from "../callable-decorator";

/** A named remote method ready to be exposed on a callables root. */
export type CallableInvoker = (...args: unknown[]) => unknown;

/**
 * The single exposure policy for callable names. `Object.prototype` and
 * `RpcTarget.prototype` members are unreachable over Cap'n Web anyway
 * and are silently excluded; `then` is rejected loudly because exposing
 * it would make the remote stub thenable.
 */
function assertExposable(name: string): boolean {
  if (name === "then") {
    throw new Error(
      'A callables target cannot expose a method named "then" — it would make the remote stub thenable'
    );
  }
  return !(
    name === "constructor" ||
    name in Object.prototype ||
    name in RpcTarget.prototype
  );
}

/**
 * The exposable prototype methods of a callables target, each bound to
 * invoke on the real instance (so private fields and `this` behave).
 *
 * Cap'n Web resolves methods on the prototype chain and rejects own
 * instance properties, so only prototype methods participate. The
 * nearest declaration wins for overridden names.
 *
 * @param target - The callables target to enumerate.
 * @returns Method names mapped to invokers on the target.
 */
export function exposableMethods(
  target: RpcTarget
): ReadonlyMap<string, CallableInvoker> {
  const methods = new Map<string, CallableInvoker>();
  const seen = new Set<string>();
  let prototype: object | null = Object.getPrototypeOf(target);
  while (
    prototype &&
    prototype !== RpcTarget.prototype &&
    prototype !== Object.prototype
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!assertExposable(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      // SAFETY: `typeof descriptor.value === "function"` was checked
      // above; TypeScript cannot narrow a descriptor's `value` field.
      const method = descriptor.value as CallableInvoker;
      methods.set(name, (...args) => Reflect.apply(method, target, args));
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return methods;
}

/**
 * Build a Cap'n Web session root exposing exactly the given methods.
 *
 * Cap'n Web resolves methods on the prototype chain, rejects own
 * instance properties, and breaks on Proxy-wrapped roots — so the root
 * is a private `RpcTarget` subclass whose prototype carries the
 * methods and nothing else.
 *
 * @param methods - Method names mapped to their invokers.
 * @returns A root suitable as a Cap'n Web session's local main.
 */
export function buildCallablesRoot(
  methods: ReadonlyMap<string, CallableInvoker>
): RpcTarget {
  class CallablesRoot extends RpcTarget {}
  for (const [name, invoke] of methods) {
    Object.defineProperty(CallablesRoot.prototype, name, {
      value: invoke,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  return new CallablesRoot();
}

/**
 * Build a callables target from a host's `@callable()`-decorated
 * methods — the fallback interface source when no `RpcTarget` is
 * configured (an explicit target is preferred and wins).
 *
 * Methods are resolved on the host at call time, so framework wrapping
 * applied after construction (e.g. Agent's context auto-wrapping) is
 * honored. Methods registered with `streaming: true` expect the legacy
 * Agent RPC protocol's injected `StreamingResponse` and are not exposed
 * here — return a `ReadableStream` from an `RpcTarget` method instead.
 *
 * @param host - The object whose decorated methods form the interface.
 * @returns A target exposing the decorated methods, or `undefined`
 * when the host has none.
 */
export function callablesFromDecorated(host: object): RpcTarget | undefined {
  const methods = new Map<string, CallableInvoker>();
  for (const [name, metadata] of decoratedMethods(host)) {
    if (metadata.streaming || !assertExposable(name)) continue;
    methods.set(name, (...args) => {
      const method = Reflect.get(host, name) as unknown;
      if (typeof method !== "function") {
        throw new Error(`Method ${name} is not callable`);
      }
      return Reflect.apply(method, host, args);
    });
  }
  if (methods.size === 0) return undefined;
  return buildCallablesRoot(methods);
}
