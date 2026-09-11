import { RpcTarget } from "cloudflare:workers";

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
