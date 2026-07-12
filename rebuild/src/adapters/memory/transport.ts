import type { Connection, ConnectionRegistry } from "../../ports/transport.js";

export interface MemoryConnection extends Connection {
  readonly sent: string[];
  readonly closed: boolean;
  /** Simulates an inbound message arriving on this connection. */
  receive(message: string): void;
  /** Registered by the app layer to handle inbound messages. Returns an unsubscribe function. */
  onReceive(fn: (message: string) => void): () => void;
}

export function createMemoryConnection(id: string, state: Record<string, unknown> = {}): MemoryConnection {
  const sent: string[] = [];
  const listeners = new Set<(message: string) => void>();
  let closed = false;

  return {
    id,
    state,
    sent,
    get closed() {
      return closed;
    },
    send(message: string): void {
      sent.push(message);
    },
    close(): void {
      closed = true;
    },
    receive(message: string): void {
      for (const fn of listeners) fn(message);
    },
    onReceive(fn: (message: string) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export interface MemoryConnectionRegistry extends ConnectionRegistry {
  add(conn: MemoryConnection): void;
  remove(id: string): void;
}

export function createMemoryConnectionRegistry(): MemoryConnectionRegistry {
  const byId = new Map<string, MemoryConnection>();

  return {
    add(conn: MemoryConnection): void {
      byId.set(conn.id, conn);
    },
    remove(id: string): void {
      byId.delete(id);
    },
    connections(): Iterable<Connection> {
      return byId.values();
    },
    get(id: string): Connection | undefined {
      return byId.get(id);
    },
    broadcast(message: string, exclude: string[] = []): void {
      const excluded = new Set(exclude);
      for (const conn of byId.values()) {
        if (!excluded.has(conn.id)) conn.send(message);
      }
    },
  };
}
