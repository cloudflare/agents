import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type ClientCapabilities,
  type ListPromptsResult,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type ListToolsResult,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  type ResourceTemplate,
  type ServerCapabilities,
  ToolListChangedNotificationSchema,
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentsOAuthProvider } from "./do-oauth-client-provider";
import { SSEEdgeClientTransport } from "./sse-edge";
import type { BaseTransportType, TransportType } from "./types";
import { StreamableHTTPEdgeClientTransport } from "./streamable-http-edge";
// Import types directly from MCP SDK
import type {
  Tool,
  Resource,
  Prompt
} from "@modelcontextprotocol/sdk/types.js";

export type MCPTransportOptions = (
  | SSEClientTransportOptions
  | StreamableHTTPClientTransportOptions
) & {
  authProvider?: AgentsOAuthProvider;
  type?: TransportType;
};

export class MCPClientConnection {
  client: Client;
  connectionState:
    | "authenticating"
    | "connecting"
    | "ready"
    | "discovering"
    | "failed" = "connecting";
  instructions?: string;
  tools: Tool[] = [];
  prompts: Prompt[] = [];
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  serverCapabilities: ServerCapabilities | undefined;

  constructor(
    public url: URL,
    info: ConstructorParameters<typeof Client>[0],
    public options: {
      transport: MCPTransportOptions;
      client: ConstructorParameters<typeof Client>[1];
    } = { client: {}, transport: {} }
  ) {
    this.url = url;

    const clientOptions = {
      ...options.client,
      capabilities: {
        ...options.client?.capabilities,
        elicitation: {}
      } as ClientCapabilities
    };

    this.client = new Client(info, clientOptions);
  }

  /**
   * Initialize a client connection
   *
   * @param code Optional OAuth code to initialize the connection with if auth hasn't been initialized
   * @returns
   */
  async init(code?: string) {
    try {
      const transportType = this.options.transport.type || "streamable-http";
      await this.tryConnect(transportType, code);
      // biome-ignore lint/suspicious/noExplicitAny: allow for the error check here
    } catch (e: any) {
      if (e.toString().includes("Unauthorized")) {
        // unauthorized, we should wait for the user to authenticate
        this.connectionState = "authenticating";
        return;
      }
      this.connectionState = "failed";
      throw e;
    }

    this.connectionState = "discovering";

    this.serverCapabilities = await this.client.getServerCapabilities();
    if (!this.serverCapabilities) {
      throw new Error("The MCP Server failed to return server capabilities");
    }

    const [
      instructionsResult,
      toolsResult,
      resourcesResult,
      promptsResult,
      resourceTemplatesResult
    ] = await Promise.allSettled([
      this.client.getInstructions(),
      this.registerTools(),
      this.registerResources(),
      this.registerPrompts(),
      this.registerResourceTemplates()
    ]);

    const operations = [
      { name: "instructions", result: instructionsResult },
      { name: "tools", result: toolsResult },
      { name: "resources", result: resourcesResult },
      { name: "prompts", result: promptsResult },
      { name: "resource templates", result: resourceTemplatesResult }
    ];

    for (const { name, result } of operations) {
      if (result.status === "rejected") {
        console.error(`Failed to initialize ${name}:`, result.reason);
      }
    }

    this.instructions =
      instructionsResult.status === "fulfilled"
        ? instructionsResult.value
        : undefined;
    this.tools = toolsResult.status === "fulfilled" ? toolsResult.value : [];
    this.resources =
      resourcesResult.status === "fulfilled" ? resourcesResult.value : [];
    this.prompts =
      promptsResult.status === "fulfilled" ? promptsResult.value : [];
    this.resourceTemplates =
      resourceTemplatesResult.status === "fulfilled"
        ? resourceTemplatesResult.value
        : [];

    this.connectionState = "ready";
  }

  /**
   * Notification handler registration
   */
  async registerTools(): Promise<Tool[]> {
    if (!this.serverCapabilities || !this.serverCapabilities.tools) {
      return [];
    }

    if (this.serverCapabilities.tools.listChanged) {
      this.client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async (_notification) => {
          this.tools = await this.fetchTools();
        }
      );
    }

    return this.fetchTools();
  }

  async registerResources(): Promise<Resource[]> {
    if (!this.serverCapabilities || !this.serverCapabilities.resources) {
      return [];
    }

    if (this.serverCapabilities.resources.listChanged) {
      this.client.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        async (_notification) => {
          this.resources = await this.fetchResources();
        }
      );
    }

    return this.fetchResources();
  }

  async registerPrompts(): Promise<Prompt[]> {
    if (!this.serverCapabilities || !this.serverCapabilities.prompts) {
      return [];
    }

    if (this.serverCapabilities.prompts.listChanged) {
      this.client.setNotificationHandler(
        PromptListChangedNotificationSchema,
        async (_notification) => {
          this.prompts = await this.fetchPrompts();
        }
      );
    }

    return this.fetchPrompts();
  }

  async registerResourceTemplates(): Promise<ResourceTemplate[]> {
    if (!this.serverCapabilities || !this.serverCapabilities.resources) {
      return [];
    }

    return this.fetchResourceTemplates();
  }

  async fetchTools() {
    let toolsAgg: Tool[] = [];
    let toolsResult: ListToolsResult = { tools: [] };
    do {
      toolsResult = await this.client
        .listTools({
          cursor: toolsResult.nextCursor
        })
        .catch(capabilityErrorHandler({ tools: [] }, "tools/list"));
      toolsAgg = toolsAgg.concat(toolsResult.tools);
    } while (toolsResult.nextCursor);
    return toolsAgg;
  }

  async fetchResources() {
    let resourcesAgg: Resource[] = [];
    let resourcesResult: ListResourcesResult = { resources: [] };
    do {
      resourcesResult = await this.client
        .listResources({
          cursor: resourcesResult.nextCursor
        })
        .catch(capabilityErrorHandler({ resources: [] }, "resources/list"));
      resourcesAgg = resourcesAgg.concat(resourcesResult.resources);
    } while (resourcesResult.nextCursor);
    return resourcesAgg;
  }

  async fetchPrompts() {
    let promptsAgg: Prompt[] = [];
    let promptsResult: ListPromptsResult = { prompts: [] };
    do {
      promptsResult = await this.client
        .listPrompts({
          cursor: promptsResult.nextCursor
        })
        .catch(capabilityErrorHandler({ prompts: [] }, "prompts/list"));
      promptsAgg = promptsAgg.concat(promptsResult.prompts);
    } while (promptsResult.nextCursor);
    return promptsAgg;
  }

  async fetchResourceTemplates() {
    let templatesAgg: ResourceTemplate[] = [];
    let templatesResult: ListResourceTemplatesResult = {
      resourceTemplates: []
    };
    do {
      templatesResult = await this.client
        .listResourceTemplates({
          cursor: templatesResult.nextCursor
        })
        .catch(
          capabilityErrorHandler(
            { resourceTemplates: [] },
            "resources/templates/list"
          )
        );
      templatesAgg = templatesAgg.concat(templatesResult.resourceTemplates);
    } while (templatesResult.nextCursor);
    return templatesAgg;
  }

  /**
   * Handle elicitation request from server
   * Automatically uses the Agent's built-in elicitation handling if available
   */
  async handleElicitationRequest(
    _request: ElicitRequest
  ): Promise<ElicitResult> {
    // Elicitation handling must be implemented by the platform
    // For MCP servers, this should be handled by McpAgent.elicitInput()
    throw new Error(
      "Elicitation handler must be implemented for your platform. Override handleElicitationRequest method."
    );
  }
  /**
   * Get the transport for the client
   * @param transportType - The transport type to get
   * @returns The transport for the client
   */
  getTransport(transportType: BaseTransportType) {
    switch (transportType) {
      case "streamable-http":
        return new StreamableHTTPEdgeClientTransport(
          this.url,
          this.options.transport as StreamableHTTPClientTransportOptions
        );
      case "sse":
        return new SSEEdgeClientTransport(
          this.url,
          this.options.transport as SSEClientTransportOptions
        );
      default:
        throw new Error(`Unsupported transport type: ${transportType}`);
    }
  }

  private async tryConnect(transportType: TransportType, code?: string) {
    // When completing OAuth (with code), use the transport that initiated OAuth
    let effectiveTransportType = transportType;
    if (code && this.options.transport.authProvider) {
      const savedTransport =
        await this.options.transport.authProvider.getOAuthTransport();
      if (savedTransport) {
        effectiveTransportType = savedTransport as TransportType;
      }
    }

    const transports: BaseTransportType[] =
      effectiveTransportType === "auto"
        ? ["streamable-http", "sse"]
        : [effectiveTransportType];

    for (const currentTransportType of transports) {
      const isLastTransport =
        currentTransportType === transports[transports.length - 1];
      const hasFallback =
        effectiveTransportType === "auto" &&
        currentTransportType === "streamable-http" &&
        !isLastTransport;

      const transport = this.getTransport(currentTransportType);

      if (code) {
        await transport.finishAuth(code);
      }

      try {
        await this.client.connect(transport);

        // Clear saved transport after successful OAuth completion
        if (code && this.options.transport.authProvider) {
          await this.options.transport.authProvider.clearOAuthTransport();
        }

        break;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));

        // Save transport type when OAuth is needed (Unauthorized error)
        // This must happen BEFORE we throw or continue
        if (
          !code &&
          error.message.includes("Unauthorized") &&
          this.options.transport.authProvider &&
          currentTransportType
        ) {
          await this.options.transport.authProvider.saveOAuthTransport(
            currentTransportType
          );
          throw e; // Re-throw after storing transport
        }

        if (
          hasFallback &&
          (error.message.includes("404") || error.message.includes("405"))
        ) {
          // try the next transport if we have a fallback
          continue;
        }

        throw e;
      }
    }

    // Set up elicitation request handler
    this.client.setRequestHandler(
      ElicitRequestSchema,
      async (request: ElicitRequest) => {
        return await this.handleElicitationRequest(request);
      }
    );
  }
}

function capabilityErrorHandler<T>(empty: T, method: string) {
  return (e: { code: number }) => {
    // server is badly behaved and returning invalid capabilities. This commonly occurs for resource templates
    if (e.code === -32601) {
      console.error(
        `The server advertised support for the capability ${method.split("/")[0]}, but returned "Method not found" for '${method}'.`
      );
      return empty;
    }
    throw e;
  };
}
