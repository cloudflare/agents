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
 * @example Bridge a remote McpAgent endpoint into the page
 * ```ts
 * import { registerWebMcp } from "agents/experimental/webmcp";
 *
 * const handle = await registerWebMcp({ url: "/mcp" });
 *
 * // Later, to clean up:
 * await handle.dispose();
 * ```
 *
 * @example Mix in-page tools with bridged tools (recommended pattern)
 * ```ts
 * import { registerWebMcp } from "agents/experimental/webmcp";
 *
 * // 1. Register page-local tools — things only the page can do
 * navigator.modelContext?.registerTool({
 *   name: "scroll_to_section",
 *   description: "Scroll the page to a named section",
 *   inputSchema: {
 *     type: "object",
 *     properties: { id: { type: "string" } },
 *     required: ["id"]
 *   },
 *   async execute({ id }) {
 *     document.getElementById(String(id))?.scrollIntoView({ behavior: "smooth" });
 *     return "ok";
 *   }
 * });
 *
 * // 2. Bridge server tools — things that need durable storage / auth / DB access
 * const handle = await registerWebMcp({
 *   url: "/mcp",
 *   prefix: "remote.",            // optional namespace to avoid collisions
 *   getHeaders: async () => ({ Authorization: `Bearer ${await getToken()}` })
 * });
 *
 * // The browser AI sees both kinds of tools side by side.
 * ```
 *
 * @experimental This API is not yet stable and may change.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

// ── WebMCP browser API surface (Chrome's navigator.modelContext) ─────

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

interface ModelContextRegisterToolOptions {
  signal?: AbortSignal;
}

interface ModelContext {
  registerTool(
    tool: ModelContextTool,
    options?: ModelContextRegisterToolOptions
  ): void;
}

declare global {
  interface Navigator {
    modelContext?: ModelContext;
  }
}

// ── Internal types ───────────────────────────────────────────────────

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

/**
 * Logger interface for adapter diagnostics. Defaults to `console`.
 * Pass a no-op implementation (or `quiet: true`) to silence output.
 */
export interface WebMcpLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const DEFAULT_LOGGER: WebMcpLogger = {
  info: (...args) => console.info("[webmcp-adapter]", ...args),
  warn: (...args) => console.warn("[webmcp-adapter]", ...args),
  error: (...args) => console.error("[webmcp-adapter]", ...args)
};

const SILENT_LOGGER: WebMcpLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

// ── MCP transport wrapper ────────────────────────────────────────────

class McpHttpClient {
  private _client: Client;
  private _transport: StreamableHTTPClientTransport;
  private _onToolsChanged?: () => void;
  private _timeoutMs?: number;

  constructor(
    url: string,
    headers?: Record<string, string>,
    getHeaders?: () => Promise<Record<string, string>> | Record<string, string>,
    timeoutMs?: number
  ) {
    const resolvedUrl = new URL(url, globalThis.location?.origin);
    this._timeoutMs = timeoutMs;

    const transportOptions: ConstructorParameters<
      typeof StreamableHTTPClientTransport
    >[1] = {
      requestInit: { headers: headers ?? {} }
    };

    if (getHeaders) {
      transportOptions.fetch = async (input, init) => {
        const dynamic = await getHeaders();
        const merged = new Headers(init?.headers);
        for (const [k, v] of Object.entries(dynamic)) {
          merged.set(k, v);
        }
        return globalThis.fetch(input, {
          ...init,
          headers: merged
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

  async initialize(signal?: AbortSignal): Promise<void> {
    await this._client.connect(this._transport);

    this._client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        if (signal?.aborted) return;
        this._onToolsChanged?.();
      }
    );
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await this._client.listTools(
        cursor ? { cursor } : undefined,
        { signal, timeout: this._timeoutMs }
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
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<McpToolCallResult> {
    const result = await this._client.callTool(
      { name, arguments: args },
      undefined,
      { signal, timeout: this._timeoutMs }
    );
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

  async close(): Promise<void> {
    try {
      await this._client.close();
    } catch {
      // Closing a never-connected or already-closed client is fine.
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

export interface WebMcpOptions {
  /** URL of the MCP endpoint (absolute or relative, e.g. `"/mcp"`). */
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
   * If true, listen for `tools/list_changed` notifications and re-sync
   * tools with `navigator.modelContext`. The adapter opens an SSE GET to
   * the MCP endpoint to receive notifications; servers that don't support
   * server-initiated streams (e.g. respond `405` on GET) gracefully degrade.
   * @default true
   */
  watch?: boolean;
  /**
   * Optional namespace prefix prepended to every tool name registered with
   * `navigator.modelContext`. Useful when bridging multiple MCP servers, or
   * when the page also registers in-page tools and you want to avoid
   * collisions. The original (unprefixed) name is still used on the wire
   * when calling the server.
   *
   * @example `prefix: "remote."` turns `search` into `remote.search`.
   */
  prefix?: string;
  /**
   * Per-request timeout (in milliseconds) applied to `tools/list` and
   * `tools/call`. If the server doesn't respond in time, the request is
   * aborted and the resulting error is surfaced through the normal error
   * paths (`onError` for sync, rejection for tool execution).
   */
  timeoutMs?: number;
  /**
   * Custom logger. Defaults to `console` with a `[webmcp-adapter]` prefix.
   * Pass `{ info: () => {}, warn: () => {}, error: () => {} }` to silence.
   */
  logger?: WebMcpLogger;
  /** Convenience shortcut for `logger: SILENT_LOGGER`. @default false */
  quiet?: boolean;
  /**
   * Called whenever the adapter performs a successful sync (initial load
   * and on `tools/list_changed`). Receives the tools as the server returned
   * them (with their original, unprefixed names).
   */
  onSync?: (tools: McpTool[]) => void;
  /**
   * Called when an error occurs during background work that the caller
   * cannot otherwise observe — specifically: a watch-mode re-sync failure.
   *
   * **Not** called for:
   * - Initialization failures (those reject the `registerWebMcp` promise).
   * - Per-tool execution failures (those reject the `execute` promise the
   *   browser host awaits; Chrome surfaces them to the AI).
   */
  onError?: (error: Error) => void;
}

export interface WebMcpHandle {
  /**
   * Currently registered tool names (with `prefix` applied). Returns a fresh
   * snapshot on each access — safe to mutate.
   */
  readonly tools: ReadonlyArray<string>;
  /**
   * Re-fetch the tool list from the server and re-register everything.
   * If a sync is already in flight (from a `tools/list_changed` notification
   * or a previous `refresh()` call), returns the in-flight promise rather
   * than starting a second sync.
   */
  refresh(): Promise<void>;
  /**
   * Unregister all tools, signal any in-flight work to abort, and close the
   * MCP connection. Safe to call multiple times.
   */
  dispose(): Promise<void>;
  /** True after `dispose()` has been called at least once. */
  readonly disposed: boolean;
}

/**
 * Discovers tools from a Cloudflare McpAgent endpoint and registers them
 * with Chrome's native `navigator.modelContext` API.
 *
 * On browsers without `navigator.modelContext` (everything except recent
 * Chrome with the relevant flags), this function is a no-op and returns a
 * handle with an empty tools array. No network request is made.
 *
 * @example
 * ```ts
 * import { registerWebMcp } from "agents/experimental/webmcp";
 *
 * const handle = await registerWebMcp({ url: "/mcp" });
 * console.log("Registered tools:", handle.tools);
 *
 * // Clean up when done (e.g. in a React effect cleanup)
 * await handle.dispose();
 * ```
 *
 * See the JSDoc on the module itself for the recommended "in-page tools +
 * remote tools" composition pattern.
 */
export async function registerWebMcp(
  options: WebMcpOptions
): Promise<WebMcpHandle> {
  const {
    url,
    headers,
    getHeaders,
    watch = true,
    prefix = "",
    timeoutMs,
    logger: userLogger,
    quiet = false,
    onSync,
    onError
  } = options;

  const logger = quiet ? SILENT_LOGGER : (userLogger ?? DEFAULT_LOGGER);

  const registeredTools: string[] = [];
  const toolControllers = new Map<string, AbortController>();
  const lifecycleController = new AbortController();
  let disposed = false;
  let inflightSync: Promise<void> | null = null;

  if (!navigator.modelContext) {
    logger.info(
      "navigator.modelContext not available — skipping registration. " +
        "This is expected on non-Chrome browsers."
    );
    onSync?.([]);
    return {
      get tools() {
        return [];
      },
      get disposed() {
        return disposed;
      },
      refresh: async () => {},
      dispose: async () => {
        disposed = true;
      }
    };
  }

  const modelContext: ModelContext = navigator.modelContext;
  const client = new McpHttpClient(url, headers, getHeaders, timeoutMs);

  function unregisterAll(): void {
    for (const controller of toolControllers.values()) {
      controller.abort();
    }
    toolControllers.clear();
    registeredTools.length = 0;
  }

  function registerTools(tools: McpTool[]): void {
    for (const tool of tools) {
      const registeredName = `${prefix}${tool.name}`;
      const toolDef: ModelContextTool = {
        name: registeredName,
        description: tool.description ?? tool.name,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.annotations
          ? { annotations: { readOnlyHint: tool.annotations.readOnlyHint } }
          : {}),
        execute: async (input: Record<string, unknown>) => {
          if (disposed) {
            throw new Error("WebMCP adapter has been disposed");
          }
          const result = await client.callTool(
            tool.name,
            input,
            lifecycleController.signal
          );

          if (result.isError) {
            const errorText = result.content
              .map((c) => c.text ?? "")
              .join("\n");
            throw new Error(errorText || "Tool execution failed");
          }

          const parts: string[] = [];
          let sawUnsupported = false;
          for (const c of result.content) {
            if (c.type === "text" && c.text) {
              parts.push(c.text);
            } else if (c.type === "image" && c.data) {
              parts.push(`data:${c.mimeType ?? "image/png"};base64,${c.data}`);
            } else if (c.data) {
              parts.push(c.data);
              sawUnsupported = true;
            } else {
              sawUnsupported = true;
            }
          }
          if (sawUnsupported) {
            logger.warn(
              `Tool "${tool.name}" returned content type(s) the adapter` +
                " cannot fully represent as a string."
            );
          }
          return parts.join("\n");
        }
      };

      try {
        const controller = new AbortController();
        modelContext.registerTool(toolDef, { signal: controller.signal });
        toolControllers.set(registeredName, controller);
        registeredTools.push(registeredName);
      } catch (err) {
        logger.warn(`Failed to register tool "${registeredName}":`, err);
      }
    }
  }

  // Serialize syncs: if one is already running, share its promise. This
  // prevents the unregister/listTools/registerTools sequence from
  // interleaving when both `refresh()` and a `tools/list_changed`
  // notification fire concurrently.
  function syncTools(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inflightSync) return inflightSync;
    inflightSync = (async () => {
      try {
        const tools = await client.listTools(lifecycleController.signal);
        if (disposed) return;
        unregisterAll();
        registerTools(tools);
        onSync?.(tools);
      } finally {
        inflightSync = null;
      }
    })();
    return inflightSync;
  }

  try {
    await client.initialize(lifecycleController.signal);
    await syncTools();

    if (watch) {
      client.listenForChanges(() => {
        if (disposed) return;
        syncTools().catch((err: unknown) => {
          if (disposed) return;
          const error = err instanceof Error ? err : new Error(String(err));
          logger.warn("Watch-mode sync failed:", error);
          onError?.(error);
        });
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error("Initialization failed:", error);
    // Best-effort cleanup so a failed init doesn't leak the transport.
    await client.close();
    throw error;
  }

  return {
    get tools() {
      return [...registeredTools];
    },
    get disposed() {
      return disposed;
    },
    refresh: syncTools,
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifecycleController.abort();
      unregisterAll();
      // Wait for any in-flight sync to settle so callers can rely on
      // a quiet adapter after `await handle.dispose()`.
      try {
        await inflightSync;
      } catch {
        // Already surfaced via onError or thrown to the original caller.
      }
      await client.close();
    }
  };
}
