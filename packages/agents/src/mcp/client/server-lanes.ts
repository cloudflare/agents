import { AsyncLocalStorage } from "node:async_hooks";

const noop = () => {};
const NO_LANES: ReadonlySet<string> = new Set();

/** Call `fn`, turning a synchronous throw into a rejection. */
function invoke<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * One queue of connection work per MCP server. Work for the same server runs
 * one item at a time in submission order, so connect, discovery, OAuth
 * callback completion and restore never interleave on one connection; work
 * for different servers runs independently.
 *
 * Work is re-entrant: work that is already running for a server may call
 * other lane-wrapped operations for the same server, and they run inline
 * instead of queueing behind their caller. Callbacks that should not inherit
 * that permission (event listeners) run through {@link ServerLanes.outside}.
 */
export class ServerLanes {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #held = new AsyncLocalStorage<ReadonlySet<string>>();

  /**
   * Run `work` once every earlier item for `serverId` has settled.
   *
   * @param serverId - The server the work belongs to.
   * @param work - The work to run; its result or rejection is returned.
   */
  run<T>(serverId: string, work: () => Promise<T>): Promise<T> {
    const held = this.#held.getStore();
    if (held?.has(serverId)) return invoke(work);

    const lane = new Set(held);
    lane.add(serverId);
    const start = () => this.#held.run(lane, work);
    const previous = this.#tails.get(serverId);
    // Claim the lane before starting, so work queued while this work runs
    // synchronously still waits for it.
    let release = noop;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(serverId, tail);
    void tail.then(() => {
      if (this.#tails.get(serverId) === tail) this.#tails.delete(serverId);
    });
    // An idle lane starts the work synchronously, as a direct call would.
    const result = previous ? previous.then(start) : invoke(start);
    result.then(release, release);
    return result;
  }

  /**
   * Resolve once no work is queued or running for `serverId`, including work
   * queued while earlier work settles. Resolves immediately when called from
   * that server's own work.
   */
  async idle(serverId: string): Promise<void> {
    if (this.#held.getStore()?.has(serverId)) return;
    while (true) {
      const tail = this.#tails.get(serverId);
      if (!tail) return;
      await tail;
    }
  }

  /** Settle-promises for the work queued right now, one per busy server. */
  pending(): Promise<void>[] {
    return [...this.#tails.values()];
  }

  /**
   * Stop waiting for a server's queued work. Work already running keeps
   * running; later work for the server no longer queues behind it.
   */
  forget(serverId: string): void {
    this.#tails.delete(serverId);
  }

  /** Stop waiting for every server's queued work. */
  forgetAll(): void {
    this.#tails.clear();
  }

  /** Run `fn` without the current work's re-entrant lane permission. */
  outside<T>(fn: () => T): T {
    return this.#held.run(NO_LANES, fn);
  }
}
