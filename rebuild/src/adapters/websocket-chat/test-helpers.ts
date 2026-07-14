import { createMemoryConnection } from "../memory/transport.js";
import type { MemoryConnectionRegistry } from "../memory/transport.js";
import type { ChatTransport } from "./adapter.js";

/**
 * `connectChatClient` (audit 25 §6): a test-only WS chat client over a
 * `MemoryConnection`. The audit sketches this as `connectChatClient(agent)`,
 * but a bare agent isn't enough to open a *second* connection into the same
 * chat session — fan-out/exclusion/resume tests need multiple connections
 * sharing one `attachChatTransport` + registry. So this takes the already
 * attached `transport` and its backing `registry` explicitly: call
 * `attachChatTransport` once per test, then `connectChatClient` as many
 * times as you need connections.
 */
export interface ChatTestClient {
  readonly id: string;
  /** Sends one frame (JSON-encoded) as if the client had written it to the socket. */
  send(frame: unknown): Promise<void>;
  /** Every frame this connection has received so far, JSON-decoded, in arrival order. */
  readonly frames: unknown[];
  close(): void;
}

let connectionCounter = 0;

export async function connectChatClient(
  transport: ChatTransport,
  registry: MemoryConnectionRegistry,
  options?: { connectionId?: string; state?: Record<string, unknown> },
): Promise<ChatTestClient> {
  const id = options?.connectionId ?? `conn_${++connectionCounter}`;
  const conn = createMemoryConnection(id, options?.state);
  registry.add(conn);

  await transport.onConnect(conn);

  return {
    id,
    async send(frame: unknown): Promise<void> {
      await transport.onMessage(conn, JSON.stringify(frame));
    },
    get frames(): unknown[] {
      return conn.sent.map((raw) => JSON.parse(raw));
    },
    close(): void {
      transport.onClose(conn);
      registry.remove(conn.id);
      conn.close();
    },
  };
}
