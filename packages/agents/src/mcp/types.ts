import type { Client } from "@modelcontextprotocol/sdk/client";
import type { McpAgent } from ".";

export type MaybePromise<T> = T | Promise<T>;
export type MaybeConnectionTag = { role: string } | undefined;

export type BaseTransportType = "sse" | "streamable-http" | "rpc";
export type TransportType = BaseTransportType | "auto";

export interface CORSOptions {
  origin?: string;
  methods?: string;
  headers?: string;
  maxAge?: number;
  exposeHeaders?: string;
}

export interface ServeOptions {
  binding?: string;
  corsOptions?: CORSOptions;
  transport?: BaseTransportType;
}

/**
 * Configuration for connecting to an MCP server via RPC transport
 */
export type McpRpcConnectionConfig<
  T extends McpAgent<unknown, unknown, Record<string, unknown>> = McpAgent
> = {
  type: "rpc";
  serverName: string;
  url: string;
  namespace: DurableObjectNamespace<T>;
  options?: {
    functionName?: string;
    client?: ConstructorParameters<typeof Client>[1];
    props?: T extends McpAgent<unknown, unknown, infer Props> ? Props : never;
  };
  reconnect?: { id: string };
};

/**
 * Configuration for connecting to an MCP server via HTTP/SSE transport
 */
export type McpHttpConnectionConfig = {
  type: "http";
  serverName: string;
  url: string;
  callbackUrl: string;
  options?: {
    client?: ConstructorParameters<typeof Client>[1];
    transport?: {
      headers?: HeadersInit;
      type?: TransportType;
    };
  };
  reconnect?: {
    id: string;
    oauthClientId?: string;
  };
};

/**
 * Union type for MCP connection configuration
 */
export type McpConnectionConfig<T extends McpAgent = McpAgent> =
  | McpRpcConnectionConfig<T>
  | McpHttpConnectionConfig;
