/**
 * A Durable Object stub that replaces itself after a call through it fails.
 *
 * Once a Durable Object is reset (`ctx.abort()`, a crash, the memory-limit
 * breaker, a code update), every later call through a stub obtained before
 * the reset rejects with the same error, while a new stub from the namespace
 * works at once (measured, see design/retries.md). Code that keeps one stub
 * for a long time, such as a workflow run, must open a new one after a
 * failure or it stays broken for the rest of its life.
 *
 * The failed call still rejects and is not retried here: the caller's own
 * retry (a workflow step's retries, say) runs on the new stub. An error the
 * callee threw itself does not break a stub, but telling the two apart is
 * not reliable, so any rejection renews it; a new stub to the same object
 * costs nothing.
 *
 * Every property read is forwarded to the current stub's own RPC property,
 * so awaiting a remote getter and reading nested properties work as on the
 * stub; only calling and awaiting are observed. `prepare` runs on a renewed
 * stub when its first call comes (an Agent starts itself through it), so
 * that one call returns a plain promise instead of an RPC promise, and
 * cannot be pipelined. A `prepare` that fails rejects that call and renews
 * the stub again; nothing retries on its own.
 *
 * @internal
 */
export function renewingStub<T extends object>(
  first: T,
  open: () => T,
  prepare?: (stub: T) => Promise<unknown>
): T {
  let current = first;
  /** The current stub still needs `prepare` before its first call. */
  let unprepared = false;
  let preparing: Promise<unknown> | undefined;
  const renew = (failed: T) => {
    if (current !== failed) return;
    current = open();
    unprepared = prepare !== undefined;
    preparing = undefined;
  };
  /**
   * Run `prepare` once for the current stub, shared by the calls that need
   * it. Runs only when a call comes, so a startup that keeps failing costs
   * one attempt per call, never a loop.
   */
  const ready = (stub: T): Promise<unknown> | undefined => {
    if (!prepare || stub !== current || !unprepared) return undefined;
    if (!preparing) {
      const attempt = prepare(stub).then(
        () => {
          if (current === stub) unprepared = false;
        },
        (error: unknown) => {
          renew(stub);
          throw error;
        }
      );
      preparing = attempt;
    }
    return preparing;
  };
  const observe = (stub: T, result: unknown) => {
    if (isThenable(result)) {
      // Observe without replacing the caller's promise, so RPC pipelining
      // on the result keeps working. `JsRpcPromise.then` requires both
      // callbacks to be functions.
      result.then(
        () => {},
        () => renew(stub)
      );
    }
    return result;
  };

  // SAFETY: every property read is forwarded to the current stub, so the
  // empty target is never read.
  return new Proxy({} as T, {
    get(_target, prop) {
      const stub = current;
      const value: unknown = Reflect.get(stub, prop);
      if (typeof value !== "function") return value;
      const property = value as (...args: unknown[]) => unknown;
      return new Proxy(property, {
        apply(target, _this, args: unknown[]) {
          const call = () =>
            // Reflect.apply, not `target.apply`: on an RPC stub every
            // property, `apply` included, is a remote method.
            Reflect.apply(target, stub, args);
          const pending = ready(stub);
          if (pending) return observe(stub, pending.then(call));
          try {
            return observe(stub, call());
          } catch (error) {
            renew(stub);
            throw error;
          }
        },
        get(target, key) {
          const member: unknown = Reflect.get(target, key);
          if (key !== "then" || typeof member !== "function") return member;
          // Awaiting a remote property: prepare a renewed stub first, as
          // for a call, and observe the read's failure as well.
          return (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (error: unknown) => unknown
          ) => {
            const read = () =>
              Reflect.apply(member, target, [
                onFulfilled ?? ((result: unknown) => result),
                (error: unknown) => {
                  renew(stub);
                  if (onRejected) return onRejected(error);
                  throw error;
                }
              ]);
            const pending = ready(stub);
            return pending ? pending.then(read, onRejected) : read();
          };
        }
      });
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
