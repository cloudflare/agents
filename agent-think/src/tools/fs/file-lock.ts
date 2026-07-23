/**
 * Per-path mutation queue shared by every tool that mutates files. Edit and
 * write must never race on the same file: edit's fuzzy matching reads the
 * entire buffer, applies a textual change, then writes — a concurrent write
 * landing between that read and write would be silently clobbered (and
 * write's stat-then-write mode preservation has the same window).
 * Module-scoped so all tools sharing a store also share the queue.
 */
const fileLocks = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = fileLocks.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(
    path,
    next.finally(() => {
      // Clear only if we're still the tail of the chain.
      if (fileLocks.get(path) === next) fileLocks.delete(path);
    })
  );
  return next;
}
