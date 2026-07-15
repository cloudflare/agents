import type {
  DurableObjectStorage,
  HeadersInit
} from "@cloudflare/workers-types";
import type { ToolDescriptor } from "../../ports/model.js";
import type { ExternalToolSource } from "../../ports/tool-source.js";
import type { ToolSet } from "../../domain/tools/types.js";
import {
  MCPClientManager,
  type MCPClientManagerOptions,
  type MCPServerFilter,
  type RegisterServerOptions
} from "./vendor/mcp/client.js";
import type { TransportType } from "./vendor/mcp/types.js";

type ListedMcpTool = ReturnType<MCPClientManager["listTools"]>[number];

export interface McpToolSourceServer {
  id: string;
  name?: string;
  url: string;
  callbackUrl?: string;
  client?: RegisterServerOptions["client"];
  transport?: {
    headers?: HeadersInit;
    type?: Extract<TransportType, "sse" | "streamable-http" | "auto">;
    sessionId?: string;
  };
  authUrl?: string;
  clientId?: string;
  retry?: RegisterServerOptions["retry"];
}

export interface McpManagerLike {
  registerServer(id: string, options: RegisterServerOptions): Promise<string>;
  establishConnection(serverId: string): Promise<void>;
  waitForConnections(options?: { timeout?: number }): Promise<void>;
  listTools(filter?: MCPServerFilter): ListedMcpTool[];
  callTool(
    params: {
      serverId: string;
      name: string;
      arguments?: Record<string, unknown>;
    },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

export type McpToolSourceOptions =
  | {
      servers: McpToolSourceServer[];
      storage: DurableObjectStorage;
      manager?: never;
      clientName?: string;
      clientVersion?: string;
      createAuthProvider?: MCPClientManagerOptions["createAuthProvider"];
      readyTimeoutMs?: number;
    }
  | {
      servers?: McpToolSourceServer[];
      manager: McpManagerLike;
      readyTimeoutMs?: number;
    };

export function createMcpToolSource(
  id: string,
  options: McpToolSourceOptions
): ExternalToolSource {
  return new McpToolSource(id, options);
}

export async function toolSetFromExternalSource(
  source: ExternalToolSource
): Promise<ToolSet> {
  await source.ready();
  const descriptors = await source.listTools();
  return Object.fromEntries(
    descriptors.map((descriptor) => [
      descriptor.name,
      {
        description: descriptor.description,
        inputSchema: { jsonSchema: descriptor.inputSchema },
        execute: (input, ctx) =>
          source.callTool(descriptor.name, input, ctx.signal)
      }
    ])
  );
}

class McpToolSource implements ExternalToolSource {
  private readonly manager: McpManagerLike;
  private readonly servers: McpToolSourceServer[];
  private readonly readyTimeoutMs: number | undefined;
  private readyPromise: Promise<void> | undefined;

  constructor(
    public readonly id: string,
    options: McpToolSourceOptions
  ) {
    this.servers = options.servers ?? [];
    this.readyTimeoutMs = options.readyTimeoutMs;
    this.manager =
      "manager" in options && options.manager
        ? options.manager
        : new MCPClientManager(
            options.clientName ?? id,
            options.clientVersion ?? "0.0.0",
            {
              storage: options.storage,
              createAuthProvider: options.createAuthProvider
            }
          );
  }

  ready(): Promise<void> {
    this.readyPromise ??= this.connectConfiguredServers();
    return this.readyPromise;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return this.manager.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object" }
    }));
  }

  async callTool(
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const tool = this.findUniqueTool(name);
    const args = isRecord(input) ? input : { value: input };
    return this.manager.callTool(
      {
        serverId: tool.serverId,
        name: tool.name,
        arguments: args
      },
      undefined,
      signal ? { signal } : undefined
    );
  }

  private async connectConfiguredServers(): Promise<void> {
    await Promise.allSettled(
      this.servers.map(async (server) => {
        await this.manager.registerServer(server.id, {
          url: server.url,
          name: server.name ?? server.id,
          callbackUrl: server.callbackUrl,
          client: server.client,
          transport: server.transport,
          authUrl: server.authUrl,
          clientId: server.clientId,
          retry: server.retry
        });
        await this.manager.establishConnection(server.id);
      })
    );

    await this.manager.waitForConnections(
      this.readyTimeoutMs === undefined
        ? undefined
        : { timeout: this.readyTimeoutMs }
    );
  }

  private findUniqueTool(name: string): ListedMcpTool {
    const matches = this.manager
      .listTools()
      .filter((tool) => tool.name === name);
    if (matches.length === 0) {
      throw new Error(`Unknown MCP tool: ${name}`);
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous MCP tool name: ${name}`);
    }
    return matches[0]!;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
