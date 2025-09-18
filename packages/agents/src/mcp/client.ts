import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolResultSchema,
  type CallToolRequest,
  type CompatibilityCallToolResultSchema,
  type GetPromptRequest,
  type Prompt,
  type ReadResourceRequest,
  type Resource,
  type ResourceTemplate,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { type ToolSet, jsonSchema } from "ai";
import { nanoid } from "nanoid";
import {
  MCPClientConnection,
  type MCPTransportOptions
} from "./client-connection";
import { createWalletClient, http, type Account, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { createPaymentHeader } from "x402/client";
import type { PaymentRequirements, Wallet } from "x402/types";

type X402ClientConfig = {
  network: "base" | "base-sepolia"; // TODO: look into which are supported
  account: Account | Address;
  maxPaymentValue?: bigint; // TODO: look into atomic units
  headerName?: string;
  version?: number;
};

/**
 * Utility class that aggregates multiple MCP clients into one
 */
export class MCPClientManager {
  public mcpConnections: Record<string, MCPClientConnection> = {};
  private _callbackUrls: string[] = [];
  private _didWarnAboutUnstableGetAITools = false;
  private _x402?: {
    network: "base" | "base-sepolia";
    walletClient: ReturnType<typeof createWalletClient>;
    maxPaymentValue: bigint;
    headerName: string;
    version: number;
  };

  enableX402Payments(cfg: X402ClientConfig) {
    const chain = cfg.network === "base" ? base : baseSepolia;
    const account = typeof cfg.account === "string" ? cfg.account : cfg.account; // works for Address or Account
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http()
    });
    this._x402 = {
      network: cfg.network,
      walletClient,
      maxPaymentValue: cfg.maxPaymentValue ?? 100_000n, // $0.10 in USDC (6 dp)
      headerName: cfg.headerName ?? "X-PAYMENT",
      version: cfg.version ?? 1
    };
  }

  private async _maybeCreateX402Token(
    accepts: PaymentRequirements[]
  ): Promise<string | null> {
    if (!this._x402) return null;
    if (!Array.isArray(accepts) || accepts.length === 0) return null;

    // Pick the first exact-scheme requirement that matches our network
    // (we're only setting one on the McpAgent side for now)
    const req =
      accepts.find(
        (a) => a?.scheme === "exact" && a?.network === this._x402!.network
      ) ?? accepts[0];

    if (!req || req.scheme !== "exact") return null;

    const maxAmountRequired = BigInt(req.maxAmountRequired);
    if (maxAmountRequired > this._x402.maxPaymentValue) {
      throw new Error(
        `Payment exceeds client cap: ${maxAmountRequired} > ${this._x402.maxPaymentValue}`
      );
    }

    // Let x402/client produce the opaque header
    const token = await createPaymentHeader(
      this._x402.walletClient as unknown as Wallet, // viem wallet client is compatible
      this._x402.version,
      req
    );
    return token;
  }

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

    if (!options.transport?.authProvider) {
      console.warn(
        "No authProvider provided in the transport options. This client will only support unauthenticated remote MCP Servers"
      );
    } else {
      options.transport.authProvider.serverId = id;
      // reconnect with auth
      if (options.reconnect?.oauthClientId) {
        options.transport.authProvider.clientId =
          options.reconnect?.oauthClientId;
      }
    }

    this.mcpConnections[id] = new MCPClientConnection(
      new URL(url),
      {
        name: this._name,
        version: this._version
      },
      {
        client: options.client ?? {},
        transport: options.transport ?? {}
      }
    );

    await this.mcpConnections[id].init(options.reconnect?.oauthCode);

    const authUrl = options.transport?.authProvider?.authUrl;
    if (authUrl && options.transport?.authProvider?.redirectUrl) {
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

  private async _callToolWithMeta(
    serverId: string,
    name: string,
    args: Record<string, unknown> | undefined,
    meta: Record<string, unknown>,
    resultSchema:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ) {
    const c = this.mcpConnections[serverId].client;

    // We need to set either _meta or X-PAYMENT header to pay for the tool call
    // and it's not available through `toolCall(...)`
    return c.request(
      {
        method: "tools/call",
        params: { name, arguments: args, _meta: meta }
      },
      resultSchema,
      options
    );
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
    const clientId = url.searchParams.get("state");
    const urlParams = urlMatch.split("/");
    const serverId = urlParams[urlParams.length - 1];
    if (!code) {
      throw new Error("Unauthorized: no code provided");
    }
    if (!clientId) {
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

    conn.options.transport.authProvider.clientId = clientId;
    conn.options.transport.authProvider.serverId = serverId;

    // reconnect to server with authorization
    const serverUrl = conn.url.toString();
    await this.connect(serverUrl, {
      reconnect: {
        id: serverId,
        oauthClientId: clientId,
        oauthCode: code
      },
      ...conn.options
    });

    if (this.mcpConnections[serverId].connectionState === "authenticating") {
      throw new Error("Failed to authenticate: client failed to initialize");
    }

    return { serverId };
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
          `tool_${tool.serverId}_${tool.name}`,
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
            inputSchema: jsonSchema(tool.inputSchema)
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
    return Promise.all(
      Object.values(this.mcpConnections).map(async (connection) => {
        await connection.client.close();
      })
    );
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
    options?: RequestOptions & { headers?: Record<string, string> }
  ) {
    const unqualifiedName = params.name.replace(`${params.serverId}.`, "");
    const conn = this.mcpConnections[params.serverId];
    const client = conn.client;

    let res = await client.callTool(
      {
        ...params,
        name: unqualifiedName
      },
      resultSchema,
      options
    );

    // TODO: move this to use structuredContent
    const accepts = (() => {
      try {
        const txt = (res.content as { text: string }[])[0].text;
        const parsed = txt ? JSON.parse(txt) : null;
        return parsed?.accepts;
      } catch {
        return undefined;
      }
    })();

    const isPaymentRequired =
      res?.isError && Array.isArray(accepts) && accepts.length > 0;

    // Handle retry for x402 tools
    if (isPaymentRequired && this._x402) {
      const token = await this._maybeCreateX402Token(accepts);
      if (!token) return res; // can't satisfy, return original error

      res = await this._callToolWithMeta(
        params.serverId,
        unqualifiedName,
        params.arguments,
        { "x402.payment": token },
        resultSchema ?? CallToolResultSchema,
        options
      );
    }

    return res;
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
