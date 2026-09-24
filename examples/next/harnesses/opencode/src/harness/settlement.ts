/**
 * Wakes callers waiting for a turn to settle.
 *
 * `wait` parks on a promise per operation; the harness resolves them when
 * OpenCode reports a terminal record. A poll interval backs the direct wake
 * up so a caller cannot hang if a settlement notification is ever missed.
 *
 * Unlike the pi version this takes no upstream context: OpenCode's promise
 * SDK uses plain `AbortSignal`, so cancellation is passed in by the caller.
 */
export class SettlementWaiters {
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #pollMs: number;

  constructor(pollMs: number) {
    this.#pollMs = pollMs;
  }

  /** Wake everyone waiting on this operation and forget it. */
  notify(operationId: string): void {
    const waiters = this.#waiters.get(operationId);
    this.#waiters.delete(operationId);
    if (waiters) for (const wake of waiters) wake();
  }

  /** Resolve once this operation settles or the poll fires. */
  wait(operationId: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let waiters = this.#waiters.get(operationId);
      if (!waiters) {
        waiters = new Set();
        this.#waiters.set(operationId, waiters);
      }
      const wake = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", wake);
        waiters?.delete(wake);
        resolve();
      };
      // The poll is insurance: settlement normally wakes waiters directly.
      const timer = setTimeout(wake, this.#pollMs);
      signal?.addEventListener("abort", wake, { once: true });
      waiters.add(wake);
    });
  }
}
