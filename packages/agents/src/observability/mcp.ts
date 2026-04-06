import type { BaseEvent } from "./base";

/**
 * MCP-specific observability events
 * These track the lifecycle of MCP connections and operations
 */
export type MCPObservabilityEvent =
  | BaseEvent<"mcp:client:preconnect", { serverId: string }>
  | BaseEvent<
      "mcp:client:connect",
      { url: string; transport: string; state: string; error?: string }
    >
  | BaseEvent<
      "mcp:client:authorize",
      {
        serverId: string;
        authUrl: string;
        clientId?: string;
      }
    >
  | BaseEvent<
      "mcp:client:discover",
      {
        url?: string;
        state?: string;
        error?: string;
        capability?: string;
      }
    >
  | BaseEvent<
      "mcp:client:close",
      {
        url: string;
        transport?: string;
        state: string;
        error?: string;
        phase?: "terminate-session" | "client-close";
      }
    >;
