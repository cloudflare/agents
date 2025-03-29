import { MCPClientConnection } from "./client-connection";

import type {
  ClientCapabilities,
  CallToolRequest,
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
  ReadResourceRequest,
  GetPromptRequest,
  Tool,
  Resource,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

/**
 * Utility class that aggregates multiple MCP clients into one
 */
export class MCPClientManager {
  public mcpConnections: Record<string, MCPClientConnection> = {};

  /**
   * Connect to and register an MCP server
   *
   * @param transportConfig Transport config
   * @param clientConfig Client config
   * @param capabilities Client capabilities (i.e. if the client supports roots/sampling)
   */
  async connectToServer(
    url: URL,
    info: ConstructorParameters<typeof Client>[0],
    opts: {
      transport: SSEClientTransportOptions;
      client: ConstructorParameters<typeof Client>[1];
      capabilities: ClientCapabilities;
    } = { transport: {}, client: {}, capabilities: {} }
  ) {
    if (info.name in this.mcpConnections) {
      throw new Error(
        `An existing MCP client has already been registered under the name "${info.name}". The MCP client name must be unique.`
      );
    }

    this.mcpConnections[info.name] = new MCPClientConnection(url, info, opts);
    await this.mcpConnections[info.name].init();
  }

  /**
   * @returns namespaced list of tools
   */
  listTools(): NamespacedData["tools"] {
    return getNamespacedData(this.mcpConnections, "tools");
  }

  /**
   * @returns namespaced list of prompts
   */
  listPrompts(): NamespacedData["prompts"] {
    return getNamespacedData(this.mcpConnections, "prompts");
  }

  /**
   * @returns namespaced list of tools
   */
  listResources(): NamespacedData["resources"] {
    return getNamespacedData(this.mcpConnections, "resources");
  }

  /**
   * @returns namespaced list of resource templates
   */
  listResourceTemplates(): NamespacedData["resourceTemplates"] {
    return getNamespacedData(this.mcpConnections, "resourceTemplates");
  }

  /**
   * Namespaced version of callTool
   */
  callTool(
    params: CallToolRequest["params"] & { serverName: string },
    resultSchema:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema,
    options: RequestOptions
  ) {
    const unqualifiedName = params.name.replace(`${params.serverName}.`, "");
    return this.mcpConnections[params.serverName].client.callTool(
      {
        ...params,
        name: unqualifiedName,
      },
      resultSchema,
      options
    );
  }

  /**
   * Namespaced version of readResource
   */
  readResource(
    params: ReadResourceRequest["params"] & { serverName: string },
    options: RequestOptions
  ) {
    return this.mcpConnections[params.serverName].client.readResource(
      params,
      options
    );
  }

  /**
   * Namespaced version of getPrompt
   */
  getPrompt(
    params: GetPromptRequest["params"] & { serverName: string },
    options: RequestOptions
  ) {
    return this.mcpConnections[params.serverName].client.getPrompt(
      params,
      options
    );
  }
}

type NamespacedData = {
  tools: (Tool & { serverName: string })[];
  prompts: (Prompt & { serverName: string })[];
  resources: (Resource & { serverName: string })[];
  resourceTemplates: (ResourceTemplate & { serverName: string })[];
};

export function getNamespacedData<T extends keyof NamespacedData>(
  mcpClients: Record<string, MCPClientConnection>,
  type: T
): NamespacedData[T] {
  const sets = Object.entries(mcpClients).map(([name, conn]) => {
    return { name, data: conn[type] };
  });

  const namespacedData = sets.flatMap(({ name: serverName, data }) => {
    return data.map((item) => {
      return {
        ...item,
        // we add a servername so we can easily pull it out and convert between qualified<->unqualified name
        // just in case the server name or item name includes a "."
        serverName: `${serverName}`,
        // qualified name
        name: `${serverName}.${item.name}`,
      };
    });
  });

  return namespacedData as NamespacedData[T]; // Type assertion needed due to TS limitations with conditional return types
}
