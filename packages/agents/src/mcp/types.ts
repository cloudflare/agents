export type MaybePromise<T> = T | Promise<T>;
export type MaybeConnectionTag = { role: string } | undefined;

export type BaseTransportType = "sse" | "streamable-http";
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
  jurisdiction?: DurableObjectJurisdiction;
}
