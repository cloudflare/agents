import { AsyncLocalStorage } from "node:async_hooks";
import { RpcTarget } from "cloudflare:workers";
import type { RPCResponse, StreamingResponse } from "../index";
import type { WSMessage } from "../lifecycle";
import type { AgentPathStep } from "../sub-routing";
import type { DynamicAgentRouteMessage } from "./protocol";
import type { DynamicAgentConnectionBridgeLike } from "./types";

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

/** The operations a live-frame bridge performs on the parent's side. */
export type DynamicAgentConnectionOps = {
  send(message: WSMessage): void | Promise<void>;
  close(code?: number, reason?: string): void | Promise<void>;
  setState(state: unknown): unknown | Promise<unknown>;
  setTags(tags: readonly string[]): void | Promise<void>;
};

/**
 * Parent-side bridge handed to a child over RPC for the duration of one
 * forwarded frame: wraps the parent's view of the connection (a root-owned
 * socket, or the parent's own bridged connection when the parent is
 * itself a child) and carries the parent's broadcast entry point.
 */
export class DynamicAgentConnectionBridge
  extends RpcTarget
  implements DynamicAgentConnectionBridgeLike
{
  #ops: DynamicAgentConnectionOps;
  #broadcast?: (
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: WSMessage,
    without?: string[]
  ) => void | Promise<void>;

  constructor(
    ops: DynamicAgentConnectionOps,
    broadcast?: (
      ownerPath: ReadonlyArray<AgentPathStep>,
      message: WSMessage,
      without?: string[]
    ) => void | Promise<void>
  ) {
    super();
    this.#ops = ops;
    this.#broadcast = broadcast;
  }

  send(message: WSMessage): void | Promise<void> {
    return this.#ops.send(message);
  }

  close(code?: number, reason?: string): void | Promise<void> {
    return this.#ops.close(code, reason);
  }

  setState(state: unknown): unknown | Promise<unknown> {
    return this.#ops.setState(state);
  }

  setTags(tags: readonly string[]): void | Promise<void> {
    return this.#ops.setTags([...tags]);
  }

  broadcast(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: WSMessage,
    without?: string[]
  ): void | Promise<void> {
    return this.#broadcast?.(ownerPath, message, without);
  }
}

/**
 * Child-side bridge used after the originating frame has completed:
 * routes connection operations to the root as fresh `connection:*`
 * messages.
 */
export class RootDynamicAgentConnectionBridge implements DynamicAgentConnectionBridgeLike {
  #send: (message: DynamicAgentRouteMessage) => Promise<unknown>;
  #connectionId: string;

  constructor(
    send: (message: DynamicAgentRouteMessage) => Promise<unknown>,
    connectionId: string
  ) {
    this.#send = send;
    this.#connectionId = connectionId;
  }

  async send(message: WSMessage): Promise<void> {
    await this.#send({
      type: "connection:send",
      id: this.#connectionId,
      message
    });
  }

  async close(code?: number, reason?: string): Promise<void> {
    await this.#send({
      type: "connection:close",
      id: this.#connectionId,
      code,
      reason
    });
  }

  setState(state: unknown): Promise<unknown> {
    return this.#send({
      type: "connection:setState",
      id: this.#connectionId,
      state
    });
  }

  async setTags(tags: readonly string[]): Promise<void> {
    await this.#send({
      type: "connection:setTags",
      id: this.#connectionId,
      tags: [...tags]
    });
  }

  async broadcast(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: WSMessage,
    without?: string[]
  ): Promise<void> {
    await this.#send({
      type: "connection:broadcast",
      owner: ownerPath,
      message,
      without
    });
  }
}
