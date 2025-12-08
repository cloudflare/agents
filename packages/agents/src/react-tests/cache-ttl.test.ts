import { describe, expect, it, beforeEach, vi } from "vitest";
import { _testUtils } from "../react";

describe("Cache TTL", () => {
  beforeEach(() => {
    _testUtils.clearCache();
    vi.useRealTimers();
  });

  it("should respect cacheTtl of 0 (immediate expiration)", async () => {
    const key = ["test", "default", "dep1"];
    const promise = Promise.resolve({ token: "abc" });
    const before = Date.now();

    // Set cache entry with TTL of 0
    _testUtils.setCacheEntry(key, promise, 0);

    const after = Date.now();

    // The entry should exist in the cache
    expect(_testUtils.queryCache.size).toBe(1);

    // Get the entry and check its expiresAt
    const entry = _testUtils.queryCache.get(key);
    expect(entry).toBeDefined();

    // With TTL of 0, expiresAt should be approximately Date.now() at time of creation
    // (not 5 minutes in the future which was the bug)
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(before);
    expect(entry!.expiresAt).toBeLessThanOrEqual(after);

    // Wait 1ms for the entry to expire (since check is strictly greater than)
    await new Promise((resolve) => setTimeout(resolve, 1));

    // findCacheEntry should NOT find the entry because it should be expired
    const found = _testUtils.findCacheEntry(key);
    expect(found).toBeUndefined();
  });

  it("should use default TTL of 5 minutes when cacheTtl is undefined", () => {
    const key = ["test", "default", "dep2"];
    const promise = Promise.resolve({ token: "xyz" });
    const before = Date.now();

    // Set cache entry without TTL (undefined)
    _testUtils.setCacheEntry(key, promise, undefined);

    const after = Date.now();
    const entry = _testUtils.queryCache.get(key);
    expect(entry).toBeDefined();

    // Default TTL is 5 minutes (300000ms)
    const expectedMinExpiry = before + 5 * 60 * 1000;
    const expectedMaxExpiry = after + 5 * 60 * 1000;

    expect(entry!.expiresAt).toBeGreaterThanOrEqual(expectedMinExpiry);
    expect(entry!.expiresAt).toBeLessThanOrEqual(expectedMaxExpiry);

    // Entry should be found since it hasn't expired
    const found = _testUtils.findCacheEntry(key);
    expect(found).toBe(promise);
  });

  it("should respect custom cacheTtl values", () => {
    const key = ["test", "default", "dep3"];
    const promise = Promise.resolve({ token: "123" });
    const customTtl = 60000; // 1 minute
    const before = Date.now();

    _testUtils.setCacheEntry(key, promise, customTtl);

    const after = Date.now();
    const entry = _testUtils.queryCache.get(key);
    expect(entry).toBeDefined();

    const expectedMinExpiry = before + customTtl;
    const expectedMaxExpiry = after + customTtl;

    expect(entry!.expiresAt).toBeGreaterThanOrEqual(expectedMinExpiry);
    expect(entry!.expiresAt).toBeLessThanOrEqual(expectedMaxExpiry);
  });

  it("should distinguish between cacheTtl of 0 and undefined", () => {
    const key1 = ["test", "default", "zero"];
    const key2 = ["test", "default", "undefined"];
    const promise1 = Promise.resolve({ a: "1" });
    const promise2 = Promise.resolve({ b: "2" });

    _testUtils.setCacheEntry(key1, promise1, 0);
    _testUtils.setCacheEntry(key2, promise2, undefined);

    const entry1 = _testUtils.queryCache.get(key1);
    const entry2 = _testUtils.queryCache.get(key2);

    // TTL of 0 should result in immediate expiration
    // TTL of undefined should use default (5 minutes)
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;

    // Entry with TTL=0 should have expiresAt at or before now
    expect(entry1!.expiresAt).toBeLessThanOrEqual(now);

    // Entry with TTL=undefined should have expiresAt ~5 minutes from now
    expect(entry2!.expiresAt).toBeGreaterThan(now + fiveMinutes - 1000); // Allow 1s margin
  });
});
