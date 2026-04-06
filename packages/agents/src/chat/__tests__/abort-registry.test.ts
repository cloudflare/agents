import { describe, it, expect } from "vitest";
import { AbortRegistry } from "../abort-registry";

describe("AbortRegistry", () => {
  it("creates a controller lazily on getSignal", () => {
    const registry = new AbortRegistry();
    expect(registry.has("r1")).toBe(false);

    const signal = registry.getSignal("r1");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(registry.has("r1")).toBe(true);
  });

  it("returns the same signal on repeated getSignal calls", () => {
    const registry = new AbortRegistry();
    const s1 = registry.getSignal("r1");
    const s2 = registry.getSignal("r1");
    expect(s1).toBe(s2);
  });

  it("returns undefined for non-string ids", () => {
    const registry = new AbortRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(registry.getSignal(123 as any)).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(registry.getSignal(null as any)).toBeUndefined();
  });

  it("getExistingSignal returns undefined when no controller exists", () => {
    const registry = new AbortRegistry();
    expect(registry.getExistingSignal("r1")).toBeUndefined();
  });

  it("getExistingSignal returns signal after getSignal creates it", () => {
    const registry = new AbortRegistry();
    const signal = registry.getSignal("r1");
    expect(registry.getExistingSignal("r1")).toBe(signal);
  });

  it("cancel aborts the controller's signal", () => {
    const registry = new AbortRegistry();
    const signal = registry.getSignal("r1");
    expect(signal!.aborted).toBe(false);

    registry.cancel("r1");
    expect(signal!.aborted).toBe(true);
  });

  it("cancel is a no-op for unknown ids", () => {
    const registry = new AbortRegistry();
    expect(() => registry.cancel("unknown")).not.toThrow();
  });

  it("remove deletes the controller", () => {
    const registry = new AbortRegistry();
    registry.getSignal("r1");
    expect(registry.has("r1")).toBe(true);

    registry.remove("r1");
    expect(registry.has("r1")).toBe(false);
    expect(registry.getExistingSignal("r1")).toBeUndefined();
  });

  it("destroyAll aborts all controllers and clears the registry", () => {
    const registry = new AbortRegistry();
    const s1 = registry.getSignal("r1");
    const s2 = registry.getSignal("r2");
    const s3 = registry.getSignal("r3");

    registry.destroyAll();

    expect(s1!.aborted).toBe(true);
    expect(s2!.aborted).toBe(true);
    expect(s3!.aborted).toBe(true);
    expect(registry.has("r1")).toBe(false);
    expect(registry.has("r2")).toBe(false);
    expect(registry.has("r3")).toBe(false);
  });

  it("getSignal creates a fresh controller after remove", () => {
    const registry = new AbortRegistry();
    const s1 = registry.getSignal("r1");
    registry.cancel("r1");
    registry.remove("r1");

    const s2 = registry.getSignal("r1");
    expect(s2).not.toBe(s1);
    expect(s2!.aborted).toBe(false);
  });

  it("size reflects the number of tracked controllers", () => {
    const registry = new AbortRegistry();
    expect(registry.size).toBe(0);

    registry.getSignal("r1");
    expect(registry.size).toBe(1);

    registry.getSignal("r2");
    expect(registry.size).toBe(2);

    registry.remove("r1");
    expect(registry.size).toBe(1);

    registry.destroyAll();
    expect(registry.size).toBe(0);
  });
});
