/** Abstraction of a single WebSocket-like connection. */
export interface Connection {
  readonly id: string;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  /** Per-connection attachment (readonly flags, auth context, etc.). */
  readonly state: Record<string, unknown>;
}

/** Abstraction of the set of live connections to an agent instance. */
export interface ConnectionRegistry {
  connections(): Iterable<Connection>;
  get(id: string): Connection | undefined;
  broadcast(message: string, exclude?: string[]): void;
}
