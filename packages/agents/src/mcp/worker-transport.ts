/**
 * Based on @hono/mcp transport implementation (https://github.com/honojs/middleware/tree/main/packages/mcp)
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  RequestId
} from "@modelcontextprotocol/sdk/types.js";
import {
  isInitializeRequest,
  isJSONRPCError,
  isJSONRPCRequest,
  isJSONRPCResponse,
  JSONRPCMessageSchema
} from "@modelcontextprotocol/sdk/types.js";

interface StreamMapping {
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  encoder?: TextEncoder;
  resolveJson?: (response: Response) => void;
  cleanup: () => void;
}

export interface WorkerTransportOptions {
  sessionIdGenerator?: () => string;
  enableJsonResponse?: boolean;
  onsessioninitialized?: (sessionId: string) => void;
}

export class WorkerTransport implements Transport {
  private started = false;
  private initialized = false;
  private sessionIdGenerator?: () => string;
  private enableJsonResponse = false;
  private onsessioninitialized?: (sessionId: string) => void;
  private standaloneSseStreamId = "_GET_stream";
  private streamMapping = new Map<string, StreamMapping>();
  private requestToStreamMapping = new Map<RequestId, string>();
  private requestResponseMap = new Map<RequestId, JSONRPCMessage>();

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options?: WorkerTransportOptions) {
    this.sessionIdGenerator = options?.sessionIdGenerator;
    this.enableJsonResponse = options?.enableJsonResponse ?? false;
    this.onsessioninitialized = options?.onsessioninitialized;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Transport already started");
    }
    this.started = true;
  }

  async handleRequest(
    request: Request,
    parsedBody?: unknown
  ): Promise<Response> {
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
        { status: 406, headers: { "Content-Type": "application/json" } }
      );
    }

    const sessionValid = this.validateSession(request);
    if (sessionValid !== true) {
      return sessionValid;
    }

    const streamId = this.standaloneSseStreamId;

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
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const headers = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "mcp-session-id"
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

    return new Response(readable, { headers });
  }

  private async handlePostRequest(
    request: Request,
    parsedBody?: unknown
  ): Promise<Response> {
    const acceptHeader = request.headers.get("Accept");
    if (
      !acceptHeader?.includes("application/json") ||
      !acceptHeader.includes("text/event-stream")
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
        { status: 406, headers: { "Content-Type": "application/json" } }
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
        { status: 415, headers: { "Content-Type": "application/json" } }
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
          { status: 400, headers: { "Content-Type": "application/json" } }
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
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

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
          { status: 400, headers: { "Content-Type": "application/json" } }
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
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      this.sessionId = this.sessionIdGenerator?.();
      this.initialized = true;

      if (this.sessionId && this.onsessioninitialized) {
        this.onsessioninitialized(this.sessionId);
      }
    }

    if (!isInitializationRequest) {
      const sessionValid = this.validateSession(request);
      if (sessionValid !== true) {
        return sessionValid;
      }
    }

    const hasRequests = messages.some(isJSONRPCRequest);

    if (!hasRequests) {
      for (const message of messages) {
        this.onmessage?.(message);
      }
      return new Response(null, {
        status: 202,
        headers: {
          "Access-Control-Allow-Origin": "*"
        }
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
          this.onmessage?.(message);
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
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "mcp-session-id"
    });

    if (this.sessionId !== undefined) {
      headers.set("mcp-session-id", this.sessionId);
    }

    this.streamMapping.set(streamId, {
      writer,
      encoder,
      cleanup: () => {
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
      this.onmessage?.(message);
    }

    return new Response(readable, { headers });
  }

  private async handleDeleteRequest(request: Request): Promise<Response> {
    const sessionValid = this.validateSession(request);
    if (sessionValid !== true) {
      return sessionValid;
    }

    await this.close();
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  private handleOptionsRequest(_request: Request): Response {
    const headers = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Accept, Authorization, mcp-session-id",
      "Access-Control-Max-Age": "86400"
    });

    return new Response(null, { status: 204, headers });
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

  private validateSession(request: Request): true | Response {
    if (this.sessionIdGenerator === undefined) {
      return true;
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
        { status: 400, headers: { "Content-Type": "application/json" } }
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
        { status: 400, headers: { "Content-Type": "application/json" } }
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
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return true;
  }

  async close(): Promise<void> {
    for (const { cleanup } of this.streamMapping.values()) {
      cleanup();
    }

    this.streamMapping.clear();
    this.requestResponseMap.clear();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    let requestId: RequestId | undefined;

    if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
      requestId = message.id;
    }

    if (requestId === undefined) {
      if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
        throw new Error(
          "Cannot send a response on a standalone SSE stream unless resuming a previous client request"
        );
      }

      const standaloneSse = this.streamMapping.get(this.standaloneSseStreamId);
      if (standaloneSse === undefined) {
        return;
      }

      if (standaloneSse.writer && standaloneSse.encoder) {
        const data = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
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
        const data = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
        await response.writer.write(response.encoder.encode(data));
      }
    }

    if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
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
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "mcp-session-id"
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
