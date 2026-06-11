/**
 * KvHost polyfill over Durable Object storage. Lives behind the
 * platform-shaped {@link KvHost} interface so a future runtime-native
 * implementation can replace it without touching consumers.
 */

import type { KvHost } from "./host";

export class StorageKv implements KvHost {
  private readonly _storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this._storage = storage;
  }

  get<T = unknown>(key: string): Promise<T | undefined> {
    return this._storage.get<T>(key);
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    await this._storage.put(key, value);
  }

  async delete(key: string): Promise<void> {
    await this._storage.delete(key);
  }

  list<T = unknown>(prefix: string): Promise<Map<string, T>> {
    return this._storage.list<T>({ prefix });
  }
}
