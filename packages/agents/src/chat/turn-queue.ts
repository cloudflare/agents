/**
 * TurnQueue — serial async queue with generation-based invalidation.
 *
 * Serializes async work via a promise chain, tracks which request is
 * currently active, and lets callers invalidate all queued work by
 * advancing a generation counter.
 *
 * Used by @cloudflare/ai-chat (full concurrency policy spectrum) and
 * @cloudflare/think (simple serial queue) to prevent overlapping
 * chat turns.
 */

export type TurnResult<T> =
  | { status: "completed"; value: T }
  | { status: "stale" };

export interface EnqueueOptions {
  /**
   * Generation to bind this turn to. Defaults to the current generation
   * at the time of the `enqueue` call. If the queue's generation has
   * advanced past this value by the time the turn reaches the front,
   * `fn` is not called and `{ status: "stale" }` is returned.
   */
  generation?: number;
}

export class TurnQueue {
  private _queue: Promise<void> = Promise.resolve();
  private _generation = 0;
  private _activeRequestId: string | null = null;
  private _countsByGeneration = new Map<number, number>();

  get generation(): number {
    return this._generation;
  }

  get activeRequestId(): string | null {
    return this._activeRequestId;
  }

  get isActive(): boolean {
    return this._activeRequestId !== null;
  }

  async enqueue<T>(
    requestId: string,
    fn: () => Promise<T>,
    options?: EnqueueOptions
  ): Promise<TurnResult<T>> {
    const previousTurn = this._queue;
    let releaseTurn!: () => void;
    const capturedGeneration = options?.generation ?? this._generation;

    this._countsByGeneration.set(
      capturedGeneration,
      (this._countsByGeneration.get(capturedGeneration) ?? 0) + 1
    );

    this._queue = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    await previousTurn;

    if (this._generation !== capturedGeneration) {
      this._decrementCount(capturedGeneration);
      releaseTurn();
      return { status: "stale" };
    }

    this._activeRequestId = requestId;
    try {
      const value = await fn();
      return { status: "completed", value };
    } finally {
      this._activeRequestId = null;
      this._decrementCount(capturedGeneration);
      releaseTurn();
    }
  }

  /**
   * Advance the generation counter. All turns enqueued under older
   * generations will be skipped when they reach the front of the queue.
   */
  reset(): void {
    this._generation++;
  }

  /**
   * Wait until the queue is fully drained (no pending or active turns).
   */
  async waitForIdle(): Promise<void> {
    let queue: Promise<void>;
    do {
      queue = this._queue;
      await queue;
    } while (this._queue !== queue);
  }

  /**
   * Number of active + queued turns for a given generation.
   * Defaults to the current generation.
   */
  queuedCount(generation?: number): number {
    return this._countsByGeneration.get(generation ?? this._generation) ?? 0;
  }

  private _decrementCount(generation: number): void {
    const count = (this._countsByGeneration.get(generation) ?? 1) - 1;
    if (count <= 0) {
      this._countsByGeneration.delete(generation);
    } else {
      this._countsByGeneration.set(generation, count);
    }
  }
}
