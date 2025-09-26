import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
  GetPromptRequest,
  Prompt,
  ReadResourceRequest,
  Resource,
  ResourceTemplate,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { type ToolSet, jsonSchema } from "ai";
import { nanoid } from "nanoid";
import { Emitter, type Event, DisposableStore } from "../core/events";
import type { MCPObservabilityEvent } from "../observability/mcp";
import {
  MCPClientConnection,
  type MCPTransportOptions
} from "./client-connection";
import { toErrorMessage } from "./errors";
import type { TransportType } from "./types";

export type MCPClientOAuthCallbackConfig = {
  successRedirect?: string;
  errorRedirect?: string;
  customHandler?: (result: MCPClientOAuthResult) => Response;
};

export type MCPClientOAuthResult = {
  serverId: string;
  authSuccess: boolean;
  authError?: string;
};

/**
 * Utility class that aggregates multiple MCP clients into one
 */
export class MCPClientManager {
  public mcpConnections: Record<string, MCPClientConnection> = {};
  private _callbackUrls: string[] = [];
  private _didWarnAboutUnstableGetAITools = false;
  private _oauthCallbackConfig?: MCPClientOAuthCallbackConfig;
  private _connectionDisposables = new Map<string, DisposableStore>();

  private readonly _onObservabilityEvent = new Emitter<MCPObservabilityEvent>();
  public readonly onObservabilityEvent: Event<MCPObservabilityEvent> =
    this._onObservabilityEvent.event;

  private readonly _onConnected = new Emitter<string>();
  public readonly onConnected: Event<string> = this._onConnected.event;

  /**
   * @param _name Name of the MCP client
   * @param _version Version of the MCP Client
   * @param auth Auth paramters if being used to create a DurableObjectOAuthClientProvider
   */
  constructor(
    private _name: string,
    private _version: string
  ) {}

  /**
   * Connect to and register an MCP server
   *
   * @param transportConfig Transport config
   * @param clientConfig Client config
   * @param capabilities Client capabilities (i.e. if the client supports roots/sampling)
   */
  async connect(
    url: string,
    options: {
      // Allows you to reconnect to a server (in the case of an auth reconnect)
      reconnect?: {
        // server id
        id: string;
        oauthClientId?: string;
        oauthCode?: string;
      };
      // we're overriding authProvider here because we want to be able to access the auth URL
      transport?: MCPTransportOptions;
      client?: ConstructorParameters<typeof Client>[1];
    } = {}
  ): Promise<{
    id: string;
    authUrl?: string;
    clientId?: string;
  }> {
    const id = options.reconnect?.id ?? nanoid(8);

    if (options.transport?.authProvider) {
      options.transport.authProvider.serverId = id;
      // reconnect with auth
      if (options.reconnect?.oauthClientId) {
        options.transport.authProvider.clientId =
          options.reconnect?.oauthClientId;
      }
    }

    // During OAuth reconnect, reuse existing connection to preserve state
    if (!options.reconnect?.oauthCode || !this.mcpConnections[id]) {
      const normalizedTransport = {
        ...options.transport,
        type: options.transport?.type ?? ("auto" as TransportType)
      };

      this.mcpConnections[id] = new MCPClientConnection(
        new URL(url),
        {
          name: this._name,
          version: this._version
        },
        {
          client: options.client ?? {},
          transport: normalizedTransport
        }
      );

      // Pipe connection-level observability events to the manager-level emitter
      // and track the subscription for cleanup.
      const store = new DisposableStore();
      // If we somehow already had disposables for this id, clear them first
      const existing = this._connectionDisposables.get(id);
      if (existing) existing.dispose();
      this._connectionDisposables.set(id, store);
      store.add(
        this.mcpConnections[id].onObservabilityEvent((event) => {
          this._onObservabilityEvent.fire(event);
        })
      );
    }

    // Initialize connection first
    await this.mcpConnections[id].init();

    // Handle OAuth completion if we have a reconnect code
    if (options.reconnect?.oauthCode) {
      try {
        await this.mcpConnections[id].completeAuthorization(
          options.reconnect.oauthCode
        );
        await this.mcpConnections[id].establishConnection();
      } catch (error) {
        this._onObservabilityEvent.fire({
          type: "mcp:client:connect",
          displayMessage: `Failed to complete OAuth reconnection for ${id} for ${url}`,
          payload: {
            url: url,
            transport: options.transport?.type ?? "auto",
            state: this.mcpConnections[id].connectionState,
            error: toErrorMessage(error)
          },
          timestamp: Date.now(),
          id
        });
        // Re-throw to signal failure to the caller
        throw error;
      }
    }

    // If connection is in authenticating state, return auth URL for OAuth flow
    const authUrl = options.transport?.authProvider?.authUrl;
    if (
      this.mcpConnections[id].connectionState === "authenticating" &&
      authUrl &&
      options.transport?.authProvider?.redirectUrl
    ) {
      this._callbackUrls.push(
        options.transport.authProvider.redirectUrl.toString()
      );
      return {
        authUrl,
        clientId: options.transport?.authProvider?.clientId,
        id
      };
    }

    return {
      id
    };
  }

  isCallbackRequest(req: Request): boolean {
    return (
      req.method === "GET" &&
      !!this._callbackUrls.find((url) => {
        return req.url.startsWith(url);
      })
    );
  }

  async handleCallbackRequest(req: Request) {
    const url = new URL(req.url);
    const urlMatch = this._callbackUrls.find((url) => {
      return req.url.startsWith(url);
    });
    if (!urlMatch) {
      throw new Error(
        `No callback URI match found for the request url: ${req.url}. Was the request matched with \`isCallbackRequest()\`?`
      );
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const urlParams = urlMatch.split("/");
    const serverId = urlParams[urlParams.length - 1];
    if (!code) {
      throw new Error("Unauthorized: no code provided");
    }
    if (!state) {
      throw new Error("Unauthorized: no state provided");
    }

    if (this.mcpConnections[serverId] === undefined) {
      throw new Error(`Could not find serverId: ${serverId}`);
    }

    if (this.mcpConnections[serverId].connectionState !== "authenticating") {
      throw new Error(
        "Failed to authenticate: the client isn't in the `authenticating` state"
      );
    }

    const conn = this.mcpConnections[serverId];
    if (!conn.options.transport.authProvider) {
      throw new Error(
        "Trying to finalize authentication for a server connection without an authProvider"
      );
    }

    // Get clientId from auth provider (stored during redirectToAuthorization) or fallback to state for backward compatibility
    const clientId = conn.options.transport.authProvider.clientId || state;

    // Set the OAuth credentials
    conn.options.transport.authProvider.clientId = clientId;
    conn.options.transport.authProvider.serverId = serverId;

    try {
      await conn.completeAuthorization(code);
      return {
        serverId,
        authSuccess: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        serverId,
        authSuccess: false,
        authError: errorMessage
      };
    }
  }

  /**
   * Establish connection in the background after OAuth completion
   * This method is called asynchronously and doesn't block the OAuth callback response
   * @param serverId The server ID to establish connection for
   */
  async establishConnection(serverId: string): Promise<void> {
    const conn = this.mcpConnections[serverId];
    if (!conn) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:preconnect",
        displayMessage: `Connection not found for serverId: ${serverId}`,
        payload: { serverId },
        timestamp: Date.now(),
        id: nanoid()
      });
      return;
    }

    try {
      await conn.establishConnection();
      this._onConnected.fire(serverId);
    } catch (error) {
      const url = conn.url.toString();
      this._onObservabilityEvent.fire({
        type: "mcp:client:connect",
        displayMessage: `Failed to establish connection to server ${serverId} with url ${url}`,
        payload: {
          url,
          transport: conn.options.transport.type ?? "auto",
          state: conn.connectionState,
          error: toErrorMessage(error)
        },
        timestamp: Date.now(),
        id: nanoid()
      });
    }
  }

  /**
   * Register a callback URL for OAuth handling
   * @param url The callback URL to register
   */
  registerCallbackUrl(url: string): void {
    if (!this._callbackUrls.includes(url)) {
      this._callbackUrls.push(url);
    }
  }

  /**
   * Unregister a callback URL
   * @param serverId The server ID whose callback URL should be removed
   */
  unregisterCallbackUrl(serverId: string): void {
    // Remove callback URLs that end with this serverId
    this._callbackUrls = this._callbackUrls.filter(
      (url) => !url.endsWith(`/${serverId}`)
    );
  }

  /**
   * Configure OAuth callback handling
   * @param config OAuth callback configuration
   */
  configureOAuthCallback(config: MCPClientOAuthCallbackConfig): void {
    this._oauthCallbackConfig = config;
  }

  /**
   * Get the current OAuth callback configuration
   * @returns The current OAuth callback configuration
   */
  getOAuthCallbackConfig(): MCPClientOAuthCallbackConfig | undefined {
    return this._oauthCallbackConfig;
  }

  /**
   * @returns namespaced list of tools
   */
  listTools(): NamespacedData["tools"] {
    return getNamespacedData(this.mcpConnections, "tools");
  }

  /**
   * @returns a set of tools that you can use with the AI SDK
   */
  getAITools(): ToolSet {
    return Object.fromEntries(
      getNamespacedData(this.mcpConnections, "tools").map((tool) => {
        return [
          `tool_${tool.serverId.replace(/-/g, "")}_${tool.name}`,
          {
            description: tool.description,
            execute: async (args) => {
              const result = await this.callTool({
                arguments: args,
                name: tool.name,
                serverId: tool.serverId
              });
              if (result.isError) {
                // @ts-expect-error TODO we should fix this
                throw new Error(result.content[0].text);
              }
              return result;
            },
            // @ts-expect-error drift between ai and mcp types
            inputSchema: jsonSchema(tool.inputSchema),

            outputSchema: tool.outputSchema
              ? // @ts-expect-error drift between ai and mcp types
                jsonSchema(tool.outputSchema)
              : undefined
          }
        ];
      })
    );
  }

  /**
   * @deprecated this has been renamed to getAITools(), and unstable_getAITools will be removed in the next major version
   * @returns a set of tools that you can use with the AI SDK
   */
  unstable_getAITools(): ToolSet {
    if (!this._didWarnAboutUnstableGetAITools) {
      this._didWarnAboutUnstableGetAITools = true;
      console.warn(
        "unstable_getAITools is deprecated, use getAITools instead. unstable_getAITools will be removed in the next major version."
      );
    }
    return this.getAITools();
  }

  /**
   * Closes all connections to MCP servers
   */
  async closeAllConnections() {
    const ids = Object.keys(this.mcpConnections);
    await Promise.all(
      ids.map(async (id) => {
        await this.mcpConnections[id].client.close();
      })
    );
    // Dispose all per-connection subscriptions
    for (const id of ids) {
      const store = this._connectionDisposables.get(id);
      if (store) store.dispose();
      this._connectionDisposables.delete(id);
      delete this.mcpConnections[id];
    }
  }

  /**
   * Closes a connection to an MCP server
   * @param id The id of the connection to close
   */
  async closeConnection(id: string) {
    if (!this.mcpConnections[id]) {
      throw new Error(`Connection with id "${id}" does not exist.`);
    }
    await this.mcpConnections[id].client.close();
    delete this.mcpConnections[id];

    const store = this._connectionDisposables.get(id);
    if (store) store.dispose();
    this._connectionDisposables.delete(id);
  }

  /**
   * Dispose the manager and all resources.
   */
  async dispose(): Promise<void> {
    try {
      await this.closeAllConnections();
    } finally {
      // Dispose manager-level emitters
      this._onConnected.dispose();
      this._onObservabilityEvent.dispose();
    }
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
  async callTool(
    params: CallToolRequest["params"] & { serverId: string },
    resultSchema?:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ) {
    const unqualifiedName = params.name.replace(`${params.serverId}.`, "");
    return this.mcpConnections[params.serverId].client.callTool(
      {
        ...params,
        name: unqualifiedName
      },
      resultSchema,
      options
    );
  }

  /**
   * Namespaced version of readResource
   */
  readResource(
    params: ReadResourceRequest["params"] & { serverId: string },
    options: RequestOptions
  ) {
    return this.mcpConnections[params.serverId].client.readResource(
      params,
      options
    );
  }

  /**
   * Namespaced version of getPrompt
   */
  getPrompt(
    params: GetPromptRequest["params"] & { serverId: string },
    options: RequestOptions
  ) {
    return this.mcpConnections[params.serverId].client.getPrompt(
      params,
      options
    );
  }
}

type NamespacedData = {
  tools: (Tool & { serverId: string })[];
  prompts: (Prompt & { serverId: string })[];
  resources: (Resource & { serverId: string })[];
  resourceTemplates: (ResourceTemplate & { serverId: string })[];
};

export function getNamespacedData<T extends keyof NamespacedData>(
  mcpClients: Record<string, MCPClientConnection>,
  type: T
): NamespacedData[T] {
  const sets = Object.entries(mcpClients).map(([name, conn]) => {
    return { data: conn[type], name };
  });

  const namespacedData = sets.flatMap(({ name: serverId, data }) => {
    return data.map((item) => {
      return {
        ...item,
        // we add a serverId so we can easily pull it out and send the tool call to the right server
        serverId
      };
    });
  });

  return namespacedData as NamespacedData[T]; // Type assertion needed due to TS limitations with conditional return types
}
