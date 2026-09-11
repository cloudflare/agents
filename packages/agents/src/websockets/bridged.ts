import type { WSMessage } from "../lifecycle";

/**
 * A connection whose socket lives on another Lifecycle Object. The owner
 * bridges frames in and operations out; this capability presents it to
 * the host like any other connection.
 */
export type BridgedConnectionMeta = {
  readonly id: string;
  readonly uri: string | null;
  readonly tags: readonly string[];
  readonly state: unknown;
};

/** Operations a bridged connection performs through the socket's owner. */
export type BridgedConnectionLink = {
  send(message: WSMessage): void;
  close(code?: number, reason?: string): void;
  setState(state: unknown): void;
  setTags(tags: readonly string[]): void;
};

export type BridgedConnectionEntry = {
  readonly meta: BridgedConnectionMeta;
  readonly link: BridgedConnectionLink;
};

/**
 * Messages the WebSockets capability accepts on its route (capability id
 * `websockets`). The owner of a bridged socket sends them from its own
 * capability on the same Lifecycle.
 */
export type WebSocketsRouteMessage =
  | {
      readonly type: "bridged:sync";
      readonly connections: ReadonlyArray<BridgedConnectionEntry>;
      /** Drop bridged connections absent from `connections`. */
      readonly reset?: boolean;
    }
  | {
      readonly type: "bridged:connect";
      readonly meta: BridgedConnectionMeta;
      readonly link: BridgedConnectionLink;
      readonly request: Request;
    }
  | {
      readonly type: "bridged:message";
      readonly meta: BridgedConnectionMeta;
      readonly link: BridgedConnectionLink;
      readonly message: WSMessage;
    }
  | {
      readonly type: "bridged:close";
      readonly meta: BridgedConnectionMeta;
      readonly link: BridgedConnectionLink;
      readonly code: number;
      readonly reason: string;
      readonly wasClean: boolean;
    };

export function isWebSocketsRouteMessage(
  payload: unknown
): payload is WebSocketsRouteMessage {
  if (!payload || typeof payload !== "object") return false;
  const type = (payload as { type?: unknown }).type;
  return (
    type === "bridged:sync" ||
    type === "bridged:connect" ||
    type === "bridged:message" ||
    type === "bridged:close"
  );
}
