import type {
  Transport,
  TransportSendOptions
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo
} from "@modelcontextprotocol/sdk/types.js";
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  JSONRPCMessageSchema
} from "@modelcontextprotocol/sdk/types.js";
import { getServerByName } from "partyserver";
import type { McpAgent } from ".";

export const RPC_DO_PREFIX = "rpc:";

function makeInvalidRequestError(id: unknown): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32600,
      message: "Invalid Request"
    }
  } as JSONRPCMessage;
}

function validateBatch(batch: JSONRPCMessage[]): void {
  if (batch.length === 0) {
    throw new Error("Invalid JSON-RPC batch: array must not be empty");
  }
}

export interface RPCClientTransportOptions<T extends McpAgent = McpAgent> {
  namespace: DurableObjectNamespace<T>;
  name: string;
  props?: Record<string, unknown>;
}

export class RPCClientTransport implements Transport {
  private _namespace: DurableObjectNamespace<McpAgent>;
  private _name: string;
  private _props?: Record<string, unknown>;
  private _stub?: DurableObjectStub<McpAgent>;
  private _started = false;
  private _protocolVersion?: string;

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  constructor(options: RPCClientTransportOptions<McpAgent>) {
    this._namespace = options.namespace;
    this._name = options.name;
    this._props = options.props;
  }

  setProtocolVersion(version: string): void {
    this._protocolVersion = version;
  }

  getProtocolVersion(): string | undefined {
    return this._protocolVersion;
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Transport already started");
    }

    const doName = `${RPC_DO_PREFIX}${this._name}`;
    this._stub = await getServerByName<Cloudflare.Env, McpAgent>(
      this._namespace,
      doName,
      { props: this._props }
    );

    this._started = true;
  }

  async close(): Promise<void> {
    this._started = false;
    this._stub = undefined;
    this.onclose?.();
  }

  async send(
    message: JSONRPCMessage | JSONRPCMessage[],
    options?: TransportSendOptions
  ): Promise<void> {
    if (!this._started || !this._stub) {
      throw new Error("Transport not started");
    }

    try {
      const result: JSONRPCMessage | JSONRPCMessage[] | undefined =
        await this._stub.handleMcpMessage(message);

      if (!result) {
        return;
      }

      const extra: MessageExtraInfo | undefined = options?.relatedRequestId
        ? { requestInfo: { headers: {} } }
        : undefined;

      const messages = Array.isArray(result) ? result : [result];
      for (const msg of messages) {
        this.onmessage?.(msg, extra);
      }
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }
  }
}

export interface RPCServerTransportOptions {
  timeout?: number;
}

type PendingRPCResponse = {
  messages: JSONRPCMessage[];
  resolve: (response: JSONRPCMessage | JSONRPCMessage[] | undefined) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export class RPCServerTransport implements Transport {
  private _started = false;
  private _protocolVersion?: string;
  private _timeout: number;
  private _pendingRequests = new Map<string, PendingRPCResponse>();
  private _pendingContinuations: PendingRPCResponse[] = [];

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  constructor(options?: RPCServerTransportOptions) {
    this._timeout = options?.timeout ?? 60000;
  }

  setProtocolVersion(version: string): void {
    this._protocolVersion = version;
  }

  getProtocolVersion(): string | undefined {
    return this._protocolVersion;
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  async close(): Promise<void> {
    this._started = false;
    this.onclose?.();

    const error = new Error("Transport closed");
    for (const pending of this._pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this._pendingRequests.clear();

    for (const pending of this._pendingContinuations) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this._pendingContinuations = [];
  }

  private _makeTimeout(onTimeout: () => void): ReturnType<typeof setTimeout> {
    return setTimeout(onTimeout, this._timeout);
  }

  private _appendPending(
    pending: PendingRPCResponse,
    message: JSONRPCMessage
  ): void {
    pending.messages.push(message);
  }

  private _completePending(
    pending: PendingRPCResponse,
    message: JSONRPCMessage
  ): void {
    pending.messages.push(message);
    clearTimeout(pending.timeoutId);

    const messages = pending.messages;
    queueMicrotask(() => {
      pending.resolve(messages.length === 1 ? messages[0] : messages);
    });
  }

  private _completeRequest(key: string, message: JSONRPCMessage): boolean {
    const pending = this._pendingRequests.get(key);
    if (!pending) return false;

    this._pendingRequests.delete(key);
    this._completePending(pending, message);
    return true;
  }

  private _appendRequest(key: string, message: JSONRPCMessage): boolean {
    const pending = this._pendingRequests.get(key);
    if (!pending) return false;

    this._appendPending(pending, message);
    return true;
  }

  private _completeContinuation(message: JSONRPCMessage): boolean {
    const pending = this._pendingContinuations.shift();
    if (!pending) return false;

    this._completePending(pending, message);
    return true;
  }

  private _appendContinuation(message: JSONRPCMessage): boolean {
    const pending = this._pendingContinuations[0];
    if (!pending) return false;

    this._appendPending(pending, message);
    return true;
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions
  ): Promise<void> {
    if (!this._started) {
      throw new Error("Transport not started");
    }

    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      const id = message.id;
      if (id === undefined) {
        this.onerror?.(
          new Error(`RPC response missing id: ${JSON.stringify(message)}`)
        );
        return;
      }

      if (this._completeRequest(id.toString(), message)) {
        return;
      }

      if (this._completeContinuation(message)) {
        return;
      }

      this.onerror?.(
        new Error(
          `No pending RPC request found for response: ${JSON.stringify(message)}`
        )
      );
      return;
    }

    const relatedRequestId = options?.relatedRequestId?.toString();
    const expectsResponse = "id" in message;

    if (relatedRequestId) {
      if (expectsResponse) {
        if (this._completeRequest(relatedRequestId, message)) return;
      } else if (this._appendRequest(relatedRequestId, message)) {
        return;
      }
    }

    if (expectsResponse) {
      if (this._completeContinuation(message)) return;
    } else if (this._appendContinuation(message)) {
      return;
    }

    this.onerror?.(
      new Error(
        `No pending RPC request found for message: ${JSON.stringify(message)}`
      )
    );
  }

  /**
   * @internal Called by McpAgent.handleMcpMessage() — not for external use.
   *
   * Wait for the next unmatched send() call that expects a client response or
   * completes a resumed tool call.
   *
   * Used after resolving an elicitation response: the original tool call has
   * already returned the elicitation request to the RPC client, and the resumed
   * tool handler will eventually send the final tool result. That final response
   * has the original tool request id, so there is no active handle() waiter left
   * for id-based routing; this continuation waiter receives it instead.
   */
  async _awaitPendingResponse(): Promise<
    JSONRPCMessage | JSONRPCMessage[] | undefined
  > {
    if (!this._started) {
      throw new Error("Transport not started");
    }

    return await new Promise<JSONRPCMessage | JSONRPCMessage[] | undefined>(
      (resolve, reject) => {
        const pending: PendingRPCResponse = {
          messages: [],
          resolve,
          reject,
          timeoutId: this._makeTimeout(() => {
            const index = this._pendingContinuations.indexOf(pending);
            if (index !== -1) {
              this._pendingContinuations.splice(index, 1);
            }
            reject(
              new Error(
                `Request timeout: No response received within ${this._timeout}ms`
              )
            );
          })
        };
        this._pendingContinuations.push(pending);
      }
    );
  }

  async handle(
    message: JSONRPCMessage | JSONRPCMessage[]
  ): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined> {
    if (!this._started) {
      throw new Error("Transport not started");
    }

    if (Array.isArray(message)) {
      validateBatch(message);

      const responses = await Promise.all(
        message.map((msg) => this.handle(msg))
      );
      const flattened = responses.flatMap((response) => {
        if (response === undefined) return [];
        return Array.isArray(response) ? response : [response];
      });

      return flattened.length === 0 ? undefined : flattened;
    }

    try {
      JSONRPCMessageSchema.parse(message);
    } catch {
      const id =
        typeof message === "object" && message !== null && "id" in message
          ? (message as { id: unknown }).id
          : null;
      return makeInvalidRequestError(id);
    }

    const isNotification = !("id" in message);
    if (isNotification) {
      this.onmessage?.(message);
      return undefined;
    }

    const id = message.id?.toString();
    if (!id) {
      return makeInvalidRequestError(message.id);
    }

    if (this._pendingRequests.has(id)) {
      throw new Error(`Duplicate pending RPC request id: ${id}`);
    }

    const responsePromise = new Promise<
      JSONRPCMessage | JSONRPCMessage[] | undefined
    >((resolve, reject) => {
      const pending: PendingRPCResponse = {
        messages: [],
        resolve,
        reject,
        timeoutId: this._makeTimeout(() => {
          this._pendingRequests.delete(id);
          reject(
            new Error(
              `Request timeout: No response received within ${this._timeout}ms`
            )
          );
        })
      };

      this._pendingRequests.set(id, pending);
    });

    this.onmessage?.(message);

    return await responsePromise;
  }
}
