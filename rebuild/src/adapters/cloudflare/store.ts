import type { KeyValueStore } from "../../ports/storage.js";

/**
 * Durable Object KeyValueStore backed by SQLite DO `storage.kv`.
 *
 * SQLite-backed Durable Objects currently cap individual stored values at
 * 2 MiB; callers that may exceed that need to chunk above this adapter.
 * Synchronous writes are durable-before-output under workerd output gates, so
 * the synchronous port can map directly to `storage.kv`.
 *
 * The port is JSON-valued while `storage.kv` stores structured-clone values.
 * Normalizing on write keeps durable state JSON-shaped; cloning again on read
 * and list gives callers isolated snapshots.
 */
export function createDurableKeyValueStore(
  storage: DurableObjectStorage
): KeyValueStore {
  const kv = storage.kv;

  function orderedEntries<T>(options?: {
    prefix?: string;
    limit?: number;
  }): Array<[string, T]> {
    const listOptions =
      options?.prefix === undefined ? undefined : { prefix: options.prefix };
    const entries = [...kv.list<T>(listOptions)]
      .filter(
        ([key]) => options?.prefix === undefined || key.startsWith(options.prefix)
      )
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return options?.limit === undefined
      ? entries
      : entries.slice(0, options.limit);
  }

  return {
    get<T>(key: string): T | undefined {
      const value = kv.get<T>(key);
      if (value === undefined) return undefined;
      return jsonClone(value);
    },
    put<T>(key: string, value: T): void {
      kv.put(key, jsonClone(value));
    },
    delete(key: string): boolean {
      return kv.delete(key);
    },
    list<T>(options?: { prefix?: string; limit?: number }): Map<string, T> {
      const result = new Map<string, T>();
      for (const [key, value] of orderedEntries<T>(options)) {
        result.set(key, jsonClone(value));
      }
      return result;
    },
    deleteAll(options?: { prefix?: string }): number {
      let count = 0;
      for (const [key] of orderedEntries<unknown>(options)) {
        if (kv.delete(key)) count++;
      }
      return count;
    },
  };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
