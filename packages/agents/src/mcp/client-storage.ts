import type {
  ClientCapabilities,
  DiscoverResult,
  StreamableHTTPReconnectionOptions
} from "@modelcontextprotocol/client";
import type { RetryOptions } from "../retries";
import type { McpClientOptions, TransportType } from "./types";

/**
 * Represents a row in the cf_agents_mcp_servers table.
 */
export type MCPServerRow = {
  id: string;
  name: string;
  server_url: string;
  client_id: string | null;
  auth_url: string | null;
  callback_url: string;
  server_options: string | null;
};

/** Explicitly supported durable subset of MCP SDK client options. */
export type PersistedMcpClientOptions = Pick<
  McpClientOptions,
  | "capabilities"
  | "supportedProtocolVersions"
  | "enforceStrictCapabilities"
  | "debouncedNotificationMethods"
  | "versionNegotiation"
  | "inputRequired"
  | "listMaxPages"
  | "cachePartition"
  | "defaultCacheTtlMs"
>;

export type PersistedMcpTransportOptions = {
  type?: TransportType;
  headers?: HeadersInit;
  requestInit?: RequestInit;
  reconnectionOptions?: StreamableHTTPReconnectionOptions;
  skipIssuerMetadataValidation?: boolean;
  onInsufficientScope?: "reauthorize" | "throw";
  maxStepUpRetries?: number;
  sessionId?: string;
  protocolVersion?: string;
};

export type PersistedMcpServerOptions = {
  client?: PersistedMcpClientOptions;
  transport?: PersistedMcpTransportOptions;
  discoverResult?: DiscoverResult;
  retry?: RetryOptions;
  /** Durable Object binding used to restore an RPC MCP connection. */
  bindingName?: string;
  /** Application props passed back to a restored RPC MCP connection. */
  props?: Record<string, unknown>;
  /** One-wake capability seed; handler functions remain memory-only. */
  capabilities?: ClientCapabilities;
};

type PersistableTransportOptions = PersistedMcpTransportOptions & {
  authProvider?: unknown;
  fetch?: unknown;
  reconnectionScheduler?: unknown;
  eventSourceInit?: unknown;
};

type PersistableRegistration = {
  client?: McpClientOptions;
  transport?: PersistableTransportOptions;
  discoverResult?: DiscoverResult;
  retry?: RetryOptions;
  bindingName?: string;
  props?: Record<string, unknown>;
  capabilities?: ClientCapabilities;
};

function persistClientOptions(
  client?: McpClientOptions
): PersistedMcpClientOptions | undefined {
  if (!client) return undefined;
  return {
    capabilities: client.capabilities,
    supportedProtocolVersions: client.supportedProtocolVersions,
    enforceStrictCapabilities: client.enforceStrictCapabilities,
    debouncedNotificationMethods: client.debouncedNotificationMethods,
    versionNegotiation: client.versionNegotiation,
    inputRequired: client.inputRequired,
    listMaxPages: client.listMaxPages,
    cachePartition: client.cachePartition,
    defaultCacheTtlMs: client.defaultCacheTtlMs
  };
}

function persistTransportOptions(
  value?: PersistableTransportOptions
): PersistedMcpTransportOptions | undefined {
  if (!value) return undefined;
  return {
    type: value.type,
    headers: value.headers,
    requestInit: value.requestInit,
    reconnectionOptions: value.reconnectionOptions,
    skipIssuerMetadataValidation: value.skipIssuerMetadataValidation,
    onInsufficientScope: value.onInsufficientScope,
    maxStepUpRetries: value.maxStepUpRetries,
    sessionId: value.sessionId,
    protocolVersion: value.protocolVersion
  };
}

export function encodeMcpServerOptions(
  options: PersistableRegistration
): string {
  return JSON.stringify({
    client: persistClientOptions(options.client),
    transport: persistTransportOptions(options.transport),
    discoverResult: options.discoverResult,
    retry: options.retry,
    bindingName: options.bindingName,
    props: options.props,
    capabilities: options.capabilities
  } satisfies PersistedMcpServerOptions);
}

export function decodeMcpServerOptions(
  value: string | null
): PersistedMcpServerOptions {
  if (!value) return {};
  const parsed = JSON.parse(value) as PersistedMcpServerOptions;
  const transport = persistTransportOptions(parsed.transport);
  const statelessWithoutPrior =
    transport?.protocolVersion === "2026-07-28" && !parsed.discoverResult;
  if (
    transport?.sessionId &&
    (!transport.protocolVersion || statelessWithoutPrior)
  ) {
    delete transport.sessionId;
    delete transport.protocolVersion;
    delete parsed.discoverResult;
  }
  return {
    client: persistClientOptions(parsed.client),
    transport,
    discoverResult: parsed.discoverResult,
    retry: parsed.retry,
    ...(parsed.bindingName !== undefined && {
      bindingName: parsed.bindingName
    }),
    ...(parsed.props !== undefined && { props: parsed.props }),
    capabilities: parsed.capabilities
  };
}

export function withMcpSession(
  options: PersistedMcpServerOptions,
  session?: {
    id: string;
    protocolVersion: string;
    discoverResult?: DiscoverResult;
  }
): PersistedMcpServerOptions {
  const transport = { ...(options.transport ?? {}) };
  if (!session) {
    delete transport.sessionId;
    delete transport.protocolVersion;
    const next = { ...options, transport };
    delete next.discoverResult;
    return next;
  }
  transport.sessionId = session.id;
  transport.protocolVersion = session.protocolVersion;
  return {
    ...options,
    transport,
    ...(session.discoverResult
      ? { discoverResult: session.discoverResult }
      : { discoverResult: undefined })
  };
}
