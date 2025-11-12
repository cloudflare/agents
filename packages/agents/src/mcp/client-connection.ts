import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SSEClientTransport,
  type SSEClientTransportOptions
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// Import types directly from MCP SDK
import type {
  Prompt,
  Resource,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import {
  type ClientCapabilities,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
  type ListPromptsResult,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type ListToolsResult,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  type ResourceTemplate,
  type ServerCapabilities,
  ToolListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";
import { nanoid } from "nanoid";
import { Emitter, type Event } from "../core/events";
import type { MCPObservabilityEvent } from "../observability/mcp";
import type { AgentsOAuthProvider } from "./do-oauth-client-provider";
import {
  isTransportNotImplemented,
  isUnauthorized,
  toErrorMessage
} from "./errors";
import type { BaseTransportType, TransportType } from "./types";

/**
 * Connection state for MCP client connections
 */
export type MCPConnectionState =
  | "authenticating"
  | "connecting"
  | "ready"
  | "discovering"
  | "failed";

export type MCPTransportOptions = (
  | SSEClientTransportOptions
  | StreamableHTTPClientTransportOptions
) & {
  authProvider?: AgentsOAuthProvider;
  type?: TransportType;
};

export class MCPClientConnection {
  client: Client;
  connectionState: MCPConnectionState = "connecting";
  lastConnectedTransport: BaseTransportType | undefined;
  instructions?: string;
  tools: Tool[] = [];
  prompts: Prompt[] = [];
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  serverCapabilities: ServerCapabilities | undefined;

  private readonly _onObservabilityEvent = new Emitter<MCPObservabilityEvent>();
  public readonly onObservabilityEvent: Event<MCPObservabilityEvent> =
    this._onObservabilityEvent.event;

  constructor(
    public url: URL,
    info: ConstructorParameters<typeof Client>[0],
    public options: {
      transport: MCPTransportOptions;
      client: ConstructorParameters<typeof Client>[1];
    } = { client: {}, transport: {} }
  ) {
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
   * @returns
   */
  async init() {
    const transportType = this.options.transport.type;
    if (!transportType) {
      throw new Error("Transport type must be specified");
    }

    try {
      await this.tryConnect(transportType);
    } catch (e) {
      if (isUnauthorized(e)) {
        // unauthorized, we should wait for the user to authenticate
        this.connectionState = "authenticating";
        return;
      }
      // For explicit transport mismatches or other errors, mark as failed
      // and do not throw to avoid bubbling errors to the client runtime.
      this._onObservabilityEvent.fire({
        type: "mcp:client:connect",
        displayMessage: `Connection initialization failed for ${this.url.toString()}`,
        payload: {
          url: this.url.toString(),
          transport: transportType,
          state: this.connectionState,
          error: toErrorMessage(e)
        },
        timestamp: Date.now(),
        id: nanoid()
      });
      this.connectionState = "failed";
      return;
    }

    await this.discoverAndRegister();
  }

  /**
   * Finish OAuth by probing transports based on configured type.
   * - Explicit: finish on that transport
   * - Auto: try streamable-http, then sse on 404/405/Not Implemented
   */
  private async finishAuthProbe(code: string): Promise<void> {
    if (!this.options.transport.authProvider) {
      throw new Error("No auth provider configured");
    }

    const configuredType = this.options.transport.type;
    if (!configuredType) {
      throw new Error("Transport type must be specified");
    }

    const finishAuth = async (base: BaseTransportType) => {
      const transport = this.getTransport(base);
      await transport.finishAuth(code);
    };

    if (configuredType === "sse" || configuredType === "streamable-http") {
      await finishAuth(configuredType);
      return;
    }

    // For "auto" mode, try streamable-http first, then fall back to SSE
    try {
      await finishAuth("streamable-http");
    } catch (e) {
      if (isTransportNotImplemented(e)) {
        await finishAuth("sse");
        return;
      }
      throw e;
    }
  }

  /**
   * Complete OAuth authorization
   */
  async completeAuthorization(code: string): Promise<void> {
    if (this.connectionState !== "authenticating") {
      throw new Error(
        "Connection must be in authenticating state to complete authorization"
      );
    }

    try {
      // Finish OAuth by probing transports per configuration
      await this.finishAuthProbe(code);

      // Mark as connecting
      this.connectionState = "connecting";
    } catch (error) {
      this.connectionState = "failed";
      throw error;
    }
  }

  /**
   * Establish connection after successful authorization
   */
  async establishConnection(): Promise<void> {
    if (this.connectionState !== "connecting") {
      throw new Error(
        "Connection must be in connecting state to establish connection"
      );
    }

    try {
      const transportType = this.options.transport.type;
      if (!transportType) {
        throw new Error("Transport type must be specified");
      }
      await this.tryConnect(transportType);

      await this.discoverAndRegister();
    } catch (error) {
      this.connectionState = "failed";
      throw error;
    }
  }

  /**
   * Discover server capabilities and register tools, resources, prompts, and templates
   */
  private async discoverAndRegister(): Promise<void> {
    this.connectionState = "discovering";

    this.serverCapabilities = this.client.getServerCapabilities();
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
        const url = this.url.toString();
        this._onObservabilityEvent.fire({
          type: "mcp:client:discover",
          displayMessage: `Failed to discover ${name} for ${url}`,
          payload: {
            url,
            capability: name,
            error: result.reason
          },
          timestamp: Date.now(),
          id: nanoid()
        });
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
        .catch(this._capabilityErrorHandler({ tools: [] }, "tools/list"));
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
        .catch(
          this._capabilityErrorHandler({ resources: [] }, "resources/list")
        );
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
        .catch(this._capabilityErrorHandler({ prompts: [] }, "prompts/list"));
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
          this._capabilityErrorHandler(
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
        return new StreamableHTTPClientTransport(
          this.url,
          this.options.transport as StreamableHTTPClientTransportOptions
        );
      case "sse":
        return new SSEClientTransport(
          this.url,
          this.options.transport as SSEClientTransportOptions
        );
      default:
        throw new Error(`Unsupported transport type: ${transportType}`);
    }
  }

  private async tryConnect(transportType: TransportType) {
    const transports: BaseTransportType[] =
      transportType === "auto" ? ["streamable-http", "sse"] : [transportType];

    for (const currentTransportType of transports) {
      const isLastTransport =
        currentTransportType === transports[transports.length - 1];
      const hasFallback =
        transportType === "auto" &&
        currentTransportType === "streamable-http" &&
        !isLastTransport;

      const transport = this.getTransport(currentTransportType);

      try {
        await this.client.connect(transport);
        this.lastConnectedTransport = currentTransportType;
        const url = this.url.toString();
        this._onObservabilityEvent.fire({
          type: "mcp:client:connect",
          displayMessage: `Connected successfully using ${currentTransportType} transport for ${url}`,
          payload: {
            url,
            transport: currentTransportType,
            state: this.connectionState
          },
          timestamp: Date.now(),
          id: nanoid()
        });
        break;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));

        // If unauthorized, bubble up for proper auth handling
        if (isUnauthorized(error)) {
          throw e;
        }

        if (hasFallback && isTransportNotImplemented(error)) {
          // Try the next transport silently
          const url = this.url.toString();
          this._onObservabilityEvent.fire({
            type: "mcp:client:connect",
            displayMessage: `${currentTransportType} transport not available, trying ${transports[transports.indexOf(currentTransportType) + 1]} for ${url}`,
            payload: {
              url,
              transport: currentTransportType,
              state: this.connectionState
            },
            timestamp: Date.now(),
            id: nanoid()
          });
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

  private _capabilityErrorHandler<T>(empty: T, method: string) {
    return (e: { code: number }) => {
      // server is badly behaved and returning invalid capabilities. This commonly occurs for resource templates
      if (e.code === -32601) {
        const url = this.url.toString();
        this._onObservabilityEvent.fire({
          type: "mcp:client:discover",
          displayMessage: `The server advertised support for the capability ${method.split("/")[0]}, but returned "Method not found" for '${method}' for ${url}`,
          payload: {
            url,
            capability: method.split("/")[0],
            error: toErrorMessage(e)
          },
          timestamp: Date.now(),
          id: nanoid()
        });
        return empty;
      }
      throw e;
    };
  }
}
