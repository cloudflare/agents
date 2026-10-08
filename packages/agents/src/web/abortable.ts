/**
 * Shared by the `web_search` and `web_fetch` tools. Internal — not an entry
 * point.
 */

/** Settle with `promise`, or reject with the signal's reason once it aborts. */
export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
