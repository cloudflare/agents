import type { UIMessage } from "ai";

// Custom data types for Cloudflare Agents
export interface AgentConnectionData {
  connectionId: string;
  agentId: string;
  timestamp: number;
}

export interface MCPToolData {
  serverId: string;
  serverName: string;
  executionTime?: number;
  error?: string;
}

export interface ObservabilityData {
  traceId?: string;
  requestId?: string;
  performanceMetrics?: {
    startTime: number;
    endTime?: number;
    tokensUsed?: number;
  };
}

// Custom data types for message parts
export type AgentDataTypes = {
  "agent-connection": AgentConnectionData;
  "mcp-tool-result": MCPToolData;
  observability: ObservabilityData;
};

// Custom tool types for MCP integration
export type AgentTools = {
  [K in `mcp-${string}`]: {
    input: Record<string, unknown>;
    output: unknown;
    serverId: string;
    toolName: string;
    dynamic: boolean;
  };
};

// Agent-specific UIMessage type with custom data and tools
export type AgentUIMessage = UIMessage<
  AgentConnectionData,
  AgentDataTypes,
  AgentTools
>;
