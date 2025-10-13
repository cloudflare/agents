import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface MCPStub {
  handleMcpMessage(
    message: JSONRPCMessage
  ): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined>;
}

export interface RPCClientTransportOptions {
  stub: MCPStub;
  functionName?: string;
}

export class RPCClientTransport implements Transport {
  private _stub: MCPStub;
  private _functionName: string;
  private _started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options: RPCClientTransportOptions) {
    this._stub = options.stub;
    this._functionName = options.functionName ?? "handleMcpMessage";
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
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._started) {
      throw new Error("Transport not started");
    }

    try {
      const result =
        await this._stub[this._functionName as keyof MCPStub](message);

      if (!result) {
        return;
      }

      if (Array.isArray(result)) {
        for (const msg of result) {
          this.onmessage?.(msg);
        }
      } else {
        this.onmessage?.(result);
      }
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }
  }
}

export interface RPCServerTransportOptions {
  sessionId?: string;
}

export class RPCServerTransport implements Transport {
  private _started = false;
  private _pendingResponse: JSONRPCMessage | JSONRPCMessage[] | null = null;

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options?: RPCServerTransportOptions) {
    this.sessionId = options?.sessionId;
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
  }

  async send(message: JSONRPCMessage): Promise<void> {
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
  }

  async handle(
    message: JSONRPCMessage
  ): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined> {
    if (!this._started) {
      throw new Error("Transport not started");
    }

    this._pendingResponse = null;
    this.onmessage?.(message);

    const isNotification = !("id" in message);
    if (isNotification) {
      // notifications do not get responses
      return undefined;
    }

    await new Promise<void>((resolve) => {
      const checkResponse = () => {
        if (this._pendingResponse !== null) {
          resolve();
        } else {
          setTimeout(checkResponse, 10);
        }
      };
      checkResponse();
    });

    const response = this._pendingResponse;
    this._pendingResponse = null;

    return response ?? undefined;
  }
}
