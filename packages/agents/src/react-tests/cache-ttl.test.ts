import { describe, expect, it, beforeEach, vi } from "vitest";
import { _testUtils } from "../react";

describe("Cache TTL", () => {
  beforeEach(() => {
    _testUtils.clearCache();
    vi.useRealTimers();
  });

  it("should respect cacheTtl of 0 (immediate expiration)", async () => {
    const key = "test-key-1";
    const promise = Promise.resolve({ token: "abc" });
    const before = Date.now();

    _testUtils.setCacheEntry(key, promise, 0);

    const after = Date.now();

    expect(_testUtils.queryCache.size).toBe(1);

    const entry = _testUtils.queryCache.get(key);
    expect(entry).toBeDefined();

    expect(entry!.expiresAt).toBeGreaterThanOrEqual(before);
    expect(entry!.expiresAt).toBeLessThanOrEqual(after);

    await new Promise((resolve) => setTimeout(resolve, 1));

    const found = _testUtils.getCacheEntry(key);
    expect(found).toBeUndefined();
  });

  it("should use default TTL of 5 minutes when cacheTtl is undefined", () => {
    const key = "test-key-2";
    const promise = Promise.resolve({ token: "xyz" });
    const before = Date.now();

    _testUtils.setCacheEntry(key, promise, undefined);

    const after = Date.now();
    const entry = _testUtils.queryCache.get(key);
    expect(entry).toBeDefined();

    const expectedMinExpiry = before + 5 * 60 * 1000;
    const expectedMaxExpiry = after + 5 * 60 * 1000;

    expect(entry!.expiresAt).toBeGreaterThanOrEqual(expectedMinExpiry);
    expect(entry!.expiresAt).toBeLessThanOrEqual(expectedMaxExpiry);

    const found = _testUtils.getCacheEntry(key);
    expect(found?.promise).toBe(promise);
  });

  it("should respect custom cacheTtl values", () => {
    const key = "test-key-3";
    const promise = Promise.resolve({ token: "123" });
    const customTtl = 60000;
    const before = Date.now();

    _testUtils.setCacheEntry(key, promise, customTtl);

    const after = Date.now();
    const entry = _testUtils.queryCache.get(key);
    expect(entry).toBeDefined();

    expect(entry!.expiresAt).toBeGreaterThanOrEqual(before + customTtl);
    expect(entry!.expiresAt).toBeLessThanOrEqual(after + customTtl);
  });

  it("should distinguish between cacheTtl of 0 and undefined", () => {
    const key1 = "zero-ttl";
    const key2 = "undefined-ttl";
    const promise1 = Promise.resolve({ a: "1" });
    const promise2 = Promise.resolve({ b: "2" });

    _testUtils.setCacheEntry(key1, promise1, 0);
    _testUtils.setCacheEntry(key2, promise2, undefined);

    const entry1 = _testUtils.queryCache.get(key1);
    const entry2 = _testUtils.queryCache.get(key2);

    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;

    expect(entry1!.expiresAt).toBeLessThanOrEqual(now);
    expect(entry2!.expiresAt).toBeGreaterThan(now + fiveMinutes - 1000);
  });
});
