import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export type MaybePromise<T> = T | Promise<T>;
export type MaybeConnectionTag = { role: string } | undefined;

export type BaseTransportType = "sse" | "streamable-http";
export type TransportType = BaseTransportType | "auto";

/**
 * Extended Request type that includes optional authentication info.
 * Used throughout MCP transport handlers to pass auth context from middleware.
 */
export type RequestWithAuth = Request & { auth?: AuthInfo };

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
  jurisdiction?: DurableObjectJurisdiction;
}
