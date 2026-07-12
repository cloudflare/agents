/**
 * Synchronous, ordered, prefix-scannable, JSON-serializable key-value store.
 * Modeled on Durable Object storage semantics. Every domain module namespaces
 * its keys with a module prefix and never touches another module's prefix.
 */
export interface KeyValueStore {
  get<T = unknown>(key: string): T | undefined;
  put<T = unknown>(key: string, value: T): void;
  delete(key: string): boolean;
  /** Ordered by key. `prefix` filters; `limit` caps the number of results. */
  list<T = unknown>(options?: { prefix?: string; limit?: number }): Map<string, T>;
  deleteAll(options?: { prefix?: string }): number;
}

/**
 * Returns a view over `store` scoped to `prefix`: reads/writes/lists as if
 * `prefix` didn't exist, while the underlying store sees every key prefixed.
 * This is how a domain module gets "its own" storage without seeing siblings.
 */
export function scoped(store: KeyValueStore, prefix: string): KeyValueStore {
  const withPrefix = (key: string): string => `${prefix}${key}`;

  return {
    get<T>(key: string): T | undefined {
      return store.get<T>(withPrefix(key));
    },
    put<T>(key: string, value: T): void {
      store.put(withPrefix(key), value);
    },
    delete(key: string): boolean {
      return store.delete(withPrefix(key));
    },
    list<T>(options?: { prefix?: string; limit?: number }): Map<string, T> {
      const raw = store.list<T>({
        prefix: withPrefix(options?.prefix ?? ""),
        limit: options?.limit,
      });
      const result = new Map<string, T>();
      for (const [key, value] of raw) {
        result.set(key.slice(prefix.length), value);
      }
      return result;
    },
    deleteAll(options?: { prefix?: string }): number {
      return store.deleteAll({ prefix: withPrefix(options?.prefix ?? "") });
    },
  };
}
