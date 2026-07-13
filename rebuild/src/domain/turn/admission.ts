import { AbortedError, ConflictError } from "../../kernel/errors.js";

export interface TurnQueue {
  run<T>(task: {
    requestId: string;
    trigger: string;
    admission?: "queue" | "replace" | "reject";
    execute: (signal: AbortSignal) => Promise<T>;
  }): Promise<T>;
  cancel(requestId: string, reason?: string): boolean;
  cancelAll(reason?: string): void;
  running(): { requestId: string; trigger: string } | null;
  pending(): number;
  waitUntilStable(): Promise<void>;
}

interface QueuedTask {
  requestId: string;
  trigger: string;
  controller: AbortController;
  execute: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * Serializes turn execution: exactly one task runs at a time. Entry points
 * admit via "queue" (FIFO wait), "replace" (abort the running task, then run
 * next), or "reject" (fail fast while busy). No ports/deps — pure in-memory
 * scheduling; persistence and recovery orchestration live above this module.
 */
export function createTurnQueue(): TurnQueue {
  const waiting: QueuedTask[] = [];
  let runningTask: QueuedTask | null = null;
  let stableWaiters: Array<() => void> = [];

  function isBusy(): boolean {
    return runningTask !== null || waiting.length > 0;
  }

  function notifyIfStable(): void {
    if (runningTask === null && waiting.length === 0) {
      const waiters = stableWaiters;
      stableWaiters = [];
      for (const w of waiters) w();
    }
  }

  function startNext(): void {
    if (runningTask !== null) return;
    const next = waiting.shift();
    if (!next) {
      notifyIfStable();
      return;
    }
    runningTask = next;
    // Defer the actual call so `run()` never invokes `execute` synchronously
    // in the caller's stack frame — this is what lets a running task enqueue
    // a follow-up without deadlocking.
    Promise.resolve()
      .then(() => next.execute(next.controller.signal))
      .then(
        (value) => settle(next, () => next.resolve(value)),
        (err) => settle(next, () => next.reject(err))
      );
  }

  /**
   * Clears the running slot, settles the finished task's own promise, and
   * only then advances to the next queued task — all synchronously in one
   * tick (no trailing .finally(), which would add an extra microtask hop and
   * let running()/pending()/waitUntilStable() be observed stale right after
   * `await`ing the task itself). Settling before startNext() also ensures
   * anything chained on the task's own promise (e.g. a caller doing
   * `queue.run(...).then(...)`) runs before waitUntilStable()'s waiters do,
   * so a continuation's own follow-up is visible once "stable" fires.
   */
  function settle(task: QueuedTask, outcome: () => void): void {
    if (runningTask === task) runningTask = null;
    outcome();
    startNext();
  }

  function removeFromWaiting(requestId: string): QueuedTask | undefined {
    const idx = waiting.findIndex((t) => t.requestId === requestId);
    if (idx === -1) return undefined;
    const [task] = waiting.splice(idx, 1);
    return task;
  }

  return {
    run<T>(task: {
      requestId: string;
      trigger: string;
      admission?: "queue" | "replace" | "reject";
      execute: (signal: AbortSignal) => Promise<T>;
    }): Promise<T> {
      const admission = task.admission ?? "queue";

      if (admission === "reject" && isBusy()) {
        return Promise.reject(
          new ConflictError(`Turn queue busy; rejected request "${task.requestId}"`)
        );
      }

      return new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        const queued: QueuedTask = {
          requestId: task.requestId,
          trigger: task.trigger,
          controller,
          execute: task.execute as (signal: AbortSignal) => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        };

        if (admission === "replace" && runningTask) {
          runningTask.controller.abort(new AbortedError(`Replaced by request "${task.requestId}"`));
          waiting.unshift(queued);
        } else {
          waiting.push(queued);
        }
        startNext();
      });
    },

    cancel(requestId: string, reason?: string): boolean {
      if (runningTask && runningTask.requestId === requestId) {
        runningTask.controller.abort(new AbortedError(reason ?? `Cancelled: ${requestId}`));
        return true;
      }
      const removed = removeFromWaiting(requestId);
      if (removed) {
        removed.reject(new AbortedError(reason ?? `Cancelled: ${requestId}`));
        notifyIfStable();
        return true;
      }
      return false;
    },

    cancelAll(reason?: string): void {
      if (runningTask) {
        runningTask.controller.abort(new AbortedError(reason ?? "Cancelled: all"));
      }
      const drained = waiting.splice(0, waiting.length);
      for (const t of drained) {
        t.reject(new AbortedError(reason ?? `Cancelled: ${t.requestId}`));
      }
      notifyIfStable();
    },

    running(): { requestId: string; trigger: string } | null {
      return runningTask ? { requestId: runningTask.requestId, trigger: runningTask.trigger } : null;
    },

    pending(): number {
      return waiting.length;
    },

    waitUntilStable(): Promise<void> {
      if (runningTask === null && waiting.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        stableWaiters.push(resolve);
      });
    },
  };
}
