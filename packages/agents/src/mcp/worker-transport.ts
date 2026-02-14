/**
 * Based on webStandardStreamableHttp.ts (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/webStandardStreamableHttp.ts)
 */

import type {
  Transport,
  TransportSendOptions
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  RequestId,
  RequestInfo,
  MessageExtraInfo,
  InitializeRequestParams
} from "@modelcontextprotocol/sdk/types.js";
import {
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  JSONRPCMessageSchema,
  SUPPORTED_PROTOCOL_VERSIONS
} from "@modelcontextprotocol/sdk/types.js";
import type { CORSOptions } from "./types";
import type {
  EventStore,
  EventId
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
const RESTORE_REQUEST_ID = "__restore__";

interface StreamMapping {
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  encoder?: TextEncoder;
  resolveJson?: (response: Response) => void;
  cleanup: () => void;
}

export interface MCPStorageApi {
  get(): Promise<TransportState | undefined> | TransportState | undefined;
  set(state: TransportState): Promise<void> | void;
}

export interface TransportState {
  sessionId?: string;
  initialized: boolean;
  initializeParams?: InitializeRequestParams;
}

export interface WorkerTransportOptions {
  /**
   * Function that generates a session ID for the transport.
   * The session ID SHOULD be globally unique and cryptographically secure.
   * Return undefined to disable session management (stateless mode).
   */
  sessionIdGenerator?: () => string;
  /**
   * Enable traditional Request/Response mode, this will disable streaming.
   */
  enableJsonResponse?: boolean;
  /**
   * Callback fired when a new session is initialized.
   */
  onsessioninitialized?: (sessionId: string) => void;
  /**
   * Callback fired when a session is closed via DELETE request.
   */
  onsessionclosed?: (sessionId: string) => void;
  corsOptions?: CORSOptions;
  /**
   * Optional storage api for persisting transport state.
   * Use this to store session state in Durable Object/Agent storage
   * so it survives hibernation/restart.
   */
  storage?: MCPStorageApi;
  /**
   * Event store for resumability support.
   * If provided, enables clients to reconnect and resume messages using Last-Event-ID.
   */
  eventStore?: EventStore;
  /**
   * Retry interval in milliseconds to suggest to clients in SSE retry field.
   * Controls client reconnection timing for polling behavior.
   */
  retryInterval?: number;
}

export class WorkerTransport implements Transport {
  started = false;
  private initialized = false;
  private sessionIdGenerator?: () => string;
  private enableJsonResponse = false;
  private onsessioninitialized?: (sessionId: string) => void;
  private onsessionclosed?: (sessionId: string) => void;
  private standaloneSseStreamId = "_GET_stream";
  private streamMapping = new Map<string, StreamMapping>();
  private requestToStreamMapping = new Map<RequestId, string>();
  private requestResponseMap = new Map<RequestId, JSONRPCMessage>();
  private corsOptions?: CORSOptions;
  private storage?: MCPStorageApi;
  private stateRestored = false;
  private eventStore?: EventStore;
  private retryInterval?: number;
  private initializeParams?: TransportState["initializeParams"];

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  constructor(options?: WorkerTransportOptions) {
    this.sessionIdGenerator = options?.sessionIdGenerator;
    this.enableJsonResponse = options?.enableJsonResponse ?? false;
    this.onsessioninitialized = options?.onsessioninitialized;
    this.onsessionclosed = options?.onsessionclosed;
    this.corsOptions = options?.corsOptions;
    this.storage = options?.storage;
    this.eventStore = options?.eventStore;
    this.retryInterval = options?.retryInterval;
  }

  /**
   * Restore transport state from persistent storage.
   * This is automatically called on start.
   */
  private async restoreState() {
    if (!this.storage || this.stateRestored) {
      return;
    }

    const state = await Promise.resolve(this.storage.get());

    if (state) {
      this.sessionId = state.sessionId;
      this.initialized = state.initialized;

      // Restore _clientCapabilities on the Server instance by replaying the original initialize request
      if (state.initializeParams && this.onmessage) {
        this.onmessage({
          jsonrpc: "2.0",
          id: RESTORE_REQUEST_ID,
          method: "initialize",
          params: state.initializeParams
        });
      }
    }

    this.stateRestored = true;
  }

  /**
   * Persist current transport state to storage.
   */
  private async saveState() {
    if (!this.storage) {
      return;
    }

    const state: TransportState = {
      sessionId: this.sessionId,
      initialized: this.initialized,
      initializeParams: this.initializeParams
    };

    await Promise.resolve(this.storage.set(state));
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Transport already started");
    }
    this.started = true;
  }

  /**
   * Validates the MCP-Protocol-Version header on incoming requests.
   *
   * This performs a simple check: if a version header is present, it must be
   * in the SUPPORTED_PROTOCOL_VERSIONS list. We do not track the negotiated
   * version or enforce version consistency across requests - the SDK handles
   * version negotiation during initialization, and we simply reject any
   * explicitly unsupported versions.
   *
   * - Header present and supported: Accept
   * - Header present and unsupported: 400 Bad Request
   * - Header missing: Accept (version validation is optional)
   */
  private validateProtocolVersion(request: Request): Response | undefined {
    const protocolVersion = request.headers.get(MCP_PROTOCOL_VERSION_HEADER);

    if (
      protocolVersion !== null &&
      !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
    ) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `Bad Request: Unsupported protocol version: ${protocolVersion} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`
          },
          id: null
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...this.getHeaders()
          }
        }
      );
    }
    return undefined;
  }

  private getHeaders({ forPreflight }: { forPreflight?: boolean } = {}): Record<
    string,
    string
  > {
    const defaults: CORSOptions = {
      origin: "*",
      headers:
        "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version",
      methods: "GET, POST, DELETE, OPTIONS",
      exposeHeaders: "mcp-session-id",
      maxAge: 86400
    };

    const options = { ...defaults, ...this.corsOptions };

    // For OPTIONS preflight, return all CORS headers
    if (forPreflight) {
      return {
        "Access-Control-Allow-Origin": options.origin!,
        "Access-Control-Allow-Headers": options.headers!,
        "Access-Control-Allow-Methods": options.methods!,
        "Access-Control-Max-Age": options.maxAge!.toString()
      };
    }

    // For actual requests, only return origin and expose headers
    return {
      "Access-Control-Allow-Origin": options.origin!,
      "Access-Control-Expose-Headers": options.exposeHeaders!
    };
  }

  async handleRequest(
    request: Request,
    parsedBody?: unknown
  ): Promise<Response> {
    await this.restoreState();

    switch (request.method) {
      case "OPTIONS":
        return this.handleOptionsRequest(request);
      case "GET":
        return this.handleGetRequest(request);
      case "POST":
        return this.handlePostRequest(request, parsedBody);
      case "DELETE":
        return this.handleDeleteRequest(request);
      default:
        return this.handleUnsupportedRequest();
    }
  }

  private async handleGetRequest(request: Request): Promise<Response> {
    const acceptHeader = request.headers.get("Accept");
    if (!acceptHeader?.includes("text/event-stream")) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Not Acceptable: Client must accept text/event-stream"
          },
          id: null
        }),
        {
          status: 406,
          headers: {
            "Content-Type": "application/json",
            ...this.getHeaders()
          }
        }
      );
    }

    const sessionError = this.validateSession(request);
    if (sessionError) {
      return sessionError;
    }

    // Validate protocol version on subsequent requests
    const versionError = this.validateProtocolVersion(request);
    if (versionError) {
      return versionError;
    }

    let streamId = this.standaloneSseStreamId;

    // Check for resumability via Last-Event-ID
    const lastEventId = request.headers.get("Last-Event-ID");
    if (lastEventId && this.eventStore) {
      // Get the stream ID for this event if available
      const eventStreamId =
        await this.eventStore.getStreamIdForEventId?.(lastEventId);
      if (eventStreamId) {
        streamId = eventStreamId;
      }
    }

    if (this.streamMapping.get(streamId) !== undefined) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Conflict: Only one SSE stream is allowed per session"
          },
          id: null
        }),
        {
          status: 409,
          headers: {
            "Content-Type": "application/json",
            ...this.getHeaders()
          }
        }
      );
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const headers = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...this.getHeaders()
    });

    if (this.sessionId !== undefined) {
      headers.set("mcp-session-id", this.sessionId);
    }

    const keepAlive = setInterval(() => {
      try {
        writer.write(encoder.encode("event: ping\ndata: \n\n"));
      } catch {
        clearInterval(keepAlive);
      }
    }, 30000);

    this.streamMapping.set(streamId, {
      writer,
      encoder,
      cleanup: () => {
        clearInterval(keepAlive);
        this.streamMapping.delete(streamId);
        writer.close().catch(() => {});
      }
    });

    // Write priming event with retry interval if configured
    if (this.retryInterval !== undefined) {
      await writer.write(encoder.encode(`retry: ${this.retryInterval}\n\n`));
    }

    // Replay events if resuming and eventStore is configured
    if (lastEventId && this.eventStore) {
      const replayedStreamId = await this.eventStore.replayEventsAfter(
        lastEventId,
        {
          send: async (eventId: EventId, message: JSONRPCMessage) => {
            const data = `id: ${eventId}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
            await writer.write(encoder.encode(data));
          }
        }
      );
      // Update stream ID if different from what we had
      if (replayedStreamId !== streamId) {
        this.streamMapping.delete(streamId);
        streamId = replayedStreamId;
        this.streamMapping.set(streamId, {
          writer,
          encoder,
          cleanup: () => {
            clearInterval(keepAlive);
            this.streamMapping.delete(streamId);
            writer.close().catch(() => {});
          }
        });
      }
    }

    return new Response(readable, { headers });
  }

  private async handlePostRequest(
    request: Request,
    parsedBody?: unknown
  ): Promise<Response> {
    const acceptHeader = request.headers.get("Accept");
    if (
      !acceptHeader?.includes("application/json") ||
      !acceptHeader?.includes("text/event-stream")
    ) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Not Acceptable: Client must accept both application/json and text/event-stream"
          },
          id: null
        }),
        {
          status: 406,
          headers: {
            "Content-Type": "application/json",
            ...this.getHeaders()
          }
        }
      );
    }

    const contentType = request.headers.get("Content-Type");
    if (!contentType?.includes("application/json")) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Unsupported Media Type: Content-Type must be application/json"
          },
          id: null
        }),
        {
          status: 415,
          headers: {
            "Content-Type": "application/json",
            ...this.getHeaders()
          }
        }
      );
    }

    let rawMessage = parsedBody;
    if (rawMessage === undefined) {
      try {
        rawMessage = await request.json();
      } catch {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32700,
              message: "Parse error: Invalid JSON"
            },
            id: null
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              ...this.getHeaders()
            }
          }
        );
      }
    }

    let messages: JSONRPCMessage[];
    try {
      if (Array.isArray(rawMessage)) {
        messages = rawMessage.map((msg) => JSONRPCMessageSchema.parse(msg));
      } else {
        messages = [JSONRPCMessageSchema.parse(rawMessage)];
      }
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: "Parse error: Invalid JSON-RPC message"
          },
          id: null
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...this.getHeaders()
          }
        }
      );
    }

    const requestInfo: RequestInfo = {
      headers: Object.fromEntries(request.headers.entries())
    };

    const isInitializationRequest = messages.some(isInitializeRequest);

    if (isInitializationRequest) {
      if (this.initialized && this.sessionId !== undefined) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Invalid Request: Server already initialized"
            },
            id: null
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              ...this.getHeaders()
            }
          }
        );
      }

      if (messages.length > 1) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message:
                "Invalid Request: Only one initialization request is allowed"
            },
            id: null
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              ...this.getHeaders()
            }
          }
        );
      }

      this.sessionId = this.sessionIdGenerator?.();
      this.initialized = true;

      const initMessage = messages.find(isInitializeRequest);
      if (initMessage && isInitializeRequest(initMessage)) {
        this.initializeParams = {
          capabilities: initMessage.params.capabilities,
          clientInfo: initMessage.params.clientInfo,
          protocolVersion: initMessage.params.protocolVersion
        };
      }

      await this.saveState();

      if (this.sessionId && this.onsessioninitialized) {
        this.onsessioninitialized(this.sessionId);
      }
    }

    if (!isInitializationRequest) {
      const sessionError = this.validateSession(request);
      if (sessionError) {
        return sessionError;
      }

      // Validate protocol version on subsequent requests
      const versionError = this.validateProtocolVersion(request);
      if (versionError) {
        return versionError;
      }
    }

    const hasRequests = messages.some(isJSONRPCRequest);

    if (!hasRequests) {
      for (const message of messages) {
        this.onmessage?.(message, { requestInfo });
      }
      return new Response(null, {
        status: 202,
        headers: { ...this.getHeaders() }
      });
    }

    const streamId = crypto.randomUUID();

    if (this.enableJsonResponse) {
      return new Promise<Response>((resolve) => {
        this.streamMapping.set(streamId, {
          resolveJson: resolve,
          cleanup: () => {
            this.streamMapping.delete(streamId);
          }
        });

        for (const message of messages) {
          if (isJSONRPCRequest(message)) {
            this.requestToStreamMapping.set(message.id, streamId);
          }
        }

        for (const message of messages) {
          this.onmessage?.(message, { requestInfo });
        }
      });
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const headers = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...this.getHeaders()
    });

    if (this.sessionId !== undefined) {
      headers.set("mcp-session-id", this.sessionId);
    }

    const keepAlive = setInterval(() => {
      try {
        writer.write(encoder.encode("event: ping\ndata: \n\n"));
      } catch {
        clearInterval(keepAlive);
      }
    }, 30000);

    this.streamMapping.set(streamId, {
      writer,
      encoder,
      cleanup: () => {
        clearInterval(keepAlive);
        this.streamMapping.delete(streamId);
        writer.close().catch(() => {});
      }
    });

    for (const message of messages) {
      if (isJSONRPCRequest(message)) {
        this.requestToStreamMapping.set(message.id, streamId);
      }
    }

    for (const message of messages) {
      this.onmessage?.(message, { requestInfo });
    }

    return new Response(readable, { headers });
  }

  private async handleDeleteRequest(request: Request): Promise<Response> {
    const sessionError = this.validateSession(request);
    if (sessionError) {
      return sessionError;
    }

    // Validate protocol version on subsequent requests
    const versionError = this.validateProtocolVersion(request);
    if (versionError) {
      return versionError;
    }

    // Capture session ID before closing
    const closedSessionId = this.sessionId;

    await this.close();

    // Fire onsessionclosed callback if configured
    if (closedSessionId && this.onsessionclosed) {
      this.onsessionclosed(closedSessionId);
    }

    return new Response(null, {
      status: 200,
      headers: { ...this.getHeaders() }
    });
  }

  private handleOptionsRequest(_request: Request): Response {
    return new Response(null, {
      status: 200,
      headers: { ...this.getHeaders({ forPreflight: true }) }
    });
  }

  private handleUnsupportedRequest(): Response {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed."
        },
        id: null
      }),
      {
        status: 405,
        headers: {
          Allow: "GET, POST, DELETE, OPTIONS",
          "Content-Type": "application/json"
        }
      }
    );
  }

  private validateSession(request: Request): Response | undefined {
    if (this.sessionIdGenerator === undefined) {
      return undefined;
    }

    if (!this.initialized) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Server not initialized"
          },
          id: null
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...this.getHeaders()
          }
        }
      );
    }

    const sessionId = request.headers.get("mcp-session-id");

    if (!sessionId) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Mcp-Session-Id header is required"
          },
          id: null
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...this.getHeaders()
          }
        }
      );
    }

    if (sessionId !== this.sessionId) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Session not found"
          },
          id: null
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            ...this.getHeaders()
          }
        }
      );
    }

    return undefined;
  }

  async close(): Promise<void> {
    for (const { cleanup } of this.streamMapping.values()) {
      cleanup();
    }

    this.streamMapping.clear();
    this.requestResponseMap.clear();
    this.onclose?.();
  }

  /**
   * Close an SSE stream for a specific request, triggering client reconnection.
   * Use this to implement polling behavior during long-running operations -
   * client will reconnect after the retry interval specified in the priming event.
   */
  closeSSEStream(requestId: RequestId): void {
    const streamId = this.requestToStreamMapping.get(requestId);
    if (!streamId) {
      return;
    }

    const stream = this.streamMapping.get(streamId);
    if (stream) {
      stream.cleanup();
    }

    // Clean up request mappings for this stream
    for (const [reqId, sid] of this.requestToStreamMapping.entries()) {
      if (sid === streamId) {
        this.requestToStreamMapping.delete(reqId);
        this.requestResponseMap.delete(reqId);
      }
    }
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions
  ): Promise<void> {
    // Check relatedRequestId FIRST to route server-to-client requests through the same stream as the originating client request
    let requestId: RequestId | undefined = options?.relatedRequestId;

    // Then override with message.id for responses/errors
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      requestId = message.id;
    }

    if (requestId === RESTORE_REQUEST_ID) {
      return;
    }

    if (requestId === undefined) {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        throw new Error(
          "Cannot send a response on a standalone SSE stream unless resuming a previous client request"
        );
      }

      const standaloneSse = this.streamMapping.get(this.standaloneSseStreamId);
      if (standaloneSse === undefined) {
        return;
      }

      if (standaloneSse.writer && standaloneSse.encoder) {
        // Store event for resumability if eventStore is configured
        let eventId: EventId | undefined;
        if (this.eventStore) {
          eventId = await this.eventStore.storeEvent(
            this.standaloneSseStreamId,
            message
          );
        }

        const idLine = eventId ? `id: ${eventId}\n` : "";
        const data = `${idLine}event: message\ndata: ${JSON.stringify(message)}\n\n`;
        await standaloneSse.writer.write(standaloneSse.encoder.encode(data));
      }
      return;
    }

    const streamId = this.requestToStreamMapping.get(requestId);
    if (!streamId) {
      throw new Error(
        `No connection established for request ID: ${String(requestId)}`
      );
    }

    const response = this.streamMapping.get(streamId);
    if (!response) {
      throw new Error(
        `No connection established for request ID: ${String(requestId)}`
      );
    }

    if (!this.enableJsonResponse) {
      if (response.writer && response.encoder) {
        // Store event for resumability if eventStore is configured
        let eventId: EventId | undefined;
        if (this.eventStore) {
          eventId = await this.eventStore.storeEvent(streamId, message);
        }

        const idLine = eventId ? `id: ${eventId}\n` : "";
        const data = `${idLine}event: message\ndata: ${JSON.stringify(message)}\n\n`;
        await response.writer.write(response.encoder.encode(data));
      }
    }

    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      this.requestResponseMap.set(requestId, message);

      const relatedIds = Array.from(this.requestToStreamMapping.entries())
        .filter(([, sid]) => sid === streamId)
        .map(([id]) => id);

      const allResponsesReady = relatedIds.every((id) =>
        this.requestResponseMap.has(id)
      );

      if (allResponsesReady) {
        if (this.enableJsonResponse && response.resolveJson) {
          const responses = relatedIds.map(
            (id) => this.requestResponseMap.get(id)!
          );

          const headers = new Headers({
            "Content-Type": "application/json",
            ...this.getHeaders()
          });

          if (this.sessionId !== undefined) {
            headers.set("mcp-session-id", this.sessionId);
          }

          const body = responses.length === 1 ? responses[0] : responses;
          response.resolveJson(new Response(JSON.stringify(body), { headers }));
        } else {
          response.cleanup();
        }

        for (const id of relatedIds) {
          this.requestResponseMap.delete(id);
          this.requestToStreamMapping.delete(id);
        }
      }
    }
  }
}
