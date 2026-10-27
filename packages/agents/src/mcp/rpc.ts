import type {
  JSONRPCMessage as V2JSONRPCMessage,
  MessageExtraInfo as V2MessageExtraInfo,
  Transport as V2Transport,
  TransportSendOptions as V2TransportSendOptions
} from "@modelcontextprotocol/client";
import type { Agent } from "../index";
import { getAgentByName } from "../agent-routing";
import { raceWithSignal } from "./abort";

// This module is reachable from the root `agents` entry (via MCPClientManager),
// so it must not depend on `@modelcontextprotocol/sdk` (an optional peer) or on
// the legacy `McpAgent` class. The v1 server-side transport lives in
// `./rpc-server`.

/**
 * Structural shape of a Durable Object that serves MCP over RPC, such as
 * `McpAgent`. Declared structurally so the client side does not pull the
 * legacy server (and `@modelcontextprotocol/sdk`) into its types.
 */
export type McpRpcAgent = Agent<
  Cloudflare.Env,
  unknown,
  Record<string, unknown>
> & {
  handleMcpMessage(
    message: V2JSONRPCMessage | V2JSONRPCMessage[]
  ): Promise<V2JSONRPCMessage | V2JSONRPCMessage[] | undefined>;
};

export const RPC_DO_PREFIX = "rpc:";

/** Narrow an unknown runtime binding to an MCP Durable Object namespace. */
export function isDurableObjectNamespace<
  T extends Rpc.DurableObjectBranded = McpRpcAgent
>(namespace: unknown): namespace is DurableObjectNamespace<T> {
  return (
    typeof namespace === "object" &&
    namespace !== null &&
    "newUniqueId" in namespace &&
    typeof namespace.newUniqueId === "function" &&
    "idFromName" in namespace &&
    typeof namespace.idFromName === "function"
  );
}

export interface RPCClientTransportOptions<
  T extends McpRpcAgent = McpRpcAgent
> {
  namespace: DurableObjectNamespace<T>;
  name: string;
  props?: Record<string, unknown>;
}

export class RPCClientTransport implements V2Transport {
  private _namespace: DurableObjectNamespace<McpRpcAgent>;
  private _name: string;
  private _props?: Record<string, unknown>;
  private _stub?: DurableObjectStub<McpRpcAgent>;
  private _started = false;
  private _protocolVersion?: string;

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: V2JSONRPCMessage, extra?: V2MessageExtraInfo) => void;

  constructor(options: RPCClientTransportOptions<McpRpcAgent>) {
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
    this._stub = await getAgentByName<Cloudflare.Env, McpRpcAgent>(
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
    message: V2JSONRPCMessage | V2JSONRPCMessage[],
    options?: V2TransportSendOptions
  ): Promise<void> {
    if (!this._started || !this._stub) {
      throw new Error("Transport not started");
    }

    try {
      const pending = this._stub.handleMcpMessage(message) as Promise<
        V2JSONRPCMessage | V2JSONRPCMessage[] | undefined
      >;
      const result = await raceWithSignal(pending, options?.requestSignal);

      if (!result || options?.requestSignal?.aborted) {
        return;
      }

      // The v2 client transport contract no longer uses the v1 requestInfo
      // placeholder. Correlation is carried by JSON-RPC ids in this adapter.
      const extra: V2MessageExtraInfo | undefined = undefined;

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
