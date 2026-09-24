export class SettlementWaiters {
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #pollMs: number;

  constructor(pollMs: number) {
    this.#pollMs = pollMs;
  }

  notify(operationId: string): void {
    const waiters = this.#waiters.get(operationId);
    this.#waiters.delete(operationId);
    if (waiters) for (const wake of waiters) wake();
  }

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
      const timer = setTimeout(wake, this.#pollMs);
      signal?.addEventListener("abort", wake, { once: true });
      waiters.add(wake);
    });
  }
}
