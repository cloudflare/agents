import type { KeyValueStore } from "../../ports/storage.js";

export function createMemoryKeyValueStore(): KeyValueStore {
  const data = new Map<string, unknown>();

  return {
    get<T>(key: string): T | undefined {
      if (!data.has(key)) return undefined;
      return structuredClone(data.get(key)) as T;
    },
    put<T>(key: string, value: T): void {
      data.set(key, structuredClone(value));
    },
    delete(key: string): boolean {
      return data.delete(key);
    },
    list<T>(options?: { prefix?: string; limit?: number }): Map<string, T> {
      const result = new Map<string, T>();
      const keys = [...data.keys()].sort();
      for (const key of keys) {
        if (options?.prefix && !key.startsWith(options.prefix)) continue;
        result.set(key, structuredClone(data.get(key)) as T);
        if (options?.limit !== undefined && result.size >= options.limit) break;
      }
      return result;
    },
    deleteAll(options?: { prefix?: string }): number {
      let count = 0;
      for (const key of [...data.keys()]) {
        if (options?.prefix && !key.startsWith(options.prefix)) continue;
        data.delete(key);
        count++;
      }
      return count;
    },
  };
}
