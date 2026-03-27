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

// ── MCP Streamable HTTP client (minimal, browser-side) ───────────────

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

interface McpToolsListResult {
  tools: McpTool[];
}

interface McpToolCallResult {
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Minimal MCP Streamable HTTP client for browser use. */
class McpHttpClient {
  private _url: string;
  private _sessionId: string | null = null;
  private _nextId = 1;
  private _abortController: AbortController | null = null;

  constructor(url: string) {
    // Resolve relative URLs against current origin
    this._url = new URL(url, globalThis.location?.origin).href;
  }

  /** Send a JSON-RPC request and parse the SSE response. */
  private async _send(
    method: string,
    params?: Record<string, unknown>,
    id?: number
  ): Promise<JsonRpcResponse | null> {
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      ...(id != null ? { id } : {}),
      ...(params ? { params } : {})
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    };

    if (this._sessionId) {
      headers["mcp-session-id"] = this._sessionId;
    }

    const res = await fetch(this._url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    // Capture session ID from response headers
    const sid = res.headers.get("mcp-session-id");
    if (sid) {
      this._sessionId = sid;
    }

    // Notifications (no id)
    if (id == null) {
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";

    // Direct JSON response
    if (contentType.includes("application/json")) {
      return (await res.json()) as JsonRpcResponse;
    }

    // SSE response — parse the first "message" event
    if (contentType.includes("text/event-stream")) {
      return this._parseSSE(res);
    }

    throw new Error(`Unexpected content-type from MCP server: ${contentType}`);
  }

  /** Parse a Server-Sent Events response and return the first message. */
  private async _parseSSE(res: Response): Promise<JsonRpcResponse> {
    const text = await res.text();
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data) {
          return JSON.parse(data) as JsonRpcResponse;
        }
      }
    }
    throw new Error("No data event found in SSE response");
  }

  /** Initialize the MCP session. */
  async initialize(): Promise<void> {
    const id = this._nextId++;
    const res = await this._send(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "webmcp-adapter",
          version: "0.1.0"
        }
      },
      id
    );

    if (res?.error) {
      throw new Error(`MCP initialize failed: ${res.error.message}`);
    }

    // Send initialized notification
    await this._send("notifications/initialized", {});
  }

  /** List all tools from the MCP server. */
  async listTools(): Promise<McpTool[]> {
    const id = this._nextId++;
    const res = await this._send("tools/list", {}, id);

    if (res?.error) {
      throw new Error(`MCP tools/list failed: ${res.error.message}`);
    }

    const result = res?.result as McpToolsListResult | undefined;
    return result?.tools ?? [];
  }

  /** Call a tool on the MCP server. */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    const id = this._nextId++;
    const res = await this._send("tools/call", { name, arguments: args }, id);

    if (res?.error) {
      throw new Error(`MCP tools/call failed: ${res.error.message}`);
    }

    return (res?.result as McpToolCallResult) ?? { content: [] };
  }

  /** Open an SSE stream for server notifications (tools/list_changed). */
  listenForChanges(onToolsChanged: () => void): void {
    if (!this._sessionId) return;

    this._abortController = new AbortController();
    const headers: Record<string, string> = {
      Accept: "text/event-stream"
    };
    if (this._sessionId) {
      headers["mcp-session-id"] = this._sessionId;
    }

    fetch(this._url, {
      method: "GET",
      headers,
      signal: this._abortController.signal
    })
      .then(async (res) => {
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (!data) continue;
              try {
                const msg = JSON.parse(data) as JsonRpcResponse;
                if (
                  "method" in msg &&
                  (msg as unknown as { method: string }).method ===
                    "notifications/tools/list_changed"
                ) {
                  onToolsChanged();
                }
              } catch {
                // Ignore non-JSON SSE data
              }
            }
          }
        }
      })
      .catch((err: unknown) => {
        // AbortError is expected on dispose
        if (err instanceof Error && err.name === "AbortError") return;
        console.warn("[webmcp-adapter] SSE listener error:", err);
      });
  }

  /** Close the SSE listener. */
  close(): void {
    this._abortController?.abort();
    this._abortController = null;
  }
}

// ── Public API ───────────────────────────────────────────────────────

export interface WebMcpOptions {
  /** URL of the MCP endpoint (absolute or relative, e.g. "/mcp"). */
  url: string;
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
  const { url, watch = true, onSync, onError } = options;

  const registeredTools: string[] = [];

  if (!navigator.modelContext) {
    console.info(
      "[webmcp-adapter] navigator.modelContext not available \u2014 " +
        "skipping registration. " +
        "This is expected on non-Chrome browsers."
    );
    return {
      get tools() {
        return [] as readonly string[];
      },
      refresh: async () => {},
      dispose: () => {}
    };
  }

  const modelContext: ModelContext = navigator.modelContext;
  const client = new McpHttpClient(url);

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

          // Return the text content as the result
          return result.content.map((c) => c.text ?? "").join("\n");
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
      return registeredTools as readonly string[];
    },
    refresh: syncTools,
    dispose() {
      unregisterAll();
      client.close();
    }
  };
}
