import { use, useEffect, useMemo } from "react";

interface CacheEntry {
  promise: Promise<Record<string, unknown>>;
  timestamp: number;
  ttl: number;
}

const queryCache = new Map<string, CacheEntry>();
const cacheRefCount = new Map<string, number>();

const MAX_CACHE_SIZE = 100;
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL = 30 * 1000; // 30 seconds
let lastCleanupTime = Date.now();

function cleanupExpiredEntries(): void {
  const now = Date.now();

  // Only cleanup periodically
  if (now - lastCleanupTime < CLEANUP_INTERVAL) {
    return;
  }

  lastCleanupTime = now;

  // Remove expired entries
  for (const [key, entry] of queryCache.entries()) {
    if (entry.timestamp + entry.ttl < now) {
      queryCache.delete(key);
      cacheRefCount.delete(key);
    }
  }

  // If cache is too large, remove oldest entries
  if (queryCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(queryCache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );

    const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
    for (const [key] of toRemove) {
      // Only remove if no active references
      if ((cacheRefCount.get(key) || 0) === 0) {
        queryCache.delete(key);
        cacheRefCount.delete(key);
      }
    }
  }
}

/**
 * Generate a deterministic hash key for caching
 * Uses FNV-1a algorithm for consistent hashing
 */
export function generateCacheKey(str: string): string {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }

  // Return deterministic hash without timestamp
  return Math.abs(hash).toString(36);
}

export interface UseAsyncQueryOptions {
  cacheKey?: string;
  skipFunctionHash?: boolean;
  ttl?: number;
}

/**
 * Hook for caching and resolving async query functions
 * @param queryFn Async function that returns query parameters
 * @param deps Dependencies array for cache invalidation
 * @param options Additional options for cache management
 * @returns Resolved query object or undefined if no query function provided
 */
export function useAsyncQuery(
  queryFn: (() => Promise<Record<string, unknown>>) | undefined,
  deps: unknown[] = [],
  options: UseAsyncQueryOptions = {}
): Record<string, unknown> | undefined {
  const cacheKey = useMemo(() => {
    if (!queryFn) return null;

    if (options.cacheKey) {
      const depsHash = generateCacheKey(JSON.stringify(deps));
      return `${options.cacheKey}:${depsHash}`;
    }

    // Skip function hashing for performance if requested
    const fnHash = options.skipFunctionHash
      ? options.cacheKey || "fn_async_auth" // Use provided key or deterministic fallback
      : generateCacheKey(queryFn.toString());
    const depsHash = generateCacheKey(JSON.stringify(deps));
    return `${fnHash}:${depsHash}`;
  }, [queryFn, deps, options.cacheKey, options.skipFunctionHash]);

  const queryPromise = useMemo(() => {
    if (!queryFn || !cacheKey) return undefined;

    cleanupExpiredEntries();

    const now = Date.now();
    const cached = queryCache.get(cacheKey);

    // Check if cached entry exists and is still valid
    if (cached && cached.timestamp + cached.ttl > now) {
      return cached.promise;
    }

    // Create new cache entry
    const promise = queryFn();
    const ttl = options.ttl || DEFAULT_TTL;
    queryCache.set(cacheKey, {
      promise,
      timestamp: now,
      ttl
    });

    return promise;
  }, [queryFn, cacheKey, options.ttl]);

  // Reference counting to prevent race conditions during cleanup
  useEffect(() => {
    if (!queryPromise || !cacheKey) return;

    const currentCount = cacheRefCount.get(cacheKey) || 0;
    cacheRefCount.set(cacheKey, currentCount + 1);

    const existing = queryCache.get(cacheKey);
    if (!existing || existing.promise !== queryPromise) {
      queryCache.set(cacheKey, {
        promise: queryPromise,
        timestamp: Date.now(),
        ttl: options.ttl || DEFAULT_TTL
      });
    }

    return () => {
      const count = cacheRefCount.get(cacheKey) || 1;
      if (count <= 1) {
        cacheRefCount.delete(cacheKey);
        const cached = queryCache.get(cacheKey);
        if (cached && cached.promise === queryPromise) {
          queryCache.delete(cacheKey);
        }
      } else {
        cacheRefCount.set(cacheKey, count - 1);
      }
    };
  }, [cacheKey, queryPromise]);

  // React's use() hook will suspend if promise is pending
  return queryPromise ? use(queryPromise) : undefined;
}
