import type { ClientOptions } from "@modelcontextprotocol/client";

export type MaybePromise<T> = T | Promise<T>;
export type MaybeConnectionTag = { role: string } | undefined;

export type HttpTransportType = "sse" | "streamable-http";
export type BaseTransportType = HttpTransportType | "rpc";
export type TransportType = BaseTransportType | "auto";

/**
 * Agents-owned MCP client configuration. Only these SDK behaviours are part of
 * the supported interface; new beta SDK fields are not persisted or exposed
 * accidentally.
 */
export interface McpClientOptions {
  capabilities?: ClientOptions["capabilities"];
  jsonSchemaValidator?: ClientOptions["jsonSchemaValidator"];
  versionNegotiation?: ClientOptions["versionNegotiation"];
  inputRequired?: ClientOptions["inputRequired"];
  listChanged?: ClientOptions["listChanged"];
  supportedProtocolVersions?: ClientOptions["supportedProtocolVersions"];
  enforceStrictCapabilities?: ClientOptions["enforceStrictCapabilities"];
  debouncedNotificationMethods?: ClientOptions["debouncedNotificationMethods"];
  listMaxPages?: ClientOptions["listMaxPages"];
  responseCacheStore?: ClientOptions["responseCacheStore"];
  cachePartition?: ClientOptions["cachePartition"];
  defaultCacheTtlMs?: ClientOptions["defaultCacheTtlMs"];
}

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
  transport?: TransportType;
  jurisdiction?: DurableObjectJurisdiction;
}
