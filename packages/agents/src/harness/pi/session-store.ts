import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

/**
 * pi's session store on a Durable Object's SQLite database.
 *
 * pi owns its sessions: conversations, entries, tasks, submissions, and
 * documents live in pi's own schema, created and migrated by pi's portable
 * `SqliteStorage` through pi's own Durable Object adapter. The store keeps
 * pi's tables under a prefix, so they cannot collide with the SDK's or the
 * host's tables in the same object.
 *
 * It is the Durable Object counterpart of `agents/sessions` for a harness
 * that brings its own session model, and has nothing pi-harness specific in
 * it: any harness built on pi-durable can open its storage with it.
 */
export type PiSessionStoreOptions = {
  /**
   * Prefix for every table and index pi creates. Must not start with `_cf_`,
   * which Durable Objects reserve. Default `pi_`.
   */
  readonly prefix?: string;
};

const DEFAULT_PREFIX = "pi_";

/** Open pi-durable's storage over this object's SQLite database. */
export function openPiSessionStore(
  storage: DurableObjectStorage,
  options: PiSessionStoreOptions = {}
): Promise<SqliteStorage> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  // pi validates the prefix as a SQLite identifier; Durable Objects also
  // reserve `_cf_` in any case, which pi does not know about.
  if (prefix.toLowerCase().startsWith("_cf_")) {
    return Promise.reject(
      new Error("The pi session store prefix must not start with _cf_")
    );
  }
  return openDurableObjectSqliteStorage(storage, { prefix });
}
