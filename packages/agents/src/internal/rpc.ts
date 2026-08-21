import type { Connection } from "../lifecycle/types";
import { MessageType } from "../types";

/** RPC request message sent by an Agent client. */
export type RPCRequest = {
  type: "rpc";
  id: string;
  method: string;
  args: unknown[];
};

/** State update message sent by an Agent client. */
export type StateUpdateMessage = {
  type: MessageType.CF_AGENT_STATE;
  state: unknown;
};

/** RPC response message sent to an Agent client. */
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

/** Metadata attached to a method exposed through Agent RPC. */
export type CallableMetadata = {
  /** Optional description of what the callable method does. */
  description?: string;
  /** Whether the callable method supports streaming responses. */
  streaming?: boolean;
};

/** @internal Metadata registered by the callable decorator. */
export const callableMetadata = new WeakMap<Function, CallableMetadata>();

/**
 * Decorate an Agent method so clients may invoke it through RPC.
 *
 * @param metadata - Description and streaming behavior for the method.
 * @returns A stage-three method decorator.
 */
export function callable(metadata: CallableMetadata = {}) {
  return function callableDecorator<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    _context: ClassMethodDecoratorContext
  ) {
    if (!callableMetadata.has(target)) {
      callableMetadata.set(target, metadata);
    }

    return target;
  };
}

let didWarnAboutUnstableCallable = false;

/**
 * Decorate an Agent method so clients may invoke it through RPC.
 *
 * @deprecated Use {@link callable}. This alias will be removed in the next
 * major version.
 * @param metadata - Description and streaming behavior for the method.
 * @returns A stage-three method decorator.
 */
export const unstable_callable = (metadata: CallableMetadata = {}) => {
  if (!didWarnAboutUnstableCallable) {
    didWarnAboutUnstableCallable = true;
    console.warn(
      "unstable_callable is deprecated, use callable instead. unstable_callable will be removed in the next major version."
    );
  }
  return callable(metadata);
};

/** @internal Whether an unknown WebSocket payload is an Agent RPC request. */
export function isRPCRequest(message: unknown): message is RPCRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === MessageType.RPC &&
    "id" in message &&
    typeof message.id === "string" &&
    "method" in message &&
    typeof message.method === "string" &&
    "args" in message &&
    Array.isArray(message.args)
  );
}

/** @internal Whether an unknown WebSocket payload is an Agent state update. */
export function isStateUpdateMessage(
  message: unknown
): message is StateUpdateMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === MessageType.CF_AGENT_STATE &&
    "state" in message
  );
}

function isClosedWebSocketSendError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes("WebSocket send() after close")
  );
}

/** @internal Send an RPC response unless the WebSocket has already closed. */
export function sendRpcResponseIfOpen(
  connection: Connection,
  response: RPCResponse
): boolean {
  try {
    connection.send(JSON.stringify(response));
    return true;
  } catch (error) {
    if (isClosedWebSocketSendError(error)) return false;
    throw error;
  }
}

/** A server-side stream injected into an Agent method marked as streaming. */
export class StreamingResponse {
  private _connection: Connection;
  private _id: string;
  private _closed = false;

  /**
   * Create a response stream for one RPC request.
   *
   * @param connection - Client connection receiving stream frames.
   * @param id - RPC request identifier.
   */
  constructor(connection: Connection, id: string) {
    this._connection = connection;
    this._id = id;
  }

  /** Whether the stream has ended or failed. */
  get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Send a non-terminal chunk.
   *
   * @param chunk - Serializable stream value.
   * @returns `false` when the stream or connection is already closed.
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
    return sendRpcResponseIfOpen(this._connection, response);
  }

  /**
   * End the stream, optionally with a final value.
   *
   * @param finalChunk - Optional terminal stream value.
   * @returns `false` when the stream or connection is already closed.
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
    return sendRpcResponseIfOpen(this._connection, response);
  }

  /**
   * Fail the stream and send the error to the client.
   *
   * @param message - Error text sent in the terminal RPC frame.
   * @returns `false` when the stream or connection is already closed.
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
    return sendRpcResponseIfOpen(this._connection, response);
  }
}
