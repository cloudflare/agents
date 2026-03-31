/**
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * !! WARNING: EXPERIMENTAL — DO NOT USE IN PRODUCTION                  !!
 * !!                                                                   !!
 * !! This API is under active development and WILL break between       !!
 * !! releases. Google's WebMCP API (navigator.modelContext) is still   !!
 * !! in early preview and subject to change.                           !!
 * !!                                                                   !!
 * !! If you use this, pin your agents version and expect to rewrite    !!
 * !! your code when upgrading.                                         !!
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *
 * WebMCP adapter for Cloudflare Agents SDK.
 *
 * Bridges tools registered on an McpAgent server to Chrome's native
 * navigator.modelContext API, so browser-native agents can discover
 * and call them without extra infrastructure.
 *
 * Usage:
 *   import { registerWebMcp } from "agents/experimental/webmcp";
 *
 *   // One-liner — discovers tools from your Agent's MCP endpoint
 *   // and registers them with navigator.modelContext
 *   const handle = await registerWebMcp({ url: "/mcp" });
 *
 *   // Later, to clean up:
 *   handle.dispose();
 *
 * @experimental This API is not yet stable and may change.
 */

interface ModelContextToolAnnotations {
  readOnlyHint?: boolean;
}

interface ModelContextClient {
  requestUserInteraction(callback: () => Promise<unknown>): Promise<unknown>;
}

interface ModelContextTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (
    input: Record<string, unknown>,
    client: ModelContextClient
  ) => Promise<unknown>;
  annotations?: ModelContextToolAnnotations;
}

interface ModelContext {
  registerTool(tool: ModelContextTool): void;
  unregisterTool(name: string): void;
}

declare global {
  interface Navigator {
    modelContext?: ModelContext;
  }
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

interface McpToolCallResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

class McpHttpClient {
  private _client: Client;
  private _transport: StreamableHTTPClientTransport;
  private _onToolsChanged?: () => void;

  constructor(
    url: string,
    headers?: Record<string, string>,
    getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
  ) {
    const resolvedUrl = new URL(url, globalThis.location?.origin);

    const transportOptions: ConstructorParameters<
      typeof StreamableHTTPClientTransport
    >[1] = {
      requestInit: { headers: headers ?? {} }
    };

    if (getHeaders) {
      transportOptions.fetch = async (input, init) => {
        const dynamic = await getHeaders();
        return globalThis.fetch(input, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            ...dynamic
          }
        });
      };
    }

    this._transport = new StreamableHTTPClientTransport(
      resolvedUrl,
      transportOptions
    );

    this._client = new Client(
      { name: "webmcp-adapter", version: "0.1.0" },
      { capabilities: {} }
    );
  }

  async initialize(): Promise<void> {
    await this._client.connect(this._transport);

    this._client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        this._onToolsChanged?.();
      }
    );
  }

  async listTools(): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this._client.listTools(
        cursor ? { cursor } : undefined
      );
      for (const t of result.tools) {
        allTools.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown> | undefined,
          annotations: t.annotations
            ? { readOnlyHint: t.annotations.readOnlyHint }
            : undefined
        });
      }
      cursor = result.nextCursor;
    } while (cursor);
    return allTools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    const result = await this._client.callTool({ name, arguments: args });
    if ("content" in result) {
      return {
        content: (
          result.content as Array<{
            type: string;
            text?: string;
            data?: string;
          }>
        ).map((c) => ({
          type: c.type,
          text: "text" in c ? (c.text as string) : undefined,
          data: "data" in c ? (c.data as string) : undefined,
          mimeType: "mimeType" in c ? (c.mimeType as string) : undefined
        })),
        isError: "isError" in result ? (result.isError as boolean) : false
      };
    }
    return { content: [], isError: false };
  }

  listenForChanges(onToolsChanged: () => void): void {
    this._onToolsChanged = onToolsChanged;
  }

  close(): void {
    this._client.close().catch(() => {});
  }
}

// ── Public API ───────────────────────────────────────────────────────

export interface WebMcpOptions {
  /** URL of the MCP endpoint (absolute or relative, e.g. "/mcp"). */
  url: string;
  /**
   * Additional headers to include in every request to the MCP server.
   * Useful for static authentication (e.g. `{ Authorization: "Bearer <token>" }`).
   */
  headers?: Record<string, string>;
  /**
   * Async function that returns headers for each request.
   * Called before every request, useful for tokens that refresh.
   * If both `headers` and `getHeaders` are provided, they are merged
   * with `getHeaders` values taking precedence.
   */
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  /**
   * If true, listen for tools/list_changed notifications and
   * dynamically sync tools with navigator.modelContext.
   * @default true
   */
  watch?: boolean;
  /**
   * Called when tools are synced (initial load and on changes).
   * Useful for debugging or UI updates.
   */
  onSync?: (tools: McpTool[]) => void;
  /**
   * Called when an error occurs during initialization or sync.
   */
  onError?: (error: Error) => void;
}

export interface WebMcpHandle {
  /** Currently registered tool names. */
  readonly tools: ReadonlyArray<string>;
  /** Re-sync tools from the MCP server. */
  refresh(): Promise<void>;
  /** Unregister all tools and close the connection. */
  dispose(): void;
}

/**
 * Discovers tools from a Cloudflare McpAgent endpoint and registers
 * them with Chrome's native navigator.modelContext API.
 *
 * If navigator.modelContext is not available (non-Chrome browsers or
 * feature not enabled), this function is a no-op and returns a handle
 * with an empty tools array.
 *
 * @example
 * ```ts
 * import { registerWebMcp } from "agents/experimental/webmcp";
 *
 * const handle = await registerWebMcp({ url: "/mcp" });
 * console.log("Registered tools:", handle.tools);
 *
 * // Clean up when done
 * handle.dispose();
 * ```
 */
export async function registerWebMcp(
  options: WebMcpOptions
): Promise<WebMcpHandle> {
  const { url, headers, getHeaders, watch = true, onSync, onError } = options;

  const registeredTools: string[] = [];

  if (!navigator.modelContext) {
    console.info(
      "[webmcp-adapter] navigator.modelContext not available \u2014 " +
        "skipping registration. " +
        "This is expected on non-Chrome browsers."
    );
    onSync?.([]);
    return {
      get tools() {
        return [] as readonly string[];
      },
      refresh: async () => {},
      dispose: () => {}
    };
  }

  const modelContext: ModelContext = navigator.modelContext;
  const client = new McpHttpClient(url, headers, getHeaders);

  function unregisterAll(): void {
    for (const name of registeredTools) {
      try {
        modelContext.unregisterTool(name);
      } catch {
        // Tool may already be unregistered
      }
    }
    registeredTools.length = 0;
  }

  function registerTools(tools: McpTool[]): void {
    for (const tool of tools) {
      const toolDef: ModelContextTool = {
        name: tool.name,
        description: tool.description ?? tool.name,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.annotations
          ? { annotations: { readOnlyHint: tool.annotations.readOnlyHint } }
          : {}),
        execute: async (input: Record<string, unknown>) => {
          const result = await client.callTool(tool.name, input);

          if (result.isError) {
            const errorText = result.content
              .map((c) => c.text ?? "")
              .join("\n");
            throw new Error(errorText || "Tool execution failed");
          }

          const parts: string[] = [];
          for (const c of result.content) {
            if (c.type === "text" && c.text) {
              parts.push(c.text);
            } else if (c.type === "image" && c.data) {
              parts.push(`data:${c.mimeType ?? "image/png"};base64,${c.data}`);
            } else if (c.data) {
              parts.push(c.data);
            }
          }
          return parts.join("\n");
        }
      };

      try {
        modelContext.registerTool(toolDef);
        registeredTools.push(tool.name);
      } catch (err) {
        console.warn(
          `[webmcp-adapter] Failed to register tool "${tool.name}":`,
          err
        );
      }
    }
  }

  async function syncTools(): Promise<void> {
    unregisterAll();
    const tools = await client.listTools();
    registerTools(tools);
    onSync?.(tools);
  }

  // Initialize and do first sync
  try {
    await client.initialize();
    await syncTools();

    // Optionally listen for dynamic tool changes
    if (watch) {
      client.listenForChanges(() => {
        syncTools().catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          onError?.(error);
        });
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    onError?.(error);
    console.error("[webmcp-adapter] Initialization failed:", error);
  }

  return {
    get tools() {
      return [...registeredTools] as readonly string[];
    },
    refresh: syncTools,
    dispose() {
      unregisterAll();
      client.close();
    }
  };
}
