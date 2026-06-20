import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TIMED_OUT,
  awaitWithDeadline,
  drainInteractionApplies
} from "../async-helpers";

describe("awaitWithDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits indefinitely (returns the promise) when the deadline is null", async () => {
    expect(await awaitWithDeadline(Promise.resolve(42), null)).toBe(42);
  });

  it("returns the resolved value when it settles before the deadline", async () => {
    vi.useFakeTimers();
    const result = await awaitWithDeadline(
      Promise.resolve("ok"),
      Date.now() + 1000
    );
    expect(result).toBe("ok");
    // The timeout timer must be cleared so it can't pin the isolate awake.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves to TIMED_OUT once the deadline passes", async () => {
    vi.useFakeTimers();
    const pending = new Promise<string>(() => {});
    const race = awaitWithDeadline(pending, Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await race).toBe(TIMED_OUT);
  });

  it("times out immediately (clamped to 0ms) when the deadline is already past", async () => {
    vi.useFakeTimers();
    const pending = new Promise<string>(() => {});
    const race = awaitWithDeadline(pending, Date.now() - 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(await race).toBe(TIMED_OUT);
  });
});

describe("drainInteractionApplies", () => {
  it("seeds the tail but bails before awaiting when nothing is pending", async () => {
    const getTail = vi.fn(() => Promise.resolve());
    await drainInteractionApplies(() => false, getTail);
    // Reads the tail once to seed, then the loop's pending-check bails.
    expect(getTail).toHaveBeenCalledTimes(1);
  });

  it("returns after a single await when the tail does not advance", async () => {
    const tail = Promise.resolve();
    const getTail = vi.fn(() => tail);
    await drainInteractionApplies(() => true, getTail);
    // seed (1) + post-await re-read (2); identity unchanged -> return.
    expect(getTail).toHaveBeenCalledTimes(2);
  });

  it("loops while the tail advances and stops once it stabilizes", async () => {
    const a = Promise.resolve();
    const b = Promise.resolve();
    const seq = [a, b, b, b];
    let i = 0;
    const getTail = vi.fn(() => seq[Math.min(i++, seq.length - 1)]);
    await drainInteractionApplies(() => true, getTail);
    // seed=a; iter1 re-read=b (advanced) -> reassign=b; iter2 re-read=b -> stop.
    expect(getTail).toHaveBeenCalledTimes(4);
  });

  it("bails when the pending continuation is cleared mid-drain", async () => {
    const a = Promise.resolve();
    const b = Promise.resolve();
    const seq = [a, b, b];
    let i = 0;
    const getTail = () => seq[Math.min(i++, seq.length - 1)];
    let checks = 0;
    const hasPending = () => {
      checks += 1;
      return checks < 2; // pending for the first iteration, cleared by the second
    };
    await drainInteractionApplies(hasPending, getTail);
    expect(checks).toBe(2);
  });

  it("ignores a rejected tail and keeps draining", async () => {
    const rejected = Promise.reject(new Error("apply failed"));
    rejected.catch(() => {});
    const settled = Promise.resolve();
    const seq = [rejected, settled, settled];
    let i = 0;
    const getTail = vi.fn(() => seq[Math.min(i++, seq.length - 1)]);
    await expect(
      drainInteractionApplies(() => true, getTail)
    ).resolves.toBeUndefined();
    // seed=rejected; iter1 awaits+swallows, re-read=settled (advanced) -> reassign;
    // iter2 re-read=settled -> stop.
    expect(getTail).toHaveBeenCalledTimes(4);
  });
});
