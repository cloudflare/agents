import type {
  Transport,
  TransportSendOptions
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo
} from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { getServerByName } from "partyserver";
import type { McpAgent } from ".";

export const RPC_DO_PREFIX = "rpc:";

function validateBatch(batch: JSONRPCMessage[]): void {
  if (batch.length === 0) {
    throw new Error("Invalid JSON-RPC batch: array must not be empty");
  }
  for (const msg of batch) {
    JSONRPCMessageSchema.parse(msg);
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
    this._stub = await getServerByName(this._namespace, doName, {
      props: this._props
    });

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

export class RPCServerTransport implements Transport {
  private _started = false;
  private _pendingResponse: JSONRPCMessage | JSONRPCMessage[] | null = null;
  private _responseResolver: (() => void) | null = null;
  private _protocolVersion?: string;
  private _timeout: number;

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
    if (this._responseResolver) {
      this._responseResolver();
      this._responseResolver = null;
    }
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions
  ): Promise<void> {
    if (!this._started) {
      throw new Error("Transport not started");
    }

    if (!this._pendingResponse) {
      this._pendingResponse = message;
    } else if (Array.isArray(this._pendingResponse)) {
      this._pendingResponse.push(message);
    } else {
      this._pendingResponse = [this._pendingResponse, message];
    }

    if (this._responseResolver) {
      const resolver = this._responseResolver;
      queueMicrotask(() => resolver());
    }
  }

  async handle(
    message: JSONRPCMessage | JSONRPCMessage[]
  ): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined> {
    if (!this._started) {
      throw new Error("Transport not started");
    }

    if (Array.isArray(message)) {
      validateBatch(message);

      const responses: JSONRPCMessage[] = [];
      for (const msg of message) {
        const response = await this.handle(msg);
        if (response !== undefined) {
          if (Array.isArray(response)) {
            responses.push(...response);
          } else {
            responses.push(response);
          }
        }
      }

      return responses.length === 0 ? undefined : responses;
    }

    JSONRPCMessageSchema.parse(message);

    this._pendingResponse = null;

    const isNotification = !("id" in message);
    if (isNotification) {
      this.onmessage?.(message);
      return undefined;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const responsePromise = new Promise<void>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        this._responseResolver = null;
        reject(
          new Error(
            `Request timeout: No response received within ${this._timeout}ms`
          )
        );
      }, this._timeout);

      this._responseResolver = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        this._responseResolver = null;
        resolve();
      };
    });

    this.onmessage?.(message);

    try {
      await responsePromise;
    } catch (error) {
      this._pendingResponse = null;
      this._responseResolver = null;
      throw error;
    }

    const response = this._pendingResponse;
    this._pendingResponse = null;

    return response ?? undefined;
  }
}
