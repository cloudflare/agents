import { describe, expect, it } from "vitest";
import { SubmitConcurrencyController } from "../submit-concurrency";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SubmitConcurrencyController", () => {
  it("treats accepted-but-not-enqueued submits as overlapping", () => {
    const controller = new SubmitConcurrencyController({
      defaultDebounceMs: 750
    });

    const first = controller.decide({
      concurrency: "drop",
      isSubmitMessage: true,
      queuedTurns: 0
    });
    expect(first.action).toBe("execute");

    const release = controller.beginEnqueue();
    const second = controller.decide({
      concurrency: "drop",
      isSubmitMessage: true,
      queuedTurns: 0
    });
    expect(second.action).toBe("drop");

    release();
    const third = controller.decide({
      concurrency: "drop",
      isSubmitMessage: true,
      queuedTurns: 0
    });
    expect(third.action).toBe("execute");
  });

  it("ignores releases from before the most recent reset", () => {
    const controller = new SubmitConcurrencyController({
      defaultDebounceMs: 750
    });

    const releaseA = controller.beginEnqueue();
    expect(controller.pendingEnqueueCount).toBe(1);

    controller.reset();
    expect(controller.pendingEnqueueCount).toBe(0);

    controller.beginEnqueue();
    expect(controller.pendingEnqueueCount).toBe(1);

    // A's release fires after reset + a new submit. Without the epoch
    // guard this would erase the new submit's pending-enqueue marker
    // and a third submit could miss the overlap.
    releaseA();
    expect(controller.pendingEnqueueCount).toBe(1);

    const third = controller.decide({
      concurrency: "drop",
      isSubmitMessage: true,
      queuedTurns: 0
    });
    expect(third.action).toBe("drop");
  });

  it("release functions are idempotent", () => {
    const controller = new SubmitConcurrencyController({
      defaultDebounceMs: 750
    });

    const release = controller.beginEnqueue();
    release();
    expect(controller.pendingEnqueueCount).toBe(0);

    release();
    expect(controller.pendingEnqueueCount).toBe(0);
  });

  it("tracks superseded overlapping submits", () => {
    const controller = new SubmitConcurrencyController({
      defaultDebounceMs: 750
    });

    controller.beginEnqueue();
    const second = controller.decide({
      concurrency: "latest",
      isSubmitMessage: true,
      queuedTurns: 0
    });
    const third = controller.decide({
      concurrency: "latest",
      isSubmitMessage: true,
      queuedTurns: 0
    });

    expect(controller.isSuperseded(second.submitSequence)).toBe(true);
    expect(controller.isSuperseded(third.submitSequence)).toBe(false);
  });

  it("cancels all active debounce waiters", async () => {
    const controller = new SubmitConcurrencyController({
      defaultDebounceMs: 750
    });
    const farFuture = Date.now() + 10_000;

    let firstResolved = false;
    let secondResolved = false;
    const first = controller.waitForTimestamp(farFuture).then(() => {
      firstResolved = true;
    });
    const second = controller.waitForTimestamp(farFuture).then(() => {
      secondResolved = true;
    });

    controller.cancelActiveDebounce();
    await Promise.race([Promise.all([first, second]), delay(100)]);

    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(true);
  });
});
