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

export type ConnectionState<T> = ImmutableObject<T> | null;
export type ConnectionSetStateFn<T> = (prevState: ConnectionState<T>) => T;

export type ConnectionContext = {
  request: Request;
};

/** A WebSocket connected to the Server */
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
   * `Object.defineProperty` by downstream consumers. If you redefine
   * `state` and `setState`, you are responsible for calling
   * `serializeAttachment` / `deserializeAttachment` yourself if you need
   * the state to survive hibernation.
   */
  setState(
    state: TState | ConnectionSetStateFn<TState> | null
  ): ConnectionState<TState>;

  /**
   * @deprecated use {@link Connection.setState} instead.
   *
   * Low-level method to persist data in the connection's attachment storage.
   * This property is configurable and can be redefined by downstream
   * consumers that need to wrap or namespace the underlying storage.
   */
  serializeAttachment<T = unknown>(attachment: T): void;

  /**
   * @deprecated use {@link Connection.state} instead.
   *
   * Low-level method to read data from the connection's attachment storage.
   * This property is configurable and can be redefined by downstream
   * consumers that need to wrap or namespace the underlying storage.
   */
  deserializeAttachment<T = unknown>(): T | null;

  /**
   * Tags assigned to this connection via {@link Server.getConnectionTags}.
   * Always includes the connection id as the first tag.
   */
  tags: readonly string[];

  /**
   * @deprecated Use `this.name` on the Server instead.
   * The server name. Populated from `Server.name` after initialization.
   */
  server: string;
};
