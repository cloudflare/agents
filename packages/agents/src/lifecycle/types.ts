// https://stackoverflow.com/a/58993872
type ImmutablePrimitive = undefined | null | boolean | string | number;
type Immutable<T> = T extends ImmutablePrimitive
  ? T
  : T extends Array<infer U>
    ? ImmutableArray<U>
    : T extends Map<infer K, infer V>
      ? ImmutableMap<K, V>
      : T extends Set<infer M>
        ? ImmutableSet<M>
        : ImmutableObject<T>;
type ImmutableArray<T> = ReadonlyArray<Immutable<T>>;
type ImmutableMap<K, V> = ReadonlyMap<Immutable<K>, Immutable<V>>;
type ImmutableSet<T> = ReadonlySet<Immutable<T>>;
type ImmutableObject<T> = { readonly [K in keyof T]: Immutable<T[K]> };

/** Immutable state persisted in a hibernating WebSocket attachment. */
export type ConnectionState<T> = ImmutableObject<T> | null;

/** Functional update applied to a connection's current state. */
export type ConnectionSetStateFn<T> = (prevState: ConnectionState<T>) => T;

/** Context supplied when a lifecycle accepts a WebSocket connection. */
export type ConnectionContext = {
  /** Original WebSocket upgrade request. */
  request: Request;
};

/** A WebSocket managed by a Durable Object lifecycle. */
export type Connection<TState = unknown> = WebSocket & {
  /** Connection identifier */
  id: string;

  /**
   * The URL of the original WebSocket upgrade request.
   * Persisted in the WebSocket attachment so it survives hibernation.
   */
  uri: string | null;

  /**
   * Arbitrary state associated with this connection.
   * Read-only — use {@link Connection.setState} to update.
   *
   * This property is configurable, meaning it can be redefined via
   * `Object.defineProperty` by downstream consumers (e.g. the Cloudflare
   * Agents SDK) to namespace or wrap internal state storage.
   */
  state: ConnectionState<TState>;

  /**
   * Update the state associated with this connection.
   *
   * Accepts either a new state value or an updater function that receives
   * the previous state and returns the next state.
   *
   * This property is configurable, meaning it can be redefined via
   * `Object.defineProperty` by downstream consumers that provide their own
   * state projection.
   */
  setState(
    state: TState | ConnectionSetStateFn<TState> | null
  ): ConnectionState<TState>;

  /**
   * Tags returned by the owning Durable Object's `getConnectionTags` callback.
   * Always includes the connection id as the first tag.
   */
  tags: readonly string[];
};
