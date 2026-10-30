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
 * Rejection for lane work that was still queued when its server's lane was
 * forgotten (the server was removed or its connections closed).
 */
export class ServerLaneCancelledError extends Error {
  /** Stable discriminant for this error. */
  readonly _tag = "ServerLaneCancelledError" as const;

  /**
   * @param serverId - The server whose queued work was cancelled.
   */
  constructor(readonly serverId: string) {
    super(
      `Connection work for MCP server "${serverId}" was cancelled because the server was removed or closed`
    );
    this.name = "ServerLaneCancelledError";
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
  /** Bumped by `forget()`; queued work from an older generation is cancelled. */
  readonly #generations = new Map<string, number>();
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
    const generation = this.#generation(serverId);
    const start = () =>
      this.#generation(serverId) === generation
        ? this.#held.run(lane, work)
        : Promise.reject(new ServerLaneCancelledError(serverId));
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
   * Drop a server's queue: work still waiting rejects with
   * {@link ServerLaneCancelledError}, work already running keeps running,
   * and later work no longer queues behind either.
   */
  forget(serverId: string): void {
    this.#generations.set(serverId, this.#generation(serverId) + 1);
    this.#tails.delete(serverId);
  }

  /** Drop every server's queue, as {@link ServerLanes.forget} does for one. */
  forgetAll(): void {
    for (const serverId of [...this.#tails.keys()]) this.forget(serverId);
  }

  #generation(serverId: string): number {
    return this.#generations.get(serverId) ?? 0;
  }

  /** Run `fn` without the current work's re-entrant lane permission. */
  outside<T>(fn: () => T): T {
    return this.#held.run(NO_LANES, fn);
  }
}
