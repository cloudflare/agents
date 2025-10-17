import type { Client } from "@modelcontextprotocol/sdk/client";
import type { McpAgent } from ".";

export type MaybePromise<T> = T | Promise<T>;
export type MaybeConnectionTag = { role: string } | undefined;

export type HttpTransportType = "sse" | "streamable-http";
export type BaseTransportType = HttpTransportType | "rpc";
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
  transport?: HttpTransportType;
}

/**
 * Client options passed to the MCP SDK Client constructor
 */
export type McpClientOptions = ConstructorParameters<typeof Client>[1];

/**
 * Transport configuration for RPC connections
 */
export interface RpcTransportOptions<
  T extends McpAgent<unknown, unknown, Record<string, unknown>> = McpAgent
> {
  /** The transport type (must be "rpc") */
  type?: "rpc";
  /** Optional custom function name on the Durable Object stub (defaults to "handleMcpMessage") */
  functionName?: string;
  /** Props to pass to the McpAgent instance */
  props?: T extends McpAgent<unknown, unknown, infer Props> ? Props : never;
}

/**
 * Transport configuration for HTTP-based connections (SSE or Streamable HTTP)
 */
export interface HttpTransportOptions {
  /** The transport type to use. "auto" will try streamable-http, then fall back to SSE */
  type?: TransportType;
  /** Additional headers to include in HTTP requests */
  headers?: HeadersInit;
}

/**
 * Options for RPC connection configuration
 */
export interface RpcConnectionOptions<
  T extends McpAgent<unknown, unknown, Record<string, unknown>> = McpAgent
> {
  /** Transport-specific options for RPC connections */
  transport?: RpcTransportOptions<T>;
  /** Client options passed to the MCP SDK Client */
  client?: McpClientOptions;
}

/**
 * Options for HTTP/SSE connection configuration
 */
export interface HttpConnectionOptions {
  /** Transport-specific options for HTTP connections */
  transport?: HttpTransportOptions;
  /** Client options passed to the MCP SDK Client */
  client?: McpClientOptions;
}

/**
 * Configuration for connecting to an MCP server via RPC transport
 */
export interface McpRpcConnectionConfig<
  T extends McpAgent<unknown, unknown, Record<string, unknown>> = McpAgent
> {
  type: "rpc";
  serverName: string;
  url: string;
  namespace: DurableObjectNamespace<T>;
  options?: RpcConnectionOptions<T>;
  reconnect?: { id: string };
}

/**
 * Configuration for connecting to an MCP server via HTTP/SSE transport
 */
export interface McpHttpConnectionConfig {
  type: "http";
  serverName: string;
  url: string;
  callbackUrl: string;
  options?: HttpConnectionOptions;
  reconnect?: {
    id: string;
    oauthClientId?: string;
  };
}

/**
 * Union type for MCP connection configuration
 */
export type McpConnectionConfig<T extends McpAgent = McpAgent> =
  | McpRpcConnectionConfig<T>
  | McpHttpConnectionConfig;
