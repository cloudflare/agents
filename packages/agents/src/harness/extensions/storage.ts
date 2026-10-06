import type { ExtensionStorage } from "./extension";
import type { JsonValue } from "./schema";

/**
 * The synchronous key-value store extension state lives in. A Durable
 * Object's `ctx.storage.kv` is one; `memoryKeyValueStore()` is another, for
 * tests and for harnesses with no durable storage.
 */
export type KeyValueStore = {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list(options: { readonly prefix: string }): Iterable<[string, unknown]>;
};

/**
 * An in-memory `KeyValueStore`. Nothing in it survives the process.
 *
 * @returns An empty store.
 */
export function memoryKeyValueStore(): KeyValueStore {
  const entries = new Map<string, unknown>();
  return {
    get: (key) => entries.get(key),
    put: (key, value) => {
      entries.set(key, structuredClone(value));
    },
    delete: (key) => entries.delete(key),
    *list({ prefix }) {
      for (const key of [...entries.keys()].sort()) {
        if (key.startsWith(prefix)) yield [key, entries.get(key)];
      }
    }
  };
}

/**
 * `ExtensionStorage` for one namespace, over a store. Keys are
 * `ext/<namespace>/k/<key>` and, per session,
 * `ext/<namespace>/s/<session>/<key>`, each part URI-encoded so no key can
 * reach another namespace's.
 *
 * @param store - Where the values live.
 * @param namespace - The extension's namespace.
 * @returns Storage scoped to the namespace.
 */
export function extensionStorage(
  store: KeyValueStore,
  namespace: string
): ExtensionStorage {
  const base = `ext/${encodeURIComponent(namespace)}/`;
  return scoped(store, `${base}k/`, (session) =>
    scoped(store, `${base}s/${encodeURIComponent(session)}/`, undefined)
  );
}

/**
 * Delete every extension's state for one session, as a harness does when
 * it deletes the session.
 *
 * @param store - Where extension state lives.
 * @param session - The deleted session.
 */
export function deleteSessionStorage(
  store: KeyValueStore,
  session: string
): void {
  const encoded = encodeURIComponent(session);
  for (const [key] of [...store.list({ prefix: "ext/" })]) {
    // ext/<namespace>/s/<session>/<key>: namespace and session are encoded,
    // so the first four segments are exactly these.
    const [, , scope, owner] = key.split("/");
    if (scope === "s" && owner === encoded) store.delete(key);
  }
}

function scoped(
  store: KeyValueStore,
  prefix: string,
  session: ((id: string) => ExtensionStorage) | undefined
): ExtensionStorage {
  return {
    get<T extends JsonValue>(key: string): T | undefined {
      // SAFETY: put() only accepts JsonValue, and nothing else writes under
      // this prefix, so a stored value is the JSON a caller put. The type
      // parameter is the caller's claim about which JSON it put.
      return store.get(prefix + key) as T | undefined;
    },
    put: (key, value) => store.put(prefix + key, value),
    delete: (key) => store.delete(prefix + key),
    list(keyPrefix = "") {
      const entries: (readonly [string, JsonValue])[] = [];
      for (const [key, value] of store.list({ prefix: prefix + keyPrefix })) {
        // SAFETY: as in get(), every value under this prefix was put() as JSON.
        entries.push([key.slice(prefix.length), value as JsonValue]);
      }
      return entries;
    },
    session: (id) => {
      if (!session) {
        throw new Error("Session storage cannot be scoped to a session again");
      }
      return session(id);
    }
  };
}
