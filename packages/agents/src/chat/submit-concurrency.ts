import type { MessageConcurrency } from "./lifecycle";

export type NormalizedMessageConcurrency =
  | "queue"
  | "latest"
  | "merge"
  | "drop"
  | {
      strategy: "debounce";
      debounceMs: number;
    };

export type SubmitConcurrencyDecision = {
  action: "execute" | "drop";
  strategy: NormalizedMessageConcurrency | null;
  submitSequence: number | null;
  debounceUntilMs: number | null;
};

export class SubmitConcurrencyController {
  private _submitSequence = 0;
  private _latestOverlappingSubmitSequence = 0;
  private _pendingEnqueueCount = 0;
  private _resetEpoch = 0;
  private _activeDebounceTimers = new Set<ReturnType<typeof setTimeout>>();
  private _activeDebounceResolves = new Set<() => void>();

  constructor(private readonly options: { defaultDebounceMs: number }) {}

  get pendingEnqueueCount(): number {
    return this._pendingEnqueueCount;
  }

  get overlappingSubmitCount(): number {
    return this._latestOverlappingSubmitSequence;
  }

  decide(options: {
    concurrency: MessageConcurrency;
    isSubmitMessage: boolean;
    queuedTurns: number;
  }): SubmitConcurrencyDecision {
    const queuedTurnsInCurrentEpoch =
      options.queuedTurns + this._pendingEnqueueCount;

    if (!options.isSubmitMessage || queuedTurnsInCurrentEpoch === 0) {
      return {
        action: "execute",
        strategy: null,
        submitSequence: null,
        debounceUntilMs: null
      };
    }

    const concurrency = this.normalize(options.concurrency);
    if (concurrency === "drop") {
      return {
        action: "drop",
        strategy: concurrency,
        submitSequence: null,
        debounceUntilMs: null
      };
    }

    if (concurrency === "queue") {
      return {
        action: "execute",
        strategy: concurrency,
        submitSequence: null,
        debounceUntilMs: null
      };
    }

    const submitSequence = ++this._submitSequence;
    this._latestOverlappingSubmitSequence = submitSequence;

    if (concurrency === "latest" || concurrency === "merge") {
      return {
        action: "execute",
        strategy: concurrency,
        submitSequence,
        debounceUntilMs: null
      };
    }

    return {
      action: "execute",
      strategy: concurrency,
      submitSequence,
      debounceUntilMs: Date.now() + concurrency.debounceMs
    };
  }

  /**
   * Mark a submit as accepted and in-flight between admission and turn
   * queue registration. Returns an idempotent `release()` function that
   * must be called when the submit either reaches the turn queue or is
   * abandoned. The returned function is bound to the controller's reset
   * epoch — releases from before the most recent `reset()` are no-ops,
   * so post-reset submits keep an accurate count.
   */
  beginEnqueue(): () => void {
    this._pendingEnqueueCount++;
    const epoch = this._resetEpoch;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this._resetEpoch !== epoch) return;
      this._pendingEnqueueCount = Math.max(0, this._pendingEnqueueCount - 1);
    };
  }

  isSuperseded(submitSequence: number | null): boolean {
    return (
      submitSequence !== null &&
      submitSequence < this._latestOverlappingSubmitSequence
    );
  }

  async waitForTimestamp(timestampMs: number): Promise<void> {
    const remainingMs = timestampMs - Date.now();
    if (remainingMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      const wrappedResolve = () => {
        this._activeDebounceResolves.delete(wrappedResolve);
        resolve();
      };
      const timer = setTimeout(() => {
        this._activeDebounceTimers.delete(timer);
        wrappedResolve();
      }, remainingMs);

      this._activeDebounceTimers.add(timer);
      this._activeDebounceResolves.add(wrappedResolve);
    });
  }

  cancelActiveDebounce(): void {
    for (const timer of this._activeDebounceTimers) {
      clearTimeout(timer);
    }
    this._activeDebounceTimers.clear();

    const resolves = [...this._activeDebounceResolves];
    this._activeDebounceResolves.clear();
    for (const resolve of resolves) {
      resolve();
    }
  }

  reset(): void {
    this._resetEpoch++;
    this._pendingEnqueueCount = 0;
    this.cancelActiveDebounce();
  }

  async waitForIdle(waitForQueueIdle: () => Promise<void>): Promise<void> {
    while (true) {
      await waitForQueueIdle();
      if (this._pendingEnqueueCount === 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  private normalize(
    concurrency: MessageConcurrency
  ): NormalizedMessageConcurrency {
    if (typeof concurrency === "string") {
      return concurrency;
    }

    const debounceMs = concurrency.debounceMs;

    return {
      strategy: "debounce",
      debounceMs:
        typeof debounceMs === "number" &&
        Number.isFinite(debounceMs) &&
        debounceMs >= 0
          ? debounceMs
          : this.options.defaultDebounceMs
    };
  }
}
