import type { Connection } from "../lifecycle";

/**
 * Internal per-connection flags, stored inside the connection's own state
 * under `_cf_`-prefixed keys so they ride the hibernation attachment (or a
 * bridged connection's synced state) and survive a wake. The state wrapper
 * installed by {@link ensureConnectionWrapped} hides them from
 * `connection.state` and preserves them across user `setState` calls.
 *
 * Owned by the WebSockets capability; `Agent` and framework mixins reach it
 * through the capability or, for their own keys, through
 * {@link registerInternalConnectionKeys}.
 */

/** A readonly connection may not update host state. */
export const CF_READONLY_KEY = "_cf_readonly";

/**
 * A no-protocol connection receives no protocol text frames (identity,
 * state sync, MCP servers) — neither on connect nor via broadcasts.
 */
export const CF_NO_PROTOCOL_KEY = "_cf_no_protocol";

const internalKeys = new Set<string>([CF_READONLY_KEY, CF_NO_PROTOCOL_KEY]);

/**
 * Register additional `_cf_`-prefixed keys a host or mixin stores in
 * connection state, so they are hidden from `connection.state` and kept
 * across user `setState` calls like the capability's own flags.
 */
export function registerInternalConnectionKeys(...keys: string[]): void {
  for (const key of keys) internalKeys.add(key);
}

function rawHasInternalKeys(raw: Record<string, unknown>): boolean {
  for (const key of Object.keys(raw)) {
    if (internalKeys.has(key)) return true;
  }
  return false;
}

/** A copy of `raw` without internal keys, or null when no user keys remain. */
function stripInternalKeys(
  raw: Record<string, unknown>
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  let hasUserKeys = false;
  for (const key of Object.keys(raw)) {
    if (!internalKeys.has(key)) {
      result[key] = raw[key];
      hasUserKeys = true;
    }
  }
  return hasUserKeys ? result : null;
}

/** A copy containing only the internal keys present in `raw`. */
function extractInternalFlags(
  raw: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (internalKeys.has(key)) result[key] = raw[key];
  }
  return result;
}

type RawAccessors = {
  getRaw: () => Record<string, unknown> | null;
  setRaw: (state: unknown) => unknown;
};

/**
 * Per-connection raw accessors, keyed by the live connection object. The
 * map is in-memory: after hibernation it is empty, and every entry point
 * re-wraps the connection on first use.
 */
const rawStateAccessors = new WeakMap<Connection, RawAccessors>();

/**
 * Wrap `connection.state` / `connection.setState` so internal flags are
 * hidden from user code and preserved when user code sets state.
 * Idempotent, and safe to call after hibernation.
 */
export function ensureConnectionWrapped(connection: Connection): void {
  if (rawStateAccessors.has(connection)) return;

  // Hibernating connections expose attachment-backed state as a
  // configurable accessor. Virtual (bridged) connections use a data
  // property, so both projections are retained below.
  const descriptor = Object.getOwnPropertyDescriptor(connection, "state");

  let getRaw: RawAccessors["getRaw"];
  let setRaw: RawAccessors["setRaw"];

  if (descriptor?.get) {
    // Accessor property: bind the original getter. It reads the serialized
    // attachment, so it always returns the latest value after setState.
    getRaw = descriptor.get.bind(connection) as RawAccessors["getRaw"];
    setRaw = connection.setState.bind(connection);
  } else {
    // Data property: track the raw value in a closure. Reading
    // `connection.state` after the override would hit the filtered getter.
    let rawState = (connection.state ?? null) as Record<string, unknown> | null;
    getRaw = () => rawState;
    setRaw = (state: unknown) => {
      rawState = state as Record<string, unknown> | null;
      return rawState;
    };
  }

  rawStateAccessors.set(connection, { getRaw, setRaw });

  Object.defineProperty(connection, "state", {
    configurable: true,
    enumerable: true,
    get() {
      const raw = getRaw();
      if (raw != null && typeof raw === "object" && rawHasInternalKeys(raw)) {
        return stripInternalKeys(raw);
      }
      return raw;
    }
  });

  Object.defineProperty(connection, "setState", {
    configurable: true,
    writable: true,
    value(stateOrFn: unknown | ((prev: unknown) => unknown)) {
      const raw = getRaw();
      const flags =
        raw != null && typeof raw === "object"
          ? extractInternalFlags(raw as Record<string, unknown>)
          : {};
      const hasFlags = Object.keys(flags).length > 0;

      let newUserState: unknown;
      if (typeof stateOrFn === "function") {
        // The callback sees only user-visible state.
        const userVisible = hasFlags
          ? stripInternalKeys(raw as Record<string, unknown>)
          : raw;
        newUserState = (stateOrFn as (prev: unknown) => unknown)(userVisible);
      } else {
        newUserState = stateOrFn;
      }

      if (hasFlags) {
        if (newUserState != null && typeof newUserState === "object") {
          return setRaw({
            ...(newUserState as Record<string, unknown>),
            ...flags
          });
        }
        // User set null: keep just the flags.
        return setRaw(flags);
      }
      return setRaw(newUserState);
    }
  });
}

/** The raw connection state, internal flags included. */
export function getConnectionRawState(
  connection: Connection
): Record<string, unknown> | null {
  ensureConnectionWrapped(connection);
  return rawStateAccessors.get(connection)!.getRaw();
}

/** Read an internal flag from the raw connection state. */
export function getConnectionFlag(
  connection: Connection,
  key: string
): unknown {
  ensureConnectionWrapped(connection);
  return rawStateAccessors.get(connection)!.getRaw()?.[key];
}

/**
 * Write an internal flag to the raw connection state. `undefined` removes
 * the key rather than storing a dead value; the last key removed leaves
 * `null`.
 */
export function setConnectionFlag(
  connection: Connection,
  key: string,
  value: unknown
): void {
  ensureConnectionWrapped(connection);
  const accessors = rawStateAccessors.get(connection)!;
  const raw = accessors.getRaw() ?? {};
  if (value === undefined) {
    const { [key]: _, ...rest } = raw;
    accessors.setRaw(Object.keys(rest).length > 0 ? rest : null);
  } else {
    accessors.setRaw({ ...raw, [key]: value });
  }
}

export function isConnectionReadonly(connection: Connection): boolean {
  return !!getConnectionFlag(connection, CF_READONLY_KEY);
}

export function setConnectionReadonly(
  connection: Connection,
  readonly: boolean
): void {
  setConnectionFlag(connection, CF_READONLY_KEY, readonly ? true : undefined);
}

export function isConnectionProtocolEnabled(connection: Connection): boolean {
  return !getConnectionFlag(connection, CF_NO_PROTOCOL_KEY);
}

export function setConnectionProtocolEnabled(
  connection: Connection,
  enabled: boolean
): void {
  setConnectionFlag(connection, CF_NO_PROTOCOL_KEY, enabled ? undefined : true);
}
