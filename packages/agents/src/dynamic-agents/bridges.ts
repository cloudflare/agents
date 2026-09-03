import { AsyncLocalStorage } from "node:async_hooks";
import { RpcTarget } from "cloudflare:workers";
import type { Connection } from "../lifecycle/durable-object-lifecycle";
import type { RPCResponse, StreamingResponse } from "../index";
import type {
  RootFacetRpcSurface,
  DynamicAgentConnectionBridgeLike
} from "./types";

// ── Facet RPC reply bridging ─────────────────────────────────────────
//
// A `@callable` invoked on a facet must deliver its reply (including
// streamed chunks) onto the RPC frame that carried the request into the
// facet — not onto the root-owned native WebSocket directly. The ALS
// below carries the per-invocation reply bridge; it MUST stay a single
// module-level instance shared by the Agent host and this module, or
// reply routing silently breaks.

export function isClosedWebSocketSendError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes("WebSocket send() after close")
  );
}

type RPCReplyTarget = {
  send(message: string | ArrayBuffer | ArrayBufferView): void | Promise<void>;
};

type FacetRPCResponseDelivery = {
  sent: boolean;
  completion: Promise<void>;
};

export type DynamicAgentRpcReplyInvocationContext = {
  bridge?: DynamicAgentConnectionBridge;
};

export const dynamicAgentRpcReplyContext =
  new AsyncLocalStorage<DynamicAgentRpcReplyInvocationContext>();

export function sendFacetRpcResponseIfOpen(
  target: RPCReplyTarget,
  response: RPCResponse
): FacetRPCResponseDelivery {
  try {
    const completion = Promise.resolve(
      target.send(JSON.stringify(response))
    ).catch((error: unknown) => {
      if (!isClosedWebSocketSendError(error)) {
        console.error("[Agent] Facet RPC response delivery failed:", error);
      }
    });
    return { sent: true, completion };
  } catch (error) {
    if (isClosedWebSocketSendError(error)) {
      return { sent: false, completion: Promise.resolve() };
    }
    throw error;
  }
}

type FacetStreamingResponseDeliveryState = {
  replyTarget: RPCReplyTarget;
  pending: Set<Promise<void>>;
};

const facetStreamingResponseDeliveryStates = new WeakMap<
  StreamingResponse,
  FacetStreamingResponseDeliveryState
>();

/**
 * Mark a StreamingResponse as facet-bridged: its chunks are delivered to
 * `replyTarget` (the RPC frame that carried the request into the facet)
 * instead of the connection's native WebSocket.
 */
export function registerFacetStreamingDelivery(
  stream: StreamingResponse,
  replyTarget: RPCReplyTarget
): void {
  facetStreamingResponseDeliveryStates.set(stream, {
    replyTarget,
    pending: new Set()
  });
}

/**
 * Deliver one streamed RPC response for a facet-bridged stream, tracking
 * its completion. Returns null when the stream is not facet-bridged (the
 * caller should send on the native connection instead).
 */
export function sendFacetStreamingResponse(
  stream: StreamingResponse,
  response: RPCResponse
): boolean | null {
  const state = facetStreamingResponseDeliveryStates.get(stream);
  if (!state) return null;

  const delivery = sendFacetRpcResponseIfOpen(state.replyTarget, response);
  state.pending.add(delivery.completion);
  void delivery.completion.finally(() =>
    state.pending.delete(delivery.completion)
  );
  return delivery.sent;
}

export async function waitForFacetStreamingResponseDeliveries(
  stream: StreamingResponse
): Promise<void> {
  const state = facetStreamingResponseDeliveryStates.get(stream);
  if (!state) return;

  try {
    await Promise.all(state.pending);
  } finally {
    facetStreamingResponseDeliveryStates.delete(stream);
  }
}

/**
 * Parent-side bridge handed to a facet over RPC: wraps a live root-owned
 * `Connection` so the facet can send/close/setState on it, and carries
 * the root's broadcast entry point for facet-scoped broadcasts.
 */
export class DynamicAgentConnectionBridge
  extends RpcTarget
  implements DynamicAgentConnectionBridgeLike
{
  #connection: Connection;
  #broadcast?: (
    ownerPath: ReadonlyArray<{ className: string; name: string }>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ) => void | Promise<void>;

  constructor(
    connection: Connection,
    broadcast?: (
      ownerPath: ReadonlyArray<{ className: string; name: string }>,
      message: string | ArrayBuffer | ArrayBufferView,
      without?: string[]
    ) => void | Promise<void>
  ) {
    super();
    this.#connection = connection;
    this.#broadcast = broadcast;
  }

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    this.#connection.send(message);
  }

  close(code?: number, reason?: string): void {
    this.#connection.close(code, reason);
  }

  setState(state: unknown): unknown {
    return this.#connection.setState(state);
  }

  broadcast(
    ownerPath: ReadonlyArray<{ className: string; name: string }>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void | Promise<void> {
    return this.#broadcast?.(ownerPath, message, without);
  }
}

/**
 * Facet-side bridge used after the originating RPC frame has completed:
 * routes connection operations back to the root over a fresh RPC call.
 */
export class RootDynamicAgentConnectionBridge implements DynamicAgentConnectionBridgeLike {
  #root: RootFacetRpcSurface;
  #connectionId: string;

  constructor(root: RootFacetRpcSurface, connectionId: string) {
    this.#root = root;
    this.#connectionId = connectionId;
  }

  send(message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    return this.#root._cf_sendToSubAgentConnection(this.#connectionId, message);
  }

  close(code?: number, reason?: string): Promise<void> {
    return this.#root._cf_closeSubAgentConnection(
      this.#connectionId,
      code,
      reason
    );
  }

  setState(state: unknown): Promise<unknown> {
    return this.#root._cf_setSubAgentConnectionState(this.#connectionId, state);
  }

  broadcast(
    ownerPath: ReadonlyArray<{ className: string; name: string }>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void> {
    return this.#root._cf_broadcastToSubAgent(ownerPath, message, without);
  }
}
