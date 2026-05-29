import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId
} from "@modelcontextprotocol/sdk/types.js";
import {
  JSONRPCMessageSchema,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";
import type { Connection, ConnectionContext } from "../";
import { Agent } from "../index";
import type { BaseTransportType, MaybePromise, ServeOptions } from "./types";
import {
  createAutoHandler,
  createLegacySseHandler,
  createStreamingHttpHandler,
  handleCORS,
  isDurableObjectNamespace,
  MCP_HTTP_METHOD_HEADER,
  MCP_MESSAGE_HEADER
} from "./utils";
import { McpSSETransport, StreamableHTTPServerTransport } from "./transport";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DurableObjectEventStore } from "./event-store";
import { RPCServerTransport, type RPCServerTransportOptions } from "./rpc";

export abstract class McpAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  private _transport?: Transport;
  private _pendingElicitations = new Map<
    string,
    { resolve: (result: ElicitResult) => void; reject: (err: Error) => void }
  >();
  props?: Props;

  // MCP WebSocket connections are transport bridges — they use their own
  // protocol and don't need agent identity, state sync, or other protocol
  // messages. Regular WebSocket connections are left untouched.
  override shouldSendProtocolMessages(
    _connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    return !ctx.request.headers.get(MCP_HTTP_METHOD_HEADER);
  }

  abstract server: MaybePromise<McpServer | Server>;
  abstract init(): Promise<void>;

  /*
   * Helpers
   */

  async setInitializeRequest(initializeRequest: JSONRPCMessage) {
    await this.ctx.storage.put("initializeRequest", initializeRequest);
  }

  async getInitializeRequest() {
    return this.ctx.storage.get<JSONRPCMessage>("initializeRequest");
  }

  /**
   * Storage key prefix for the `streamId -> requestIds` mapping used to
   * support POST stream resumption across WebSocket reconnects. See
   * {@link StreamableHTTPServerTransport.handleGetRequest}.
   *
   * @internal
   */
  private static readonly STREAM_REQS_KEY_PREFIX = "__mcp_stream_reqs__:";

  /**
   * Persist the `requestIds` belonging to a POST tool-call stream so a
   * future GET reconnect (carrying `Last-Event-ID`) can restore them
   * onto a fresh WebSocket connection. Internal — used by the streamable
   * HTTP transport.
   *
   * @internal
   */
  async setStreamRequestIds(
    streamId: string,
    requestIds: RequestId[]
  ): Promise<void> {
    await this.ctx.storage.put<RequestId[]>(
      `${McpAgent.STREAM_REQS_KEY_PREFIX}${streamId}`,
      requestIds
    );
  }

  /**
   * Read the persisted `requestIds` for a POST stream, or `undefined`
   * if the stream has already completed (or never existed). Internal.
   *
   * @internal
   */
  async getStreamRequestIds(
    streamId: string
  ): Promise<RequestId[] | undefined> {
    return this.ctx.storage.get<RequestId[]>(
      `${McpAgent.STREAM_REQS_KEY_PREFIX}${streamId}`
    );
  }

  /**
   * Drop the persisted `requestIds` for a POST stream. Internal.
   *
   * @internal
   */
  async deleteStreamRequestIds(streamId: string): Promise<void> {
    await this.ctx.storage.delete(
      `${McpAgent.STREAM_REQS_KEY_PREFIX}${streamId}`
    );
  }

  /** Read the transport type for this agent.
   * This relies on the naming scheme being `sse:${sessionId}`,
   * `streamable-http:${sessionId}`, or `rpc:${sessionId}`.
   */
  getTransportType(): BaseTransportType {
    const [t, ..._] = this.name.split(":");
    switch (t) {
      case "sse":
        return "sse";
      case "streamable-http":
        return "streamable-http";
      case "rpc":
        return "rpc";
      default:
        throw new Error(
          "Invalid transport type. McpAgent must be addressed with a valid protocol."
        );
    }
  }

  /** Read the sessionId for this agent.
   * This relies on the naming scheme being `sse:${sessionId}`
   * or `streamable-http:${sessionId}`.
   */
  getSessionId(): string {
    const [_, sessionId] = this.name.split(":");
    if (!sessionId) {
      throw new Error(
        "Invalid session id. McpAgent must be addressed with a valid session id."
      );
    }
    return sessionId;
  }

  /** Get the unique WebSocket. SSE transport only. */
  getWebSocket() {
    const websockets = Array.from(this.getConnections());
    if (websockets.length === 0) {
      return null;
    }
    return websockets[0];
  }

  /**
   * Returns options for configuring the RPC server transport.
   * Override this method to customize RPC transport behavior (e.g., timeout).
   *
   * @example
   * ```typescript
   * class MyMCP extends McpAgent {
   *   protected getRpcTransportOptions() {
   *     return { timeout: 120000 }; // 2 minutes
   *   }
   * }
   * ```
   */
  protected getRpcTransportOptions(): RPCServerTransportOptions {
    return {};
  }

  /**
   * Returns the {@link EventStore} used for SSE resumability on the streamable
   * HTTP transport. Defaults to a {@link DurableObjectEventStore} backed by
   * this agent's storage, which lets clients reconnect with `Last-Event-ID`
   * after the Cloudflare edge closes an idle SSE stream (~5 minute watchdog)
   * instead of relying on a server-side keepalive that would block DO
   * hibernation.
   *
   * Override to disable resumability (`return undefined`) or to plug in a
   * different store.
   */
  protected getEventStore(): EventStore | undefined {
    return new DurableObjectEventStore(this.ctx.storage);
  }

  /**
   * Maximum age (in milliseconds) of an event in the SSE event store.
   * Events older than this are dropped by the periodic sweep scheduled in
   * {@link onStart}. Default 24 hours — generous enough for clients to
   * reconnect with `Last-Event-ID` after long pauses, while still bounding
   * storage growth from abandoned POST streams whose clients never
   * returned.
   *
   * Override (in conjunction with {@link getEventStore}) to customise.
   * Return `Infinity` to disable the sweep.
   */
  protected getEventStoreMaxAgeMs(): number {
    return 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Cron expression for the recurring sweep that prunes expired SSE events
   * from the default {@link DurableObjectEventStore}. Default: every hour,
   * at minute 0. Override to change the cadence; return `undefined` to
   * disable scheduling entirely.
   */
  protected getEventStoreSweepCron(): string | undefined {
    return "0 * * * *";
  }

  /**
   * Scheduled callback that prunes expired events from the default
   * {@link DurableObjectEventStore}. Wired up by {@link onStart}; not
   * intended to be called directly.
   *
   * @internal
   */
  async _cf_sweepEventStore(): Promise<void> {
    if (!(this._transport instanceof StreamableHTTPServerTransport)) return;
    const store = (this._transport as StreamableHTTPServerTransport).eventStore;
    if (!(store instanceof DurableObjectEventStore)) return;
    const maxAgeMs = this.getEventStoreMaxAgeMs();
    if (!Number.isFinite(maxAgeMs)) return;
    await store.sweep(maxAgeMs);
  }

  /** Returns a new transport matching the type of the Agent. */
  private initTransport() {
    switch (this.getTransportType()) {
      case "sse": {
        return new McpSSETransport();
      }
      case "streamable-http": {
        const transport = new StreamableHTTPServerTransport({
          eventStore: this.getEventStore()
        });
        transport.messageInterceptor = (message) => {
          return Promise.resolve(this._handleElicitationResponse(message));
        };
        return transport;
      }
      case "rpc": {
        return new RPCServerTransport(this.getRpcTransportOptions());
      }
    }
  }

  /** Update and store the props */
  async updateProps(props?: Props) {
    await this.ctx.storage.put("props", props ?? {});
    this.props = props;
  }

  async reinitializeServer() {
    // If the agent was previously initialized, we have to populate
    // the server again by sending the initialize request to make
    // client information available to the server.
    const initializeRequest = await this.getInitializeRequest();
    if (initializeRequest) {
      this._transport?.onmessage?.(initializeRequest);
    }
  }

  /*
   * Base Agent / Partykit Server overrides
   */

  /** Sets up the MCP transport and server every time the Agent is started.*/
  async onStart(props?: Props) {
    if (props) {
      // Fresh start with props — save to storage (also sets this.props)
      await this.updateProps(props);
    } else {
      // Hibernation recovery — restore props from storage
      this.props = await this.ctx.storage.get("props");
    }

    await this.init();
    const server = await this.server;
    // Connect to the MCP server
    this._transport = this.initTransport();

    if (!this._transport) {
      throw new Error("Failed to initialize transport");
    }
    await server.connect(this._transport);

    await this.reinitializeServer();

    // Schedule a recurring sweep of the default event store. `idempotent`
    // means re-running onStart after hibernation/restart won't enqueue
    // duplicates. No-op if the user has disabled the sweep by returning
    // undefined from getEventStoreSweepCron().
    const cron = this.getEventStoreSweepCron();
    if (
      cron &&
      this._transport instanceof StreamableHTTPServerTransport &&
      this._transport.eventStore instanceof DurableObjectEventStore
    ) {
      await this.schedule(cron, "_cf_sweepEventStore", undefined, {
        idempotent: true
      });
    }
  }

  /** Validates new WebSocket connections. */
  async onConnect(
    conn: Connection,
    { request: req }: ConnectionContext
  ): Promise<void> {
    switch (this.getTransportType()) {
      case "sse": {
        // For SSE connections, we can only have one open connection per session
        // If we get an upgrade while already connected, we should error
        const websockets = Array.from(this.getConnections());
        if (websockets.length > 1) {
          conn.close(1008, "Websocket already connected");
          return;
        }
        break;
      }
      case "streamable-http":
        if (this._transport instanceof StreamableHTTPServerTransport) {
          switch (req.headers.get(MCP_HTTP_METHOD_HEADER)) {
            case "POST": {
              // This returns the response directly to the client
              const payloadHeader = req.headers.get(MCP_MESSAGE_HEADER);
              let rawPayload: string;

              if (!payloadHeader) {
                rawPayload = "{}";
              } else {
                try {
                  rawPayload = Buffer.from(payloadHeader, "base64").toString(
                    "utf-8"
                  );
                } catch (_error) {
                  throw new Error(
                    "Internal Server Error: Failed to decode MCP message header"
                  );
                }
              }

              const parsedBody = JSON.parse(rawPayload);
              this._transport?.handlePostRequest(req, parsedBody);
              break;
            }
            case "GET":
              this._transport?.handleGetRequest(req);
              break;
          }
        }
    }
  }

  /*
   * Transport ingress and routing
   */

  /** Handles MCP Messages for the legacy SSE transport. */
  async onSSEMcpMessage(
    _sessionId: string,
    messageBody: unknown,
    extraInfo?: MessageExtraInfo
  ): Promise<Error | null> {
    // Since we address the DO via both the protocol and the session id,
    // this should never happen, but let's enforce it just in case
    if (this.getTransportType() !== "sse") {
      return new Error("Internal Server Error: Expected SSE transport");
    }

    try {
      let parsedMessage: JSONRPCMessage;
      try {
        parsedMessage = JSONRPCMessageSchema.parse(messageBody);
      } catch (error) {
        this._transport?.onerror?.(error as Error);
        throw error;
      }

      // Check if this is an elicitation response before passing to transport
      if (this._handleElicitationResponse(parsedMessage)) {
        return null; // Message was handled by elicitation system
      }

      this._transport?.onmessage?.(parsedMessage, extraInfo);
      return null;
    } catch (error) {
      console.error("Error forwarding message to SSE:", error);
      this._transport?.onerror?.(error as Error);
      return error as Error;
    }
  }

  /** Elicit user input with a message and schema */
  async elicitInput(
    params: {
      message: string;
      requestedSchema: unknown;
    },
    options?: { relatedRequestId?: RequestId }
  ): Promise<ElicitResult> {
    const requestId = `elicit_${Math.random().toString(36).substring(2, 11)}`;

    const elicitRequest = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method: "elicitation/create",
      params: {
        message: params.message,
        requestedSchema: params.requestedSchema
      }
    };

    // Create a Promise that will be resolved when the response arrives.
    // timeoutId is hoisted so error paths below can clear it and avoid
    // an unhandled rejection on the orphaned responsePromise.
    let timeoutId: ReturnType<typeof setTimeout>;
    const responsePromise = new Promise<ElicitResult>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        this._pendingElicitations.delete(requestId);
        reject(new Error("Elicitation request timed out"));
      }, 60000);

      this._pendingElicitations.set(requestId, {
        resolve: (result: ElicitResult) => {
          clearTimeout(timeoutId);
          this._pendingElicitations.delete(requestId);
          resolve(result);
        },
        reject: (err: Error) => {
          clearTimeout(timeoutId);
          this._pendingElicitations.delete(requestId);
          reject(err);
        }
      });
    });

    const cleanup = () => {
      clearTimeout(timeoutId);
      this._pendingElicitations.delete(requestId);
    };

    // Keep the DO alive while we wait for the user's elicitation response.
    // An unresolved Promise alone isn't enough to prevent hibernation.
    return this.keepAliveWhile(async () => {
      // Send through MCP transport
      if (this._transport) {
        try {
          await this._transport.send(elicitRequest, options);
        } catch (error) {
          cleanup();
          throw error;
        }
      } else {
        const connections = this.getConnections();
        if (!connections || Array.from(connections).length === 0) {
          cleanup();
          throw new Error("No active connections available for elicitation");
        }

        const connectionList = Array.from(connections);
        for (const connection of connectionList) {
          try {
            connection.send(JSON.stringify(elicitRequest));
          } catch (error) {
            console.error("Failed to send elicitation request:", error);
          }
        }
      }

      return responsePromise;
    });
  }

  /** Handle elicitation responses via in-memory resolver */
  private _handleElicitationResponse(message: JSONRPCMessage): boolean {
    if (isJSONRPCResultResponse(message) && message.result) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("elicit_")) return false;

      const pending = this._pendingElicitations.get(requestId);
      if (!pending) return false;

      pending.resolve(message.result as ElicitResult);
      return true;
    }

    if (isJSONRPCErrorResponse(message)) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("elicit_")) return false;

      const pending = this._pendingElicitations.get(requestId);
      if (!pending) return false;

      pending.resolve({
        action: "cancel",
        content: {
          error: message.error.message || "Elicitation request failed"
        }
      });
      return true;
    }

    return false;
  }

  /**
   * Handle an RPC message for MCP
   * This method is called by the RPC stub to process MCP messages
   * @param message The JSON-RPC message(s) to handle
   * @returns The response message(s) or undefined
   */
  async handleMcpMessage(
    message: JSONRPCMessage | JSONRPCMessage[]
  ): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined> {
    await this.__unsafe_ensureInitialized();

    if (!(this._transport instanceof RPCServerTransport)) {
      throw new Error("Expected RPC transport");
    }

    const transport = this._transport;

    // RPC waits are intentionally in-memory. While a request/continuation is
    // pending, keep the object alive so hibernation does not drop the resolver
    // maps or the suspended tool stack. Making this sleep/resume across
    // hibernation would require a durable continuation model instead.
    return await this.keepAliveWhile(async () => {
      // Intercept elicitation responses before they reach the transport.
      // Mirrors what onSSEMcpMessage() and StreamableHTTPServerTransport's
      // messageInterceptor already do for their respective transports.
      if (!Array.isArray(message)) {
        const parseResult = JSONRPCMessageSchema.safeParse(message);
        if (
          parseResult.success &&
          this._handleElicitationResponse(parseResult.data)
        ) {
          // Resolved a pending elicitation — now wait for the tool handler
          // to send its next message (another elicitation request or the
          // final tool result).
          return await transport._awaitPendingResponse();
        }
      }

      return await transport.handle(message);
    });
  }

  /** Return a handler for the given path for this MCP.
   * Defaults to Streamable HTTP transport.
   */
  static serve(
    path: string,
    {
      binding = "MCP_OBJECT",
      corsOptions,
      transport = "streamable-http",
      jurisdiction
    }: ServeOptions = {}
  ) {
    return {
      async fetch<Env>(
        this: void,
        request: Request,
        env: Env,
        ctx: ExecutionContext
      ): Promise<Response> {
        // Handle CORS preflight
        const corsResponse = handleCORS(request, corsOptions);
        if (corsResponse) {
          return corsResponse;
        }

        const bindingValue = env[binding as keyof typeof env] as unknown;

        // Ensure we have a binding of some sort
        if (bindingValue == null || typeof bindingValue !== "object") {
          throw new Error(
            `Could not find McpAgent binding for ${binding}. Did you update your wrangler configuration?`
          );
        }

        // Ensure that the binding is to a DurableObject
        if (!isDurableObjectNamespace(bindingValue)) {
          throw new Error(
            `Invalid McpAgent binding for ${binding}. Make sure it's a Durable Object binding.`
          );
        }

        const namespace =
          bindingValue satisfies DurableObjectNamespace<McpAgent>;

        switch (transport) {
          case "streamable-http": {
            const handleStreamableHttp = createStreamingHttpHandler(
              path,
              namespace,
              { corsOptions, jurisdiction }
            );
            return handleStreamableHttp(request, ctx);
          }
          case "sse": {
            const handleLegacySse = createLegacySseHandler(path, namespace, {
              corsOptions,
              jurisdiction
            });
            return handleLegacySse(request, ctx);
          }
          case "auto": {
            const handleAuto = createAutoHandler(path, namespace, {
              corsOptions,
              jurisdiction
            });
            return handleAuto(request, ctx);
          }
          default:
            return new Response(
              "Invalid MCP transport mode. Only `streamable-http`, `sse`, or `auto` are allowed.",
              { status: 500 }
            );
        }
      }
    };
  }
  /**
   * Legacy api
   **/
  static mount(path: string, opts: Omit<ServeOptions, "transport"> = {}) {
    return McpAgent.serveSSE(path, opts);
  }

  static serveSSE(path: string, opts: Omit<ServeOptions, "transport"> = {}) {
    return McpAgent.serve(path, { ...opts, transport: "sse" });
  }
}

export {
  SSEEdgeClientTransport,
  StreamableHTTPEdgeClientTransport
} from "./client-transports";
export {
  RPC_DO_PREFIX,
  RPCClientTransport,
  RPCServerTransport,
  type RPCClientTransportOptions,
  type RPCServerTransportOptions
} from "./rpc";

export {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";

export type {
  MCPClientOAuthResult,
  MCPClientOAuthCallbackConfig,
  MCPServerOptions,
  MCPConnectionResult,
  MCPDiscoverResult
} from "./client";

export { normalizeServerId, MCP_SERVER_ID_MAX_LENGTH } from "./client";

export type { McpClientOptions } from "./types";

export {
  createMcpHandler,
  experimental_createMcpHandler,
  type CreateMcpHandlerOptions
} from "./handler";

export { getMcpAuthContext, type McpAuthContext } from "./auth-context";

export { DurableObjectEventStore } from "./event-store";

export {
  WorkerTransport,
  type WorkerTransportOptions,
  type TransportState
} from "./worker-transport";
