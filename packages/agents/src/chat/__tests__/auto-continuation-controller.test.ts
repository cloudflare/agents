import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AutoContinuationController,
  type AutoContinuationHost
} from "../auto-continuation-controller";
import { ContinuationState } from "../continuation-state";
import type { ContinuationConnection } from "../continuation-state";

function makeConnection(id: string): ContinuationConnection {
  return { id, send: vi.fn() };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A minimal in-memory host implementing the controller's substrate hooks. The
 * barrier's real coupling (inference pipeline, apply chain) is reduced to flags
 * + a controllable drain promise, so these tests exercise the controller's
 * state machine in isolation.
 */
class FakeHost implements AutoContinuationHost {
  continuation = new ContinuationState();
  streamActive = false;
  pendingInteraction = false;
  incompleteBatch = false;
  /** The promise `drainInteractionApplies` awaits — control it to hold a drain. */
  applyTail: Promise<void> = Promise.resolve();
  fireCount = 0;
  keepAliveCount = 0;
  private _idSeq = 0;

  generateRequestId(): string {
    return `req-${++this._idSeq}`;
  }
  isStreamActive(): boolean {
    return this.streamActive;
  }
  hasPendingInteraction(): boolean {
    return this.pendingInteraction;
  }
  hasIncompleteToolBatch(): boolean {
    return this.incompleteBatch;
  }
  async drainInteractionApplies(): Promise<void> {
    await this.applyTail;
  }
  async keepAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    this.keepAliveCount++;
    return await fn();
  }
  fire(): void {
    this.fireCount++;
  }
}

const COALESCE = AutoContinuationController.COALESCE_MS;

describe("AutoContinuationController", () => {
  let host: FakeHost;
  let controller: AutoContinuationController;

  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    controller = new AutoContinuationController(host);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function schedule(connId = "c1") {
    controller.schedule({
      connection: makeConnection(connId),
      clientTools: undefined,
      body: undefined,
      errorPrefix: "[test] continuation failed:"
    });
  }

  // ── schedule() branches ─────────────────────────────────────────────

  it("schedule() creates pending with a generated requestId and arms the timer", () => {
    schedule();
    expect(host.continuation.pending).not.toBeNull();
    expect(host.continuation.pending?.requestId).toBe("req-1");
    expect(host.continuation.awaitingConnections.has("c1")).toBe(true);
    expect(controller.isArmed()).toBe(true);
  });

  it("schedule() re-targets an existing pending without minting a new requestId", () => {
    schedule("c1");
    const requestId = host.continuation.pending?.requestId;
    schedule("c2");
    expect(host.continuation.pending?.requestId).toBe(requestId);
    expect(host.continuation.pending?.connection.id).toBe("c2");
    expect(host.continuation.awaitingConnections.has("c2")).toBe(true);
  });

  it("schedule() stores a deferred follow-up (not pending) once a continuation is running", () => {
    schedule("c1");
    // Simulate the continuation having entered its turn.
    const running = host.continuation.pending;
    if (running) running.pastCoalesce = true;
    controller.cancelTimer();

    schedule("c2");

    // The running pending is untouched; the new result becomes deferred.
    expect(host.continuation.pending?.connection.id).toBe("c1");
    expect(host.continuation.pending?.pastCoalesce).toBe(true);
    expect(host.continuation.deferred).not.toBeNull();
    expect(host.continuation.deferred?.connection.id).toBe("c2");
    // Defer does NOT arm the timer.
    expect(controller.isArmed()).toBe(false);
  });

  // ── coalesce / single fire ──────────────────────────────────────────

  it("fires exactly once after the coalesce window on a complete batch", async () => {
    schedule();
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.fireCount).toBe(1);
    // Fast path does not run a drain.
    expect(host.keepAliveCount).toBe(0);
    expect(controller.isArmed()).toBe(false);
  });

  it("coalesces rapid sibling results into a single fire", async () => {
    schedule("c1");
    await vi.advanceTimersByTimeAsync(COALESCE / 2);
    schedule("c2");
    await vi.advanceTimersByTimeAsync(COALESCE / 2);
    schedule("c3");
    expect(host.fireCount).toBe(0);
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.fireCount).toBe(1);
  });

  // ── stream-active gate ──────────────────────────────────────────────

  it("holds without firing while a stream is active, then fires once the stream ends", async () => {
    host.streamActive = true;
    schedule();
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.fireCount).toBe(0);
    expect(host.keepAliveCount).toBe(0);
    expect(host.continuation.pending).not.toBeNull();

    // Stream finalizes: host clears its flag then re-arms the barrier.
    host.streamActive = false;
    controller.rearmForBatch();
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.fireCount).toBe(1);
  });

  // ── incomplete-batch drain / no fire-through ────────────────────────

  it("drains then holds (no fire-through) when the batch is still incomplete", async () => {
    host.incompleteBatch = true;
    const drain = deferred();
    host.applyTail = drain.promise;

    schedule();
    await vi.advanceTimersByTimeAsync(COALESCE);
    // Entered the drain (barrier active) but has not fired.
    expect(host.keepAliveCount).toBe(1);
    expect(host.fireCount).toBe(0);

    // Drain completes but the batch is STILL incomplete → hold, do not fire.
    drain.resolve();
    await vi.runAllTimersAsync();
    expect(host.fireCount).toBe(0);
    expect(host.continuation.pending).not.toBeNull();
  });

  it("fires once the drain reveals a now-complete batch", async () => {
    host.pendingInteraction = true;
    const drain = deferred();
    host.applyTail = drain.promise;

    schedule();
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.keepAliveCount).toBe(1);
    expect(host.fireCount).toBe(0);

    // The completing result lands: clear the gates, then resolve the drain.
    host.pendingInteraction = false;
    host.incompleteBatch = false;
    drain.resolve();
    await vi.runAllTimersAsync();
    expect(host.fireCount).toBe(1);
  });

  // ── double-fire guard ───────────────────────────────────────────────

  it("absorbs a re-entrant fireWhenStable into the in-flight drain (no double-fire)", async () => {
    host.incompleteBatch = true;
    const drain = deferred();
    host.applyTail = drain.promise;

    schedule();
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.keepAliveCount).toBe(1);

    // A sibling re-runs the check while the drain is in flight — must no-op.
    controller.fireWhenStable();
    controller.fireWhenStable();
    expect(host.keepAliveCount).toBe(1);
    expect(host.fireCount).toBe(0);

    host.incompleteBatch = false;
    drain.resolve();
    await vi.runAllTimersAsync();
    expect(host.fireCount).toBe(1);
  });

  it("cancels a timer re-armed during the drain so it cannot fire a duplicate", async () => {
    host.incompleteBatch = true;
    const drain = deferred();
    host.applyTail = drain.promise;

    schedule();
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.keepAliveCount).toBe(1);

    // A sibling re-arms the coalesce timer mid-drain.
    controller.armTimer();
    expect(controller.isArmed()).toBe(true);

    // Drain resolves with a complete batch → fires once and cancels the timer.
    host.incompleteBatch = false;
    drain.resolve();
    await vi.runAllTimersAsync();
    expect(host.fireCount).toBe(1);
    expect(controller.isArmed()).toBe(false);

    // Any leftover timer must not fire a second continuation.
    await vi.runAllTimersAsync();
    expect(host.fireCount).toBe(1);
  });

  // ── deferred activation ─────────────────────────────────────────────

  it("activateDeferredAndReschedule promotes the deferred follow-up and re-runs the barrier", () => {
    // The running turn has finished and cleared pending; a deferred follow-up
    // (stored while it was running) remains to be activated.
    host.continuation.deferred = {
      connection: makeConnection("c2"),
      connectionId: "c2",
      clientTools: undefined,
      body: undefined,
      errorPrefix: "[test]",
      prerequisite: null
    };

    controller.activateDeferredAndReschedule();

    // Deferred became pending with a freshly-minted id, and (batch complete)
    // fired synchronously via the fast path.
    expect(host.continuation.deferred).toBeNull();
    expect(host.continuation.pending?.connection.id).toBe("c2");
    expect(host.continuation.pending?.requestId).toBe("req-1");
    expect(host.fireCount).toBe(1);
  });

  it("activateDeferredAndReschedule is a no-op when nothing is deferred", () => {
    controller.activateDeferredAndReschedule();
    expect(host.continuation.pending).toBeNull();
    expect(host.fireCount).toBe(0);
  });

  // ── reset / cancel / isArmed ────────────────────────────────────────

  it("isArmed reflects the timer and clears after a fire", async () => {
    expect(controller.isArmed()).toBe(false);
    schedule();
    expect(controller.isArmed()).toBe(true);
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(controller.isArmed()).toBe(false);
  });

  it("isArmed is true while a drain is in flight", async () => {
    host.incompleteBatch = true;
    const drain = deferred();
    host.applyTail = drain.promise;
    schedule();
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(controller.isArmed()).toBe(true); // barrierActive
    drain.resolve();
    await vi.runAllTimersAsync();
  });

  it("cancelTimer disarms a pending coalesce timer without firing", async () => {
    schedule();
    expect(controller.isArmed()).toBe(true);
    controller.cancelTimer();
    expect(controller.isArmed()).toBe(false);
    await vi.runAllTimersAsync();
    expect(host.fireCount).toBe(0);
  });

  it("reset clears the timer and the double-fire guard (controller-scoped only)", async () => {
    host.incompleteBatch = true;
    const drain = deferred();
    host.applyTail = drain.promise;
    schedule();
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(controller.isArmed()).toBe(true); // timer re-armable + barrierActive

    controller.reset();
    expect(controller.isArmed()).toBe(false);

    // reset() is controller-scoped: it does NOT touch host continuation state.
    expect(host.continuation.pending).not.toBeNull();

    // Mirror the host's turn-reset (which clears continuation alongside
    // reset()): the in-flight drain then bails and nothing fires.
    host.continuation.clearPending();
    drain.resolve();
    await vi.runAllTimersAsync();
    expect(host.fireCount).toBe(0);
    expect(controller.isArmed()).toBe(false);
  });

  it("a fresh continuation scheduled after a reset-during-drain fires cleanly (reentrancy isolation)", async () => {
    // Models a turn reset (e.g. chat clear) landing while a continuation drain
    // is in flight, immediately followed by a new auto-continuation — the kind
    // of churn an eviction/redeploy or rapid clear-then-tool-result produces.
    host.incompleteBatch = true;
    const drain = deferred();
    host.applyTail = drain.promise;
    schedule("c1");
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.keepAliveCount).toBe(1); // first drain in flight

    // Host turn-reset: controller barrier torn down + continuation cleared.
    controller.reset();
    host.continuation.clearPending();
    // The first drain settles post-reset: it must NOT fire (pending cleared).
    drain.resolve();
    await vi.runAllTimersAsync();
    expect(host.fireCount).toBe(0);

    // A brand-new continuation arrives on a clean, complete batch.
    host.incompleteBatch = false;
    host.applyTail = Promise.resolve();
    schedule("c2");
    expect(controller.isArmed()).toBe(true);
    await vi.advanceTimersByTimeAsync(COALESCE);

    // Exactly one fire, for the new continuation — no leakage from the
    // reset-aborted one, no double-fire from a stale timer/guard.
    expect(host.fireCount).toBe(1);
    expect(host.continuation.pending?.connection.id).toBe("c2");
    expect(controller.isArmed()).toBe(false);
  });
});
