import type { ToolDescriptor } from "./model.js";

/** External tool providers (MCP and friends). */
export interface ExternalToolSource {
  id: string;
  /** Resolves once the source is ready to list/call tools ("waitForMcpConnections"). */
  ready(): Promise<void>;
  listTools(): Promise<ToolDescriptor[]>;
  /** Throws on failure. */
  callTool(name: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
}
