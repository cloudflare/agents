import type {
  Connection,
  ConnectionRegistry,
} from "../../ports/transport.js";

interface SocketAttachment {
  id: string;
  state: Record<string, unknown>;
}

/**
 * Hibernatable WebSocket connection adapter.
 *
 * The durable state bag is stored in the socket attachment, which workerd
 * limits to roughly 2 KiB. Keep it for connection-local flags and auth
 * context, not application data.
 */
export function wrapSocket(ws: WebSocket): Connection {
  const attachment = readAttachment(ws) ?? { id: "", state: {} };
  const state = attachment.state;

  function writeAttachment(): void {
    ws.serializeAttachment({ id: attachment.id, state });
  }

  return {
    id: attachment.id,
    send(message: string): void {
      ws.send(message);
    },
    close(code?: number, reason?: string): void {
      ws.close(code, reason);
    },
    state: new Proxy(state, {
      set(target, property, value): boolean {
        if (typeof property !== "string") return false;
        target[property] = value;
        writeAttachment();
        return true;
      },
      deleteProperty(target, property): boolean {
        if (typeof property !== "string") return false;
        const deleted = Reflect.deleteProperty(target, property);
        writeAttachment();
        return deleted;
      },
    }),
  };
}

/** ConnectionRegistry over `ctx.getWebSockets()`, reconstructed lazily after hibernation. */
export function createDurableConnectionRegistry(
  ctx: DurableObjectState
): ConnectionRegistry {
  function* liveConnections(): Iterable<Connection> {
    for (const socket of ctx.getWebSockets()) {
      if (!readAttachment(socket)) continue;
      yield wrapSocket(socket);
    }
  }

  return {
    connections(): Iterable<Connection> {
      return liveConnections();
    },
    get(id: string): Connection | undefined {
      const socket = ctx.getWebSockets(id)[0];
      if (!socket || !readAttachment(socket)) return undefined;
      return wrapSocket(socket);
    },
    broadcast(message: string, exclude: string[] = []): void {
      const excluded = new Set(exclude);
      for (const conn of liveConnections()) {
        if (excluded.has(conn.id)) continue;
        try {
          conn.send(message);
        } catch {
          // A closing socket must not break fan-out to the rest.
        }
      }
    },
  };
}

function readAttachment(ws: WebSocket): SocketAttachment | undefined {
  const attachment = ws.deserializeAttachment();
  if (!isRecord(attachment)) return undefined;
  if (typeof attachment.id !== "string") return undefined;
  if (!isRecord(attachment.state)) return undefined;
  return {
    id: attachment.id,
    state: attachment.state,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
