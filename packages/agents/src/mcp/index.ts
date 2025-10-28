import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  JSONRPCMessageSchema,
  isJSONRPCError,
  isJSONRPCResponse,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";
import type { Connection, ConnectionContext } from "../";
import { Agent } from "../index";
import type { BaseTransportType, MaybePromise, ServeOptions } from "./types";
import {
  createLegacySseHandler,
  createStreamingHttpHandler,
  handleCORS,
  isDurableObjectNamespace,
  MCP_HTTP_METHOD_HEADER,
  MCP_MESSAGE_HEADER
} from "./utils";
import { McpSSETransport, StreamableHTTPServerTransport } from "./transport";

export abstract class McpAgent<
  Env = unknown,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  private _transport?: Transport;
  props?: Props;

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

  /** Read the transport type for this agent.
   * This relies on the naming scheme being `sse:${sessionId}`
   * or `streamable-http:${sessionId}`.
   */
  getTransportType(): BaseTransportType {
    const [t, ..._] = this.name.split(":");
    switch (t) {
      case "sse":
        return "sse";
      case "streamable-http":
        return "streamable-http";
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
  private getWebSocket() {
    const websockets = Array.from(this.getConnections());
    if (websockets.length === 0) {
      return null;
    }
    return websockets[0];
  }

  /** Returns a new transport matching the type of the Agent. */
  private initTransport() {
    switch (this.getTransportType()) {
      case "sse": {
        return new McpSSETransport(() => this.getWebSocket());
      }
      case "streamable-http": {
        return new StreamableHTTPServerTransport({});
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
   * Base Agent / Parykit Server overrides
   */

  /** Sets up the MCP transport and server every time the Agent is started.*/
  async onStart(props?: Props) {
    // If onStart was passed props, save them in storage
    if (props) await this.updateProps(props);
    this.props = await this.ctx.storage.get("props");

    await this.init();
    const server = await this.server;
    // Connect to the MCP server
    this._transport = this.initTransport();
    await server.connect(this._transport);
    await this.reinitializeServer();
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
    messageBody: unknown
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
      if (await this._handleElicitationResponse(parsedMessage)) {
        return null; // Message was handled by elicitation system
      }

      this._transport?.onmessage?.(parsedMessage);
      return null;
    } catch (error) {
      console.error("Error forwarding message to SSE:", error);
      this._transport?.onerror?.(error as Error);
      return error as Error;
    }
  }

  /** Elicit user input with a message and schema */
  async elicitInput(params: {
    message: string;
    requestedSchema: unknown;
  }): Promise<ElicitResult> {
    const requestId = `elicit_${Math.random().toString(36).substring(2, 11)}`;

    // Store pending request in durable storage
    await this.ctx.storage.put(`elicitation:${requestId}`, {
      message: params.message,
      requestedSchema: params.requestedSchema,
      timestamp: Date.now()
    });

    const elicitRequest = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method: "elicitation/create",
      params: {
        message: params.message,
        requestedSchema: params.requestedSchema
      }
    };

    // Send through MCP transport
    if (this._transport) {
      await this._transport.send(elicitRequest);
    } else {
      const connections = this.getConnections();
      if (!connections || Array.from(connections).length === 0) {
        await this.ctx.storage.delete(`elicitation:${requestId}`);
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

    // Wait for response through MCP
    return this._waitForElicitationResponse(requestId);
  }

  /** Wait for elicitation response through storage polling */
  private async _waitForElicitationResponse(
    requestId: string
  ): Promise<ElicitResult> {
    const startTime = Date.now();
    const timeout = 60000; // 60 second timeout

    try {
      while (Date.now() - startTime < timeout) {
        // Check if response has been stored
        const response = await this.ctx.storage.get<ElicitResult>(
          `elicitation:response:${requestId}`
        );
        if (response) {
          // Immediately clean up both request and response
          await this.ctx.storage.delete(`elicitation:${requestId}`);
          await this.ctx.storage.delete(`elicitation:response:${requestId}`);
          return response;
        }

        // Sleep briefly before checking again
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      throw new Error("Elicitation request timed out");
    } finally {
      // Always clean up on timeout or error
      await this.ctx.storage.delete(`elicitation:${requestId}`);
      await this.ctx.storage.delete(`elicitation:response:${requestId}`);
    }
  }

  /** Handle elicitation responses */
  private async _handleElicitationResponse(
    message: JSONRPCMessage
  ): Promise<boolean> {
    // Check if this is a response to an elicitation request
    if (isJSONRPCResponse(message) && message.result) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("elicit_")) return false;

      // Check if we have a pending request for this ID
      const pendingRequest = await this.ctx.storage.get(
        `elicitation:${requestId}`
      );
      if (!pendingRequest) return false;

      // Store the response in durable storage
      await this.ctx.storage.put(
        `elicitation:response:${requestId}`,
        message.result as ElicitResult
      );
      return true;
    }

    // Check if this is an error response to an elicitation request
    if (isJSONRPCError(message)) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("elicit_")) return false;

      // Check if we have a pending request for this ID
      const pendingRequest = await this.ctx.storage.get(
        `elicitation:${requestId}`
      );
      if (!pendingRequest) return false;

      // Store error response
      const errorResult: ElicitResult = {
        action: "cancel",
        content: {
          error: message.error.message || "Elicitation request failed"
        }
      };
      await this.ctx.storage.put(
        `elicitation:response:${requestId}`,
        errorResult
      );
      return true;
    }

    return false;
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
            // Streamable HTTP transport handling
            const handleStreamableHttp = createStreamingHttpHandler(
              path,
              namespace,
              { corsOptions, jurisdiction }
            );
            return handleStreamableHttp(request, ctx);
          }
          case "sse": {
            // Legacy SSE transport handling
            const handleLegacySse = createLegacySseHandler(path, namespace, {
              corsOptions,
              jurisdiction
            });
            return handleLegacySse(request, ctx);
          }
          default:
            return new Response(
              "Invalid MCP transport mode. Only `streamable-http` or `sse` are allowed.",
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

export { SSEEdgeClientTransport } from "./sse-edge";
export { StreamableHTTPEdgeClientTransport } from "./streamable-http-edge";

export {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";

export type {
  MCPClientOAuthResult,
  MCPClientOAuthCallbackConfig
} from "./client";

export {
  createMcpHandler,
  experimental_createMcpHandler,
  type CreateMcpHandlerOptions,
  type OAuthExecutionContext
} from "./handler";

export { getMcpAuthContext, type McpAuthContext } from "./auth-context";

export {
  WorkerTransport,
  type WorkerTransportOptions
} from "./worker-transport";
