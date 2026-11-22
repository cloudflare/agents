/**
 * Callable RPC over a WebSocket: the request and response frames, the
 * dispatch of one request to a `@callable()` method, and
 * `StreamingResponse` for streaming methods.
 *
 * @internal
 */

import { getCallableMetadata, isCallableMethod } from "./callable-decorator";
import {
  isClosedWebSocketSendError,
  registerFacetStreamingDelivery,
  sendFacetRpcResponseIfOpen,
  sendFacetStreamingResponse,
  waitForFacetStreamingResponseDeliveries,
  type DynamicAgentConnectionBridge
} from "./dynamic-agents/bridges";
import type { Connection } from "./lifecycle/durable-object-lifecycle";
import { MessageType } from "./types";
import { serializeRpcResponse } from "./websockets/frame-limit";

/**
 * RPC request message from client
 */
export type RPCRequest = {
  type: "rpc";
  id: string;
  method: string;
  args: unknown[];
};

/**
 * RPC response message to client
 */
export type RPCResponse = {
  type: MessageType.RPC;
  id: string;
} & (
  | {
      success: true;
      result: unknown;
      done?: false;
    }
  | {
      success: true;
      result: unknown;
      done: true;
    }
  | {
      success: false;
      error: string;
    }
);

/** @internal */
export function sendRpcResponseIfOpen(
  connection: Connection,
  response: RPCResponse
): boolean {
  try {
    const { text, replaced } = serializeRpcResponse(response);
    connection.send(text);
    // A replaced frame is the call's terminal error: nothing more is sent.
    return !replaced;
  } catch (error) {
    if (isClosedWebSocketSendError(error)) return false;
    throw error;
  }
}

/**
 * Type guard for RPC request messages
 *
 * @internal
 */
export function isRPCRequest(msg: unknown): msg is RPCRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    msg.type === MessageType.RPC &&
    "id" in msg &&
    typeof msg.id === "string" &&
    "method" in msg &&
    typeof msg.method === "string" &&
    "args" in msg &&
    Array.isArray((msg as RPCRequest).args)
  );
}

/**
 * Run one RPC request against `target`'s `@callable()` method and send the
 * response (or, for a streaming method, let the method stream through a
 * `StreamingResponse`). `replyBridge` is set when the request arrived over
 * a facet bridge; replies then go back through it.
 *
 * @internal
 */
export async function dispatchCallableRpc(
  target: object,
  connection: Connection,
  parsed: RPCRequest,
  options: {
    replyBridge: DynamicAgentConnectionBridge | undefined;
    emit: (type: "rpc" | "rpc:error", payload: Record<string, unknown>) => void;
  }
): Promise<void> {
  const { replyBridge, emit } = options;
  const reply = async (response: RPCResponse) => {
    if (replyBridge) {
      await sendFacetRpcResponseIfOpen(replyBridge, response).completion;
    } else {
      sendRpcResponseIfOpen(connection, response);
    }
  };
  try {
    const { id, method, args } = parsed;
    const methodFn = (target as Record<string, unknown>)[method];
    if (typeof methodFn !== "function") {
      throw new Error(`Method ${method} does not exist`);
    }
    if (!isCallableMethod(methodFn)) {
      throw new Error(`Method ${method} is not callable`);
    }
    const metadata = getCallableMetadata(methodFn);

    if (metadata?.streaming) {
      const stream = new StreamingResponse(connection, id);
      if (replyBridge) registerFacetStreamingDelivery(stream, replyBridge);
      emit("rpc", { method, streaming: true });
      try {
        await methodFn.apply(target, [stream, ...args]);
      } catch (err) {
        console.error(`Error in streaming method "${method}":`, err);
        const message = err instanceof Error ? err.message : String(err);
        emit("rpc:error", { method, error: message });
        // Close the stream with the error if the method did not.
        if (!stream.isClosed) stream.error(message);
      }
      await waitForFacetStreamingResponseDeliveries(stream);
      return;
    }

    const result = await methodFn.apply(target, args);
    emit("rpc", { method, streaming: metadata?.streaming });
    await reply({
      done: true,
      id,
      result,
      success: true,
      type: MessageType.RPC
    });
  } catch (e) {
    await reply({
      error: e instanceof Error ? e.message : "Unknown error occurred",
      id: parsed.id,
      success: false,
      type: MessageType.RPC
    });
    console.error("RPC error:", e);
    emit("rpc:error", {
      method: parsed.method,
      error: e instanceof Error ? e.message : String(e)
    });
  }
}

/**
 * A wrapper for streaming responses in callable methods
 */
export class StreamingResponse {
  private _connection: Connection;
  private _id: string;
  private _closed = false;

  constructor(connection: Connection, id: string) {
    this._connection = connection;
    this._id = id;
  }

  private _send(response: RPCResponse): boolean {
    const sent =
      sendFacetStreamingResponse(this, response) ??
      sendRpcResponseIfOpen(this._connection, response);
    // An over-limit chunk was answered with the call's terminal error, or
    // the socket is gone: either way the stream is over.
    if (!sent) this._closed = true;
    return sent;
  }

  /**
   * Whether the stream has been closed (via end() or error())
   */
  get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Send a chunk of data to the client
   * @param chunk The data to send
   * @returns false if stream is already closed (no-op), true if sent
   */
  send(chunk: unknown): boolean {
    if (this._closed) {
      console.warn(
        "StreamingResponse.send() called after stream was closed - data not sent"
      );
      return false;
    }
    const response: RPCResponse = {
      done: false,
      id: this._id,
      result: chunk,
      success: true,
      type: MessageType.RPC
    };
    return this._send(response);
  }

  /**
   * End the stream and send the final chunk (if any)
   * @param finalChunk Optional final chunk of data to send
   * @returns false if stream is already closed (no-op), true if sent
   */
  end(finalChunk?: unknown): boolean {
    if (this._closed) {
      return false;
    }
    this._closed = true;
    const response: RPCResponse = {
      done: true,
      id: this._id,
      result: finalChunk,
      success: true,
      type: MessageType.RPC
    };
    return this._send(response);
  }

  /**
   * Send an error to the client and close the stream
   * @param message Error message to send
   * @returns false if stream is already closed (no-op), true if sent
   */
  error(message: string): boolean {
    if (this._closed) {
      return false;
    }
    this._closed = true;
    const response: RPCResponse = {
      error: message,
      id: this._id,
      success: false,
      type: MessageType.RPC
    };
    return this._send(response);
  }
}
