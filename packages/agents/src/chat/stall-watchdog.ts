/**
 * Shared inactivity watchdog for UI-message streams.
 *
 * A model/transport stream can park indefinitely without ever throwing (a hung
 * provider, a wedged transport). Left unguarded, the consumer read-loop waits
 * forever. {@link iterateWithStallWatchdog} wraps such a stream so that a gap of
 * `timeoutMs` between chunks aborts the upstream and throws
 * {@link ChatStreamStalledError}, letting the consumer route the stall into
 * bounded recovery (#1626) — a transient hang is retried within the existing
 * recovery budget — while genuine in-band errors stay terminal.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API. See
 * `design/rfc-chat-recovery-foundation.md`.
 */

/**
 * Thrown by {@link iterateWithStallWatchdog} when the inactivity watchdog fires
 * (a model/transport stream that parks without ever throwing). Distinct from
 * in-band model/stream errors so the read-loop catch can route a stall into
 * bounded recovery (#1626) — a transient hang is retried within the existing
 * recovery budget — while genuine errors stay terminal.
 */
export class ChatStreamStalledError extends Error {
  readonly isChatStreamStall = true;
  constructor(message: string) {
    super(message);
    this.name = "ChatStreamStalledError";
  }
}

/**
 * Wrap a UI-message stream with an inactivity watchdog. If no chunk arrives
 * within `timeoutMs`, `onStall` runs (aborting the upstream model stream) and
 * the iterator throws, so the consumer loop exits with a terminal error
 * instead of parking forever on a hung provider/transport. `timeoutMs <= 0`
 * passes the source through untouched.
 */
export async function* iterateWithStallWatchdog<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  onStall: () => void
): AsyncGenerator<T> {
  if (!(timeoutMs > 0)) {
    yield* source;
    return;
  }
  const iterator = source[Symbol.asyncIterator]();
  // Tracks whether the watchdog itself aborted the upstream. In that case we
  // must NOT also `iterator.return()` it: cancelling the readable after the
  // abort makes the AI SDK pipeline write to an already-cancelled readable
  // ("readable side is no longer readable"). Letting the abort error the
  // stream is the clean path.
  let selfAborted = false;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stalled = false;
      const stall = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stalled = true;
          reject(
            new ChatStreamStalledError(
              `Chat stream stalled: no activity for ${timeoutMs}ms; the turn was aborted by the stall watchdog.`
            )
          );
        }, timeoutMs);
      });
      const nextPromise = iterator.next();
      // If the watchdog wins the race we abandon this read; aborting the
      // upstream stream makes it reject later, so pre-attach a no-op catch to
      // keep that abandoned rejection from surfacing as an unhandled rejection.
      nextPromise.catch(() => {});
      let next: IteratorResult<T>;
      try {
        next = await Promise.race([nextPromise, stall]);
      } catch (err) {
        if (stalled) {
          selfAborted = true;
          onStall();
        }
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Forward early termination (consumer `break`/`throw`, e.g. an in-band
    // stream error where the abort signal is NOT set) to the source so its
    // reader is cancelled — otherwise the wrapped source would leak when the
    // consumer stops reading mid-stream. Skipped after a watchdog stall, which
    // already aborted the upstream (see `selfAborted` above).
    if (!selfAborted) {
      await iterator.return?.(undefined as never).catch(() => {});
    }
  }
}
