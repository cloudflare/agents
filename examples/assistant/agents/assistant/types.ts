import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
}

export interface DirectoryState {
  chats: ChatSummary[];
}

/**
 * Tool descriptor the directory returns to children over RPC. Mirrors
 * what `MCPClientManager.listTools()` returns: an MCP SDK `Tool` plus
 * the `serverId` annotation so the child can build a `callMcpTool`
 * closure, while staying structured-cloneable for the DO RPC boundary.
 */
export type McpToolDescriptor = Tool & { serverId: string };

export type AgentConfig = {
  modelTier: "fast" | "capable";
  persona: string;
};
