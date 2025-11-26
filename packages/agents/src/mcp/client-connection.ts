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
 * Connection state machine for MCP client connections.
 *
 * State transitions:
 * - Non-OAuth: init() → CONNECTING → DISCOVERING → READY
 * - OAuth: init() → AUTHENTICATING → (callback) → CONNECTING → DISCOVERING → READY
 * - Any state can transition to FAILED on error
 */
export const MCPConnectionState = {
  /** Waiting for OAuth authorization to complete */
  AUTHENTICATING: "authenticating",
  /** Establishing transport connection to MCP server */
  CONNECTING: "connecting",
  /** Transport connection established */
  CONNECTED: "connected",
  /** Discovering server capabilities (tools, resources, prompts) */
  DISCOVERING: "discovering",
  /** Fully connected and ready to use */
  READY: "ready",
  /** Connection failed at some point */
  FAILED: "failed"
} as const;

/**
 * Connection state type for MCP client connections.
 */
export type MCPConnectionState =
  (typeof MCPConnectionState)[keyof typeof MCPConnectionState];

export type MCPTransportOptions = (
  | SSEClientTransportOptions
  | StreamableHTTPClientTransportOptions
) & {
  authProvider?: AgentsOAuthProvider;
  type?: TransportType;
};

export type MCPClientConnectionResult = {
  state: MCPConnectionState;
  error?: Error;
  transport?: BaseTransportType;
};

/**
 * Result of a discovery operation.
 * success indicates whether discovery completed successfully.
 * error is present when success is false.
 */
export type MCPDiscoveryResult = {
  success: boolean;
  error?: string;
};

export class MCPClientConnection {
  client: Client;
  connectionState: MCPConnectionState = MCPConnectionState.CONNECTING;
  lastConnectedTransport: BaseTransportType | undefined;
  instructions?: string;
  tools: Tool[] = [];
  prompts: Prompt[] = [];
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  serverCapabilities: ServerCapabilities | undefined;

  /** Tracks in-flight discovery to allow cancellation */
  private _discoveryAbortController: AbortController | undefined;

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
   * Initialize a client connection, if authentication is required, the connection will be in the AUTHENTICATING state
   * Sets connection state based on the result and emits observability events
   *
   * @returns Error message if connection failed, undefined otherwise
   */
  async init(): Promise<string | undefined> {
    const transportType = this.options.transport.type;
    if (!transportType) {
      throw new Error("Transport type must be specified");
    }

    const res = await this.tryConnect(transportType);

    // Set the connection state
    this.connectionState = res.state;

    // Handle the result and emit appropriate events
    if (res.state === MCPConnectionState.CONNECTED && res.transport) {
      // Set up elicitation request handler after successful connection
      this.client.setRequestHandler(
        ElicitRequestSchema,
        async (request: ElicitRequest) => {
          return await this.handleElicitationRequest(request);
        }
      );

      this.lastConnectedTransport = res.transport;

      this._onObservabilityEvent.fire({
        type: "mcp:client:connect",
        displayMessage: `Connected successfully using ${res.transport} transport for ${this.url.toString()}`,
        payload: {
          url: this.url.toString(),
          transport: res.transport,
          state: this.connectionState
        },
        timestamp: Date.now(),
        id: nanoid()
      });
      return undefined;
    } else if (res.state === MCPConnectionState.FAILED && res.error) {
      const errorMessage = toErrorMessage(res.error);
      this._onObservabilityEvent.fire({
        type: "mcp:client:connect",
        displayMessage: `Failed to connect to ${this.url.toString()}: ${errorMessage}`,
        payload: {
          url: this.url.toString(),
          transport: transportType,
          state: this.connectionState,
          error: errorMessage
        },
        timestamp: Date.now(),
        id: nanoid()
      });
      return errorMessage;
    }
    return undefined;
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
    if (this.connectionState !== MCPConnectionState.AUTHENTICATING) {
      throw new Error(
        "Connection must be in authenticating state to complete authorization"
      );
    }

    try {
      // Finish OAuth by probing transports per configuration
      await this.finishAuthProbe(code);

      // Mark as connecting
      this.connectionState = MCPConnectionState.CONNECTING;
    } catch (error) {
      this.connectionState = MCPConnectionState.FAILED;
      throw error;
    }
  }

  /**
   * Discover server capabilities and register tools, resources, prompts, and templates.
   * This method does the work but does not manage connection state - that's handled by discover().
   */
  async discoverAndRegister(): Promise<void> {
    this.serverCapabilities = this.client.getServerCapabilities();
    if (!this.serverCapabilities) {
      throw new Error("The MCP Server failed to return server capabilities");
    }

    // Build list of operations to perform based on server capabilities
    type DiscoveryResult =
      | string
      | undefined
      | Tool[]
      | Resource[]
      | Prompt[]
      | ResourceTemplate[];
    const operations: Promise<DiscoveryResult>[] = [];
    const operationNames: string[] = [];

    // Instructions (always try to fetch if available)
    operations.push(Promise.resolve(this.client.getInstructions()));
    operationNames.push("instructions");

    // Only register capabilities that the server advertises
    if (this.serverCapabilities.tools) {
      operations.push(this.registerTools());
      operationNames.push("tools");
    }

    if (this.serverCapabilities.resources) {
      operations.push(this.registerResources());
      operationNames.push("resources");
    }

    if (this.serverCapabilities.prompts) {
      operations.push(this.registerPrompts());
      operationNames.push("prompts");
    }

    if (this.serverCapabilities.resources) {
      operations.push(this.registerResourceTemplates());
      operationNames.push("resource templates");
    }

    try {
      const results = await Promise.all(operations);
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const name = operationNames[i];

        switch (name) {
          case "instructions":
            this.instructions = result as string | undefined;
            break;
          case "tools":
            this.tools = result as Tool[];
            break;
          case "resources":
            this.resources = result as Resource[];
            break;
          case "prompts":
            this.prompts = result as Prompt[];
            break;
          case "resource templates":
            this.resourceTemplates = result as ResourceTemplate[];
            break;
        }
      }
    } catch (error) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:discover",
        displayMessage: `Failed to discover capabilities for ${this.url.toString()}: ${toErrorMessage(error)}`,
        payload: {
          url: this.url.toString(),
          error: toErrorMessage(error)
        },
        timestamp: Date.now(),
        id: nanoid()
      });

      throw error;
    }
  }

  /**
   * Discover server capabilities with timeout and cancellation support.
   * If called while a previous discovery is in-flight, the previous discovery will be aborted.
   *
   * @param options Optional configuration
   * @param options.timeoutMs Timeout in milliseconds (default: 15000)
   * @returns Result indicating success/failure with optional error message
   */
  async discover(
    options: { timeoutMs?: number } = {}
  ): Promise<MCPDiscoveryResult> {
    const { timeoutMs = 15000 } = options;

    // Check if state allows discovery
    if (
      this.connectionState !== MCPConnectionState.CONNECTED &&
      this.connectionState !== MCPConnectionState.READY
    ) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:discover",
        displayMessage: `Discovery skipped for ${this.url.toString()}, state is ${this.connectionState}`,
        payload: {
          url: this.url.toString(),
          state: this.connectionState
        },
        timestamp: Date.now(),
        id: nanoid()
      });
      return {
        success: false,
        error: `Discovery skipped - connection in ${this.connectionState} state`
      };
    }

    // Cancel any previous in-flight discovery
    if (this._discoveryAbortController) {
      this._discoveryAbortController.abort();
      this._discoveryAbortController = undefined;
    }

    // Create a new AbortController for this discovery
    const abortController = new AbortController();
    this._discoveryAbortController = abortController;

    this.connectionState = MCPConnectionState.DISCOVERING;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Discovery timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });

      // Check if aborted before starting
      if (abortController.signal.aborted) {
        throw new Error("Discovery was cancelled");
      }

      // Create an abort promise that rejects when signal fires
      const abortPromise = new Promise<never>((_, reject) => {
        abortController.signal.addEventListener("abort", () => {
          reject(new Error("Discovery was cancelled"));
        });
      });

      await Promise.race([
        this.discoverAndRegister(),
        timeoutPromise,
        abortPromise
      ]);

      // Clear timeout on success
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      // Discovery succeeded - transition to ready
      this.connectionState = MCPConnectionState.READY;

      this._onObservabilityEvent.fire({
        type: "mcp:client:discover",
        displayMessage: `Discovery completed for ${this.url.toString()}`,
        payload: {
          url: this.url.toString()
        },
        timestamp: Date.now(),
        id: nanoid()
      });

      return { success: true };
    } catch (e) {
      // Always clear the timeout
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      // Return to CONNECTED state so user can retry discovery
      this.connectionState = MCPConnectionState.CONNECTED;

      const error = e instanceof Error ? e.message : String(e);
      return { success: false, error };
    } finally {
      // Clean up the abort controller
      this._discoveryAbortController = undefined;
    }
  }

  /**
   * Cancel any in-flight discovery operation.
   * Called when closing the connection.
   */
  cancelDiscovery(): void {
    if (this._discoveryAbortController) {
      this._discoveryAbortController.abort();
      this._discoveryAbortController = undefined;
    }
  }

  /**
   * Notification handler registration for tools
   * Should only be called if serverCapabilities.tools exists
   */
  async registerTools(): Promise<Tool[]> {
    if (this.serverCapabilities?.tools?.listChanged) {
      this.client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async (_notification) => {
          this.tools = await this.fetchTools();
        }
      );
    }

    return this.fetchTools();
  }

  /**
   * Notification handler registration for resources
   * Should only be called if serverCapabilities.resources exists
   */
  async registerResources(): Promise<Resource[]> {
    if (this.serverCapabilities?.resources?.listChanged) {
      this.client.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        async (_notification) => {
          this.resources = await this.fetchResources();
        }
      );
    }

    return this.fetchResources();
  }

  /**
   * Notification handler registration for prompts
   * Should only be called if serverCapabilities.prompts exists
   */
  async registerPrompts(): Promise<Prompt[]> {
    if (this.serverCapabilities?.prompts?.listChanged) {
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

  private async tryConnect(
    transportType: TransportType
  ): Promise<MCPClientConnectionResult> {
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

        return {
          state: MCPConnectionState.CONNECTED,
          transport: currentTransportType
        };
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));

        if (isUnauthorized(error)) {
          return {
            state: MCPConnectionState.AUTHENTICATING
          };
        }

        if (isTransportNotImplemented(error) && hasFallback) {
          // Try the next transport
          continue;
        }

        return {
          state: MCPConnectionState.FAILED,
          error
        };
      }
    }

    // Should never reach here
    return {
      state: MCPConnectionState.FAILED,
      error: new Error("No transports available")
    };
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
