/**
 * The registry behind `Lifecycle.retryable()`.
 *
 * The runtime only treats a Durable Object RPC call as retryable if the
 * exact function it calls was passed to `retryable()`. A host that replaces
 * methods with wrappers, as Agent does, registers each wrapper here so it is
 * marked too. Opt-ins are recorded per class so a class's wrappers are
 * marked only for methods that the class or one of its ancestors
 * registered, never a sibling.
 */
import { retryable } from "cloudflare:durable-objects";
import { copyCallableMetadata } from "../callable-decorator";

type Method = (...args: never[]) => unknown;

const retryableByClass = new WeakMap<Function, WeakSet<Function>>();

/** Wrappers registered by {@link registerMethodWrapper}, mapped to the method each wraps. */
const methodWrappers = new WeakMap<Function, Function>();

/**
 * Register methods as retryable for `cls` and its subclasses. Only methods
 * `cls` defines itself get the runtime mark directly. Inherited methods get
 * forwarding methods on `cls.prototype` so siblings keep the shared function
 * unmarked, including hosts that do not wrap methods themselves.
 *
 * Throws, without registering anything, unless every function is the
 * nearest method of its name on `cls.prototype`'s chain.
 */
export function markRetryable(cls: Function, methods: Method[]): void {
  const requested = new Set<unknown>(methods);
  const unresolved = new Set(requested);
  const own: Method[] = [];
  const inherited: [PropertyKey, PropertyDescriptor][] = [];
  // Own methods are marked directly, so the walk can stop once all are
  // found. An inherited method may have other names further up, and each
  // needs its own forwarder, so then the walk runs to the top.
  const seen = new Set<PropertyKey>();
  for (
    let proto = cls.prototype;
    (unresolved.size > 0 || inherited.length > 0) &&
    proto &&
    proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const name of Reflect.ownKeys(proto)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(proto, name)!;
      if (!requested.has(descriptor.value)) continue;
      unresolved.delete(descriptor.value);
      if (proto === cls.prototype) own.push(descriptor.value);
      else inherited.push([name, descriptor]);
    }
  }
  if (unresolved.size > 0) {
    throw new TypeError(
      `retryable() accepts only methods of ${cls.name || "the host class"}.`
    );
  }

  retryable(...own);
  const registered = retryableByClass.get(cls) ?? new WeakSet();
  // A method read from a prototype can already be a host's wrapper;
  // register the method it wraps.
  for (const method of methods) {
    registered.add(methodWrappers.get(method) ?? method);
  }
  retryableByClass.set(cls, registered);

  for (const [name, descriptor] of inherited) {
    const method = descriptor.value as Method;
    const wrapper = function (this: unknown, ...args: never[]) {
      return method.apply(this, args);
    };
    copyCallableMetadata(method, wrapper);
    registerMethodWrapper(cls, methodWrappers.get(method) ?? method, wrapper);
    Object.defineProperty(cls.prototype, name, {
      ...descriptor,
      value: wrapper
    });
  }
}

/** @internal Whether `cls` or an ancestor registered `method`. */
export function isRetryableFor(cls: Function, method: Function): boolean {
  for (let c: Function | null = cls; c; c = Object.getPrototypeOf(c)) {
    if (retryableByClass.get(c)?.has(method)) return true;
  }
  return false;
}

/** @internal The method `fn` wraps, if it was registered as a wrapper. */
export function unwrapMethod(fn: Function): Function | undefined {
  return methodWrappers.get(fn);
}

/**
 * @internal Record `wrapper` as the function RPC calls for `method` on
 * `cls`, and mark it retryable if `cls` or an ancestor registered `method`.
 */
export function registerMethodWrapper(
  cls: Function,
  method: Function,
  wrapper: Method
): void {
  methodWrappers.set(wrapper, method);
  if (isRetryableFor(cls, method)) retryable(wrapper);
}
