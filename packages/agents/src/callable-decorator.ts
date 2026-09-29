/**
 * The `@callable()` method decorator and its metadata registry.
 *
 * Consumed by Agent's legacy JSON RPC protocol and, as a fallback
 * interface source, by the WebSockets capability's Cap'n Web callables
 * endpoint. Kept dependency-free so both can import it without cycles.
 */

/**
 * Metadata for a callable method
 */
export type CallableMetadata = {
  /** Optional description of what the method does */
  description?: string;
  /** Whether the method supports streaming responses */
  streaming?: boolean;
};

const callableMetadata = new WeakMap<Function, CallableMetadata>();

/**
 * Decorator that marks a method as callable by clients
 * @param metadata Optional metadata about the callable method
 */
export function callable(metadata: CallableMetadata = {}) {
  return function callableDecorator<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    _context: ClassMethodDecoratorContext
  ) {
    if (!callableMetadata.has(target)) {
      callableMetadata.set(target, metadata);
    }

    return target;
  };
}

let didWarnAboutUnstableCallable = false;

/**
 * Decorator that marks a method as callable by clients
 * @deprecated this has been renamed to callable, and unstable_callable will be removed in the next major version
 * @param metadata Optional metadata about the callable method
 */
export const unstable_callable = (metadata: CallableMetadata = {}) => {
  if (!didWarnAboutUnstableCallable) {
    didWarnAboutUnstableCallable = true;
    console.warn(
      "unstable_callable is deprecated, use callable instead. unstable_callable will be removed in the next major version."
    );
  }
  return callable(metadata);
};

/** @internal Read the metadata registered for a decorated method. */
export function getCallableMetadata(
  method: Function
): CallableMetadata | undefined {
  return callableMetadata.get(method);
}

/** @internal Whether a method was registered with `@callable()`. */
export function isCallableMethod(method: Function): boolean {
  return callableMetadata.has(method);
}

/**
 * @internal Preserve registration when a framework wraps a decorated
 * method (e.g. Agent's context auto-wrapping).
 */
export function copyCallableMetadata(source: Function, target: Function): void {
  const metadata = callableMetadata.get(source);
  if (metadata) callableMetadata.set(target, metadata);
}

/**
 * Every `@callable()`-registered method reachable on a host's prototype
 * chain, with its metadata. The nearest declaration wins when a
 * subclass overrides a decorated parent method.
 *
 * The canonical decorator scan — Agent introspection and the WebSockets
 * capability's decorator-fallback target both consume it.
 *
 * @param host - The object whose prototype chain is scanned.
 * @returns Method names mapped to their registered metadata.
 */
export function decoratedMethods(
  host: object
): ReadonlyMap<string, CallableMetadata> {
  const result = new Map<string, CallableMetadata>();
  let prototype: object | null = Object.getPrototypeOf(host);
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor" || result.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      const metadata = getCallableMetadata(descriptor.value);
      if (metadata) result.set(name, metadata);
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return result;
}
