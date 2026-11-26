/**
 * The chat turns of one agent, one at a time, in the order they were
 * queued: each turn is a run on the chat-turn Task's lane, accepted when it
 * is queued, and its model call runs inside that run (`turn-task.ts`).
 *
 * A reset moves the generation on: a turn queued under an earlier one is
 * skipped (`stale`) when its run starts, without running. A run whose
 * isolate died before it started ends without running too; what a client
 * request needs to run again is on its admission record.
 *
 * In memory: one entry per turn queued in this isolate, removed when its
 * run settles it, and a count per generation.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskReceipt, TaskRunOptions } from "../tasks";
import { runsInPlace, type ChatLaneEntry } from "./turn-task";

export type TurnResult<T> =
  | { status: "completed"; value: T }
  | { status: "stale" };

export interface EnqueueOptions {
  /**
   * Generation to bind this turn to. Defaults to the current generation at
   * the time of the `enqueue` call. If the generation has moved on by the
   * time the turn's run starts, the turn is skipped.
   */
  generation?: number;
}

/** What the lane says when it took a turn's run. */
export type TurnLaneReceipt = Pick<
  TaskReceipt,
  "runId" | "superseded" | "dropped"
>;

/**
 * Accept one turn's run on the chat lane, `entry` as its `local`, arriving
 * under `policy`.
 */
export type TurnLaneRun = (
  requestId: string,
  entry: ChatLaneEntry,
  input?: Record<string, unknown>,
  policy?: TaskRunOptions["policy"]
) => Promise<TurnLaneReceipt>;

/** A turn's place in the lane, taken before its work is ready. */
export interface TurnReservation {
  /**
   * The lane's receipt, once the run is durably accepted (or, under the
   * `drop` policy, `dropped`); rejects if it was not.
   */
  readonly accepted: Promise<TurnLaneReceipt>;
  enqueue<T>(
    fn: () => Promise<T>,
    options?: EnqueueOptions
  ): Promise<TurnResult<T>>;
  /** End the run without a turn. */
  release(): void;
}

export class TurnLane {
  #generation = 0;
  #activeRequestId: string | null = null;
  #activeGeneration: number | null = null;
  readonly #counts = new Map<number, number>();
  /** Turns that took their place before their work was handed over. */
  readonly #reserved = new Map<string, TurnReservation>();
  /** Settles once every turn queued so far has settled. */
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly accept: TurnLaneRun) {}

  get generation(): number {
    return this.#generation;
  }

  get activeRequestId(): string | null {
    return this.#activeRequestId;
  }

  get activeGeneration(): number | null {
    return this.#activeGeneration;
  }

  get isActive(): boolean {
    return this.#activeRequestId !== null;
  }

  /**
   * Queue `fn` as the turn `requestId`. Resolves when it ran, or `stale`
   * when the generation moved on before its run started.
   */
  enqueue<T>(
    requestId: string,
    fn: () => Promise<T>,
    options?: EnqueueOptions
  ): Promise<TurnResult<T>> {
    // A lane run's recovery attempt holds the lane, and the app's onStart
    // comes before what an earlier isolate left: their turns run in place.
    if (runsInPlace()) {
      this.reserveInline(requestId);
    }
    // A request that took its place earlier runs there.
    const reserved = this.#reserved.get(requestId);
    if (reserved) {
      this.#reserved.delete(requestId);
      return reserved.enqueue(fn, options);
    }
    return this.#enqueueNow(requestId, fn, options);
  }

  #enqueueNow<T>(
    requestId: string,
    fn: () => Promise<T>,
    options?: EnqueueOptions
  ): Promise<TurnResult<T>> {
    const generation = options?.generation ?? this.#generation;
    this.#counts.set(generation, (this.#counts.get(generation) ?? 0) + 1);
    let settled = false;
    let resolve!: (result: TurnResult<T>) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<TurnResult<T>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const settle = (end: () => void) => {
      if (settled) return;
      settled = true;
      this.#decrement(generation);
      end();
    };
    // The turn runs in the async context it was queued in (its connection,
    // its request), whichever attempt starts its run.
    const inCaller = AsyncLocalStorage.snapshot();
    const entry: ChatLaneEntry = {
      lane: true,
      run: async (inside) => {
        if (this.#generation !== generation) {
          settle(() => resolve({ status: "stale" }));
          return;
        }
        this.#activeRequestId = requestId;
        this.#activeGeneration = generation;
        try {
          const value = await inCaller(() => inside(fn));
          settle(() => resolve({ status: "completed", value }));
        } catch (error) {
          settle(() => reject(error));
        } finally {
          this.#activeRequestId = null;
          this.#activeGeneration = null;
        }
      },
      // The run ended without running the turn: skipped, cancelled, or its
      // attempt failed before it began.
      dropped: () => settle(() => resolve({ status: "stale" }))
    };
    const done = result.then(
      () => {},
      () => {}
    );
    const previous = this.#tail;
    this.#tail = previous.then(() => done);
    this.accept(requestId, entry).then(
      () => {},
      (error: unknown) => settle(() => reject(error))
    );
    return result;
  }

  /** Forget a {@link reserveInline} its request did not use. */
  releaseInline(requestId: string): void {
    this.#reserved.get(requestId)?.release();
  }

  /**
   * Run the turn `requestId` where it is now, inside the run that replays
   * it: its next `enqueue` runs at once.
   */
  reserveInline(requestId: string, onDone?: () => void): void {
    this.#reserved.set(requestId, {
      accepted: Promise.resolve({ runId: "" }),
      release: () => {
        this.#reserved.delete(requestId);
        onDone?.();
      },
      enqueue: async <T>(fn: () => Promise<T>) => {
        const generation = this.#generation;
        // Counted as queued work while it runs, as a turn on the lane is.
        this.#counts.set(generation, (this.#counts.get(generation) ?? 0) + 1);
        this.#activeRequestId = requestId;
        this.#activeGeneration = generation;
        try {
          return { status: "completed" as const, value: await fn() };
        } finally {
          this.#activeRequestId = null;
          this.#activeGeneration = null;
          this.#decrement(generation);
          onDone?.();
        }
      }
    });
  }

  /**
   * Take the turn `requestId` its place in the lane now, with `input` on its
   * run, and hand it its work later: `enqueue` runs it there, `release`
   * ends its run without a turn. It counts as queued from now until it is
   * released or its turn settled, under the generation it was taken in.
   */
  reserve(
    requestId: string,
    input?: Record<string, unknown>,
    policy?: TaskRunOptions["policy"]
  ): TurnReservation {
    // Set once the work is handed over: a run that starts after it begins
    // at once, one that starts before waits for it.
    let handed: (() => Promise<void>) | null | undefined;
    let resolveWork!: (work: (() => Promise<void>) | null) => void;
    const work = new Promise<(() => Promise<void>) | null>((resolve) => {
      resolveWork = resolve;
    });
    const handOver = (next: (() => Promise<void>) | null) => {
      if (handed !== undefined) return;
      handed = next;
      resolveWork(next);
    };
    let dropped = () => {};
    const ended = new Promise<void>((resolve) => {
      dropped = resolve;
    });
    // The turn runs in the async context it was queued in (its connection,
    // its request), whichever attempt starts its run.
    let inCaller = AsyncLocalStorage.snapshot();
    let inside: (<T>(fn: () => Promise<T>) => Promise<T>) | undefined;
    const entry: ChatLaneEntry = {
      lane: true,
      run: async (into) => {
        inside = into;
        const next = handed !== undefined ? handed : await work;
        if (next) await inCaller(next);
      },
      // The run ended without running the turn: skipped, cancelled, or its
      // attempt failed before it began.
      dropped: () => {
        dropped();
        handOver(null);
      }
    };
    const taken = this.#generation;
    this.#counts.set(taken, (this.#counts.get(taken) ?? 0) + 1);
    let counted = true;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = () => {
        if (counted) this.#decrement(taken);
        counted = false;
        resolve();
      };
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => finished);
    const accepted = this.accept(requestId, entry, input, policy);
    const reservation: TurnReservation = {
      accepted,
      release: () => {
        if (this.#reserved.get(requestId) === reservation) {
          this.#reserved.delete(requestId);
        }
        handOver(null);
        finish();
      },
      enqueue: <T>(fn: () => Promise<T>, options?: EnqueueOptions) => {
        const generation = options?.generation ?? taken;
        inCaller = AsyncLocalStorage.snapshot();
        let settled = false;
        let resolve!: (result: TurnResult<T>) => void;
        let reject!: (error: unknown) => void;
        const result = new Promise<TurnResult<T>>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        const settle = (end: () => void) => {
          if (settled) return;
          settled = true;
          finish();
          end();
        };
        handOver(async () => {
          if (this.#generation !== generation || !inside) {
            settle(() => resolve({ status: "stale" }));
            return;
          }
          this.#activeRequestId = requestId;
          this.#activeGeneration = generation;
          try {
            const value = await inside(fn);
            settle(() => resolve({ status: "completed", value }));
          } catch (error) {
            settle(() => reject(error));
          } finally {
            this.#activeRequestId = null;
            this.#activeGeneration = null;
          }
        });
        void ended.then(() => settle(() => resolve({ status: "stale" })));
        accepted.catch((error: unknown) => settle(() => reject(error)));
        return result;
      }
    };
    if (input) this.#reserved.set(requestId, reservation);
    return reservation;
  }

  /** Skip every turn queued so far once its run starts. */
  reset(): void {
    this.#generation++;
  }

  /** Resolves once every turn queued in this isolate has settled. */
  async waitForIdle(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.#tail;
      await tail;
    } while (this.#tail !== tail);
  }

  /** Turns queued under `generation` (default: the current one) not yet settled. */
  queuedCount(generation?: number): number {
    return this.#counts.get(generation ?? this.#generation) ?? 0;
  }

  #decrement(generation: number): void {
    const count = (this.#counts.get(generation) ?? 1) - 1;
    if (count <= 0) this.#counts.delete(generation);
    else this.#counts.set(generation, count);
  }
}
