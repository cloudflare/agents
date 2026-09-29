import type { SessionChangeEvent, SessionMessage } from "./types";

/**
 * How a host keeps an in-memory transcript in step with one session's change
 * feed. The mirror applies the reduction every such cache needs; the hooks
 * carry the decisions only the host can make.
 */
export interface SessionMirrorOptions<M extends { id: string }> {
  /**
   * The cached transcript. Read on every event, so a host that reassigns its
   * array (a public `messages` field, say) is followed rather than
   * shadowed.
   */
  get(): M[];
  /** Install a new array: after a delete, or emptied by a clear. */
  set(messages: M[]): void;
  /** The cached form of a stored message. Defaults to the stored message. */
  transform?(message: SessionMessage): M;
  /**
   * Handle an event instead of the default reduction, returning `true` when
   * it did. A host whose cache cannot express a change in place — a branch
   * append, a compaction — re-reads storage here.
   */
  intercept?(event: SessionChangeEvent): boolean | Promise<boolean>;
  /**
   * After the default reduction wrote `message` for an append or update.
   * `previous` is the cached entry it replaced, if there was one.
   */
  onApplied?(
    event: Extract<SessionChangeEvent, { type: "append" | "update" }>,
    message: M,
    previous: M | undefined
  ): void;
}

/**
 * The default reduction, per event:
 *
 * - `append` of a new row: replace the cached entry with its id, or push it.
 *   A duplicate append (`inserted: false`) changed nothing.
 * - `update`: replace the cached entry with its id; a row the cache does not
 *   hold stays out.
 * - `delete`: drop the removed ids. `clear`: empty the cache.
 * - `import`, `compact`, `compaction`: nothing, since no in-place patch
 *   expresses them. A host that must react intercepts them.
 */
export function mirrorSessionChanges<M extends { id: string }>(
  subscribe: (
    listener: (event: SessionChangeEvent) => Promise<void>
  ) => () => void,
  sessionId: string,
  options: SessionMirrorOptions<M>
): () => void {
  const transform =
    options.transform ?? ((message: SessionMessage) => message as unknown as M);
  return subscribe(async (event) => {
    if (event.sessionId !== sessionId) return;
    if (await options.intercept?.(event)) return;
    switch (event.type) {
      case "append":
      case "update": {
        if (event.type === "append" && !event.inserted) return;
        const cache = options.get();
        const index = cache.findIndex((m) => m.id === event.message.id);
        if (index === -1 && event.type === "update") return;
        const message = transform(event.message);
        const previous = index === -1 ? undefined : cache[index];
        if (index === -1) cache.push(message);
        else cache[index] = message;
        options.onApplied?.(event, message, previous);
        return;
      }
      case "delete": {
        const removed = new Set(event.messageIds);
        options.set(options.get().filter((m) => !removed.has(m.id)));
        return;
      }
      case "clear":
        options.set([]);
        return;
      default:
        return;
    }
  });
}
