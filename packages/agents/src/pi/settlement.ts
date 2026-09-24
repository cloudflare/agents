import {
  awaitWithContext,
  type Context as UpstreamContext
} from "@earendil-works/pi-agent-core";

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
        const timer = setTimeout(wake, this.#pollMs);
        waiters.add(wake);
      }),
      context
    );
  }
}
