import {
  awaitWithContext,
  type Context as UpstreamContext
} from "@earendil-works/pi-agent-core";

/**
 * Wakes callers waiting for an operation to settle.
 *
 * `waitForResult` parks on a promise per operation; the harness resolves them
 * when pi reports a terminal record. A poll interval backs the direct wake up
 * so a caller cannot hang if a settlement notification is ever missed.
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

  /** Resolve once this operation settles, the poll fires, or the context ends. */
  wait(operationId: string, context: UpstreamContext): Promise<void> {
    return awaitWithContext(
      new Promise<void>((resolve) => {
        let waiters = this.#waiters.get(operationId);
        if (!waiters) {
          waiters = new Set();
          this.#waiters.set(operationId, waiters);
        }
        const wake = () => {
          clearTimeout(timer);
          waiters?.delete(wake);
          resolve();
        };
        // The poll is insurance: settlement normally wakes waiters directly.
        const timer = setTimeout(wake, this.#pollMs);
        waiters.add(wake);
      }),
      context
    );
  }
}
