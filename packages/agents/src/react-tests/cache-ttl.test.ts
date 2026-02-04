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

  it("should cache with default TTL of 5 minutes", () => {
    const key = "test-key-2";
    const promise = Promise.resolve({ token: "xyz" });
    const defaultTtl = 5 * 60 * 1000;
    const before = Date.now();

    _testUtils.setCacheEntry(key, promise, defaultTtl);

    const after = Date.now();
    const entry = _testUtils.queryCache.get(key);
    expect(entry).toBeDefined();

    const expectedMinExpiry = before + defaultTtl;
    const expectedMaxExpiry = after + defaultTtl;

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

  it("should distinguish between short and long TTL", () => {
    const key1 = "short-ttl";
    const key2 = "long-ttl";
    const promise1 = Promise.resolve({ a: "1" });
    const promise2 = Promise.resolve({ b: "2" });

    const shortTtl = 1000; // 1 second
    const longTtl = 5 * 60 * 1000; // 5 minutes

    _testUtils.setCacheEntry(key1, promise1, shortTtl);
    _testUtils.setCacheEntry(key2, promise2, longTtl);

    const entry1 = _testUtils.queryCache.get(key1);
    const entry2 = _testUtils.queryCache.get(key2);

    const now = Date.now();

    expect(entry1!.expiresAt).toBeLessThanOrEqual(now + shortTtl);
    expect(entry2!.expiresAt).toBeGreaterThan(now + longTtl - 1000);
  });

  it("should return cached entry when not expired", () => {
    const key = "valid-cache";
    const promise = Promise.resolve({ token: "valid" });
    const ttl = 60000; // 1 minute

    _testUtils.setCacheEntry(key, promise, ttl);

    // Entry should be retrievable immediately
    const found = _testUtils.getCacheEntry(key);
    expect(found).toBeDefined();
    expect(found?.promise).toBe(promise);
  });

  it("should return undefined for expired entries", async () => {
    vi.useFakeTimers();
    const key = "expired-cache";
    const promise = Promise.resolve({ token: "expired" });
    const ttl = 1000; // 1 second

    _testUtils.setCacheEntry(key, promise, ttl);

    // Entry should exist initially
    expect(_testUtils.getCacheEntry(key)).toBeDefined();

    // Advance time past TTL
    vi.advanceTimersByTime(1001);

    // Entry should now be expired and removed
    const found = _testUtils.getCacheEntry(key);
    expect(found).toBeUndefined();

    // Cache should be cleaned up
    expect(_testUtils.queryCache.has(key)).toBe(false);
  });

  it("should deduplicate concurrent requests with same cache key", () => {
    const key = "dedup-key";
    const promise1 = Promise.resolve({ token: "first" });
    const promise2 = Promise.resolve({ token: "second" });
    const ttl = 60000;

    // First entry
    _testUtils.setCacheEntry(key, promise1, ttl);

    // Second entry with same key should overwrite
    _testUtils.setCacheEntry(key, promise2, ttl);

    const found = _testUtils.getCacheEntry(key);
    expect(found?.promise).toBe(promise2);
    expect(_testUtils.queryCache.size).toBe(1);
  });

  it("should delete cache entry correctly", () => {
    const key = "delete-test";
    const promise = Promise.resolve({ token: "delete-me" });

    _testUtils.setCacheEntry(key, promise, 60000);
    expect(_testUtils.queryCache.has(key)).toBe(true);

    _testUtils.deleteCacheEntry(key);
    expect(_testUtils.queryCache.has(key)).toBe(false);
    expect(_testUtils.getCacheEntry(key)).toBeUndefined();
  });

  it("should allow re-caching after deletion (simulates reconnect scenario)", () => {
    const key = "reconnect-scenario";
    const longTtl = 5 * 60 * 1000; // 5 minutes

    // Initial connection - cache the query result
    const initialPromise = Promise.resolve({ token: "initial-token" });
    _testUtils.setCacheEntry(key, initialPromise, longTtl);

    // Verify initial cache
    const cached = _testUtils.getCacheEntry(key);
    expect(cached).toBeDefined();
    expect(cached?.promise).toBe(initialPromise);

    // Simulate disconnect - delete the cache entry
    _testUtils.deleteCacheEntry(key);
    expect(_testUtils.getCacheEntry(key)).toBeUndefined();

    // Simulate reconnect - new query should be cached
    const reconnectPromise = Promise.resolve({ token: "fresh-token" });
    _testUtils.setCacheEntry(key, reconnectPromise, longTtl);

    // Verify new cache entry
    const newCached = _testUtils.getCacheEntry(key);
    expect(newCached).toBeDefined();
    expect(newCached?.promise).toBe(reconnectPromise);
    expect(newCached?.promise).not.toBe(initialPromise);
  });

  it("should handle deletion of non-existent key gracefully", () => {
    const key = "non-existent-key";

    // Should not throw
    expect(() => _testUtils.deleteCacheEntry(key)).not.toThrow();
    expect(_testUtils.getCacheEntry(key)).toBeUndefined();
  });

  it("should isolate cache entries by key (different agents/instances)", () => {
    const key1 = JSON.stringify(["agent-a", "instance-1", "dep1"]);
    const key2 = JSON.stringify(["agent-a", "instance-2", "dep1"]);
    const key3 = JSON.stringify(["agent-b", "instance-1", "dep1"]);

    const promise1 = Promise.resolve({ token: "token-1" });
    const promise2 = Promise.resolve({ token: "token-2" });
    const promise3 = Promise.resolve({ token: "token-3" });

    _testUtils.setCacheEntry(key1, promise1, 60000);
    _testUtils.setCacheEntry(key2, promise2, 60000);
    _testUtils.setCacheEntry(key3, promise3, 60000);

    expect(_testUtils.queryCache.size).toBe(3);

    // Delete only one entry (simulating one connection closing)
    _testUtils.deleteCacheEntry(key1);

    // Other entries should remain
    expect(_testUtils.getCacheEntry(key1)).toBeUndefined();
    expect(_testUtils.getCacheEntry(key2)?.promise).toBe(promise2);
    expect(_testUtils.getCacheEntry(key3)?.promise).toBe(promise3);
  });
});
