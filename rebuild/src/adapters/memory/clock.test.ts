import { describe, expect, it } from "vitest";
import { createTestClock } from "./clock.js";

describe("createTestClock", () => {
  it("defaults to 0", () => {
    const clock = createTestClock();
    expect(clock.now()).toBe(0);
  });

  it("accepts a starting time", () => {
    const clock = createTestClock(1000);
    expect(clock.now()).toBe(1000);
  });

  it("advance() adds milliseconds", () => {
    const clock = createTestClock(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
  });

  it("set() replaces the current time", () => {
    const clock = createTestClock(1000);
    clock.set(5000);
    expect(clock.now()).toBe(5000);
  });

  it("subscribe() notifies listeners on advance", () => {
    const clock = createTestClock(0);
    const seen: number[] = [];
    clock.subscribe((now) => seen.push(now));
    clock.advance(10);
    clock.advance(5);
    expect(seen).toEqual([10, 15]);
  });

  it("subscribe() notifies listeners on set", () => {
    const clock = createTestClock(0);
    const seen: number[] = [];
    clock.subscribe((now) => seen.push(now));
    clock.set(100);
    expect(seen).toEqual([100]);
  });

  it("subscribe() returns an unsubscribe function", () => {
    const clock = createTestClock(0);
    const seen: number[] = [];
    const unsubscribe = clock.subscribe((now) => seen.push(now));
    clock.advance(1);
    unsubscribe();
    clock.advance(1);
    expect(seen).toEqual([1]);
  });
});
