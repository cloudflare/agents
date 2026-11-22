/**
 * A Durable Object stub that replaces itself after a call through it fails.
 *
 * Once a Durable Object is reset (`ctx.abort()`, a crash, the memory-limit
 * breaker, a code update), every later call through a stub obtained before
 * the reset rejects with the same error, while a new stub from the namespace
 * works at once (measured, see design/retries.md). Code that
 * keeps one stub for a long time, such as a workflow run, must open a new
 * one after a failure or it stays broken for the rest of its life.
 *
 * The failed call still rejects and is not retried here: the caller's own
 * retry (a workflow step's retries, say) runs on the new stub. An error the
 * callee threw itself does not break a stub, but telling the two apart is
 * not reliable, so any rejection renews it; a new stub to the same object
 * costs nothing.
 *
 * @internal
 */
export function renewingStub<T extends object>(first: T, open: () => T): T {
  let current = first;
  const renew = (failed: T) => {
    if (current === failed) current = open();
  };
  // SAFETY: every property read is forwarded to the current stub, so the
  // empty target is never read.
  return new Proxy({} as T, {
    get(_target, prop) {
      const stub = current;
      const value: unknown = Reflect.get(stub, prop);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        let result: unknown;
        try {
          // Reflect.apply, not `value.apply`: on an RPC stub every property,
          // `apply` included, is a remote method.
          result = Reflect.apply(
            value as (...a: unknown[]) => unknown,
            stub,
            args
          );
        } catch (error) {
          renew(stub);
          throw error;
        }
        if (isThenable(result)) {
          // Observe without replacing the caller's promise, so RPC
          // pipelining on the result keeps working. `JsRpcPromise.then`
          // requires both callbacks to be functions.
          result.then(
            () => {},
            () => renew(stub)
          );
        }
        return result;
      };
    }
  });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
