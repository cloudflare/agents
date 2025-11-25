import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type MessageExtraInfo,
  InitializeRequestSchema,
  isJSONRPCResponse,
  isJSONRPCNotification
} from "@modelcontextprotocol/sdk/types.js";
import type { McpAgent } from ".";
import { getAgentByName } from "..";
import type { CORSOptions } from "./types";
import { MessageType } from "../ai-types";

/**
 * Since we use WebSockets to bridge the client to the
 * MCP transport in the Agent, we use this header to signal
 * the method of the original request the user made, while
 * leaving the WS Upgrade request as GET.
 */
export const MCP_HTTP_METHOD_HEADER = "cf-mcp-method";

/**
 * Since we use WebSockets to bridge the client to the
 * MCP transport in the Agent, we use this header to include
 * the original request body.
 */
export const MCP_MESSAGE_HEADER = "cf-mcp-message";

const MAXIMUM_MESSAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB

export const createStreamingHttpHandler = (
  basePath: string,
  namespace: DurableObjectNamespace<McpAgent>,
  options: {
    corsOptions?: CORSOptions;
    jurisdiction?: DurableObjectJurisdiction;
  } = {}
) => {
  let pathname = basePath;
  if (basePath === "/") pathname = "/*";

  const basePattern = new URLPattern({ pathname });
  return async (request: Request, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    if (basePattern.test(url)) {
      if (request.method === "POST") {
        // Validate the Accept header
        const acceptHeader = request.headers.get("accept");
        // The client MUST include an Accept header, listing both application/json and text/event-stream as supported content types.
        if (
          !acceptHeader?.includes("application/json") ||
          !acceptHeader.includes("text/event-stream")
        ) {
          const body = JSON.stringify({
            error: {
              code: -32000,
              message:
                "Not Acceptable: Client must accept both application/json and text/event-stream"
            },
            id: null,
            jsonrpc: "2.0"
          });
          return new Response(body, { status: 406 });
        }

        const ct = request.headers.get("content-type");
        if (!ct || !ct.includes("application/json")) {
          const body = JSON.stringify({
            error: {
              code: -32000,
              message:
                "Unsupported Media Type: Content-Type must be application/json"
            },
            id: null,
            jsonrpc: "2.0"
          });
          return new Response(body, { status: 415 });
        }

        // Check content length against maximum allowed size
        const contentLength = Number.parseInt(
          request.headers.get("content-length") ?? "0",
          10
        );
        if (contentLength > MAXIMUM_MESSAGE_SIZE_BYTES) {
          const body = JSON.stringify({
            error: {
              code: -32000,
              message: `Request body too large. Maximum size is ${MAXIMUM_MESSAGE_SIZE_BYTES} bytes`
            },
            id: null,
            jsonrpc: "2.0"
          });
          return new Response(body, { status: 413 });
        }

        let sessionId = request.headers.get("mcp-session-id");
        let rawMessage: unknown;

        try {
          rawMessage = await request.json();
        } catch (_error) {
          const body = JSON.stringify({
            error: {
              code: -32700,
              message: "Parse error: Invalid JSON"
            },
            id: null,
            jsonrpc: "2.0"
          });
          return new Response(body, { status: 400 });
        }

        // Make sure the message is an array to simplify logic
        let arrayMessage: unknown[];
        if (Array.isArray(rawMessage)) {
          arrayMessage = rawMessage;
        } else {
          arrayMessage = [rawMessage];
        }

        let messages: JSONRPCMessage[] = [];

        // Try to parse each message as JSON RPC. Fail if any message is invalid
        for (const msg of arrayMessage) {
          if (!JSONRPCMessageSchema.safeParse(msg).success) {
            const body = JSON.stringify({
              error: {
                code: -32700,
                message: "Parse error: Invalid JSON-RPC message"
              },
              id: null,
              jsonrpc: "2.0"
            });
            return new Response(body, { status: 400 });
          }
        }

        messages = arrayMessage.map((msg) => JSONRPCMessageSchema.parse(msg));

        // Before we pass the messages to the agent, there's another error condition we need to enforce
        // Check if this is an initialization request
        // https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle/
        const maybeInitializeRequest = messages.find(
          (msg) => InitializeRequestSchema.safeParse(msg).success
        );

        if (!!maybeInitializeRequest && sessionId) {
          const body = JSON.stringify({
            error: {
              code: -32600,
              message:
                "Invalid Request: Initialization requests must not include a sessionId"
            },
            id: null,
            jsonrpc: "2.0"
          });
          return new Response(body, { status: 400 });
        }

        // The initialization request must be the only request in the batch
        if (!!maybeInitializeRequest && messages.length > 1) {
          const body = JSON.stringify({
            error: {
              code: -32600,
              message:
                "Invalid Request: Only one initialization request is allowed"
            },
            id: null,
            jsonrpc: "2.0"
          });
          return new Response(body, { status: 400 });
        }

        // If an Mcp-Session-Id is returned by the server during initialization,
        // clients using the Streamable HTTP transport MUST include it
        // in the Mcp-Session-Id header on all of their subsequent HTTP requests.
        if (!maybeInitializeRequest && !sessionId) {
          const body = JSON.stringify({
            error: {
              code: -32000,
              message: "Bad Request: Mcp-Session-Id header is required"
            },
            id: null,
            jsonrpc: "2.0"
          });
          return new Response(body, { status: 400 });
        }

        // If we don't have a sessionId, we are serving an initialization request
        // and need to generate a new sessionId
        sessionId = sessionId ?? namespace.newUniqueId().toString();

        // Get the agent and set props
        const agent = await getAgentByName(
          namespace,
          `streamable-http:${sessionId}`,
          {
            props: ctx.props as Record<string, unknown> | undefined,
            jurisdiction: options.jurisdiction
          }
        );
        const isInitialized = await agent.getInitializeRequest();

        if (maybeInitializeRequest) {
          await agent.setInitializeRequest(maybeInitializeRequest);
        } else if (!isInitialized) {
          // if we have gotten here, then a session id that was never initialized
          // was provided
          const body = JSON.stringify({
            error: {
              code: -32001,
              message: "Session not found"
            },
            id: null,
            jsonrpc: "2.0"
          });
          return new Response(body, { status: 404 });
        }

        // We've evaluated all the error conditions! Now it's time to establish
        // all the streams

        // Create a Transform Stream for SSE
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        // Connect to the Durable Object via WebSocket
        const existingHeaders: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          existingHeaders[key] = value;
        });

        const req = new Request(request.url, {
          headers: {
            ...existingHeaders,
            [MCP_HTTP_METHOD_HEADER]: "POST",
            [MCP_MESSAGE_HEADER]: Buffer.from(
              JSON.stringify(messages)
            ).toString("base64"),
            Upgrade: "websocket"
          }
        });
        if (ctx.props) agent.updateProps(ctx.props as Record<string, unknown>);
        const response = await agent.fetch(req);

        // Get the WebSocket
        const ws = response.webSocket;
        if (!ws) {
          console.error("Failed to establish WebSocket connection");

          await writer.close();
          const body = JSON.stringify({
            error: {
              code: -32001,
              message: "Failed to establish WebSocket connection"
            },
            id: null,
            jsonrpc: "2.0"
          });
          return new Response(body, { status: 500 });
        }

        // Accept the WebSocket
        ws.accept();

        // Handle messages from the Durable Object
        ws.addEventListener("message", (event) => {
          async function onMessage(event: MessageEvent) {
            try {
              const data =
                typeof event.data === "string"
                  ? event.data
                  : new TextDecoder().decode(event.data);
              const message = JSON.parse(data);

              // We only forward events from the MCP server
              if (message.type !== MessageType.CF_MCP_AGENT_EVENT) {
                return;
              }

              // Send the message as an SSE event
              await writer.write(encoder.encode(message.event));

              // If we have received all the responses, close the connection
              if (message.close) {
                ws?.close();
                await writer.close().catch(() => {});
              }
            } catch (error) {
              console.error("Error forwarding message to SSE:", error);
            }
          }
          onMessage(event).catch(console.error);
        });

        // Handle WebSocket errors
        ws.addEventListener("error", (error) => {
          async function onError(_error: Event) {
            await writer.close().catch(() => {});
          }
          onError(error).catch(console.error);
        });

        // Handle WebSocket closure
        ws.addEventListener("close", () => {
          async function onClose() {
            await writer.close().catch(() => {});
          }
          onClose().catch(console.error);
        });

        // If there are no requests, we send the messages to the agent and acknowledge the request with a 202
        // since we don't expect any responses back through this connection
        const hasOnlyNotificationsOrResponses = messages.every(
          (msg) => isJSONRPCNotification(msg) || isJSONRPCResponse(msg)
        );
        if (hasOnlyNotificationsOrResponses) {
          // closing the websocket will also close the SSE connection
          ws.close();

          return new Response(null, {
            headers: corsHeaders(request, options.corsOptions),
            status: 202
          });
        }

        // Return the SSE response. We handle closing the stream in the ws "message"
        // handler
        return new Response(readable, {
          headers: {
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
            "mcp-session-id": sessionId,
            ...corsHeaders(request, options.corsOptions)
          },
          status: 200
        });
      } else if (request.method === "GET") {
        // Validate the Accept header
        const acceptHeader = request.headers.get("accept");
        // The client MUST include an Accept header, listing both application/json and text/event-stream as supported content types.
        if (!acceptHeader?.includes("text/event-stream")) {
          const body = JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Not Acceptable: Client must accept text/event-stream"
            },
            id: null
          });
          return new Response(body, { status: 406 });
        }

        // Require sessionId
        const sessionId = request.headers.get("mcp-session-id");
        if (!sessionId)
          return new Response(
            JSON.stringify({
              error: {
                code: -32000,
                message: "Bad Request: Mcp-Session-Id header is required"
              },
              id: null,
              jsonrpc: "2.0"
            }),
            { status: 400 }
          );

        // Create SSE stream
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const agent = await getAgentByName(
          namespace,
          `streamable-http:${sessionId}`,
          {
            props: ctx.props as Record<string, unknown> | undefined,
            jurisdiction: options.jurisdiction
          }
        );
        const isInitialized = await agent.getInitializeRequest();
        if (!isInitialized) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: null
            }),
            { status: 404 }
          );
        }

        const existingHeaders: Record<string, string> = {};
        request.headers.forEach((v, k) => {
          existingHeaders[k] = v;
        });

        if (ctx.props) agent.updateProps(ctx.props as Record<string, unknown>);
        const response = await agent.fetch(
          new Request(request.url, {
            headers: {
              ...existingHeaders,
              [MCP_HTTP_METHOD_HEADER]: "GET",
              Upgrade: "websocket"
            }
          })
        );

        const ws = response.webSocket;
        if (!ws) {
          await writer.close();
          return new Response("Failed to establish WS to DO", {
            status: 500
          });
        }
        ws.accept();

        // Forward DO messages as SSE
        ws.addEventListener("message", (event) => {
          try {
            async function onMessage(ev: MessageEvent) {
              const data =
                typeof ev.data === "string"
                  ? ev.data
                  : new TextDecoder().decode(ev.data);
              const message = JSON.parse(data);

              // We only forward events from the MCP server
              if (message.type !== MessageType.CF_MCP_AGENT_EVENT) {
                return;
              }
              await writer.write(encoder.encode(message.event));
            }
            onMessage(event).catch(console.error);
          } catch (e) {
            console.error("Error forwarding message to SSE:", e);
          }
        });

        ws.addEventListener("error", () => {
          writer.close().catch(() => {});
        });
        ws.addEventListener("close", () => {
          writer.close().catch(() => {});
        });

        return new Response(readable, {
          headers: {
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
            "mcp-session-id": sessionId,
            ...corsHeaders(request, options.corsOptions)
          },
          status: 200
        });
      } else if (request.method === "DELETE") {
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
            { status: 400, headers: corsHeaders(request, options.corsOptions) }
          );
        }
        const agent = await getAgentByName(
          namespace,
          `streamable-http:${sessionId}`,
          { jurisdiction: options.jurisdiction }
        );
        const isInitialized = await agent.getInitializeRequest();
        if (!isInitialized) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: null
            }),
            { status: 404, headers: corsHeaders(request, options.corsOptions) }
          );
        }
        // .destroy() passes an uncatchable Error, so we make sure we first return
        // the response to the client.
        ctx.waitUntil(
          agent.destroy().catch(() => {
            /* This will always throw. We silently catch here */
          })
        );
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request, options.corsOptions)
        });
      }
    }

    // Route not found
    const body = JSON.stringify({
      error: {
        code: -32000,
        message: "Not found"
      },
      id: null,
      jsonrpc: "2.0"
    });
    return new Response(body, { status: 404 });
  };
};

export const createLegacySseHandler = (
  basePath: string,
  namespace: DurableObjectNamespace<McpAgent>,
  options: {
    corsOptions?: CORSOptions;
    jurisdiction?: DurableObjectJurisdiction;
  } = {}
) => {
  let pathname = basePath;
  if (basePath === "/") pathname = "/*";

  const basePattern = new URLPattern({ pathname });
  const messagePattern = new URLPattern({ pathname: `${basePath}/message` }); // SSE only
  return async (request: Request, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    // Handle initial SSE connection
    if (request.method === "GET" && basePattern.test(url)) {
      // Use a session ID if one is passed in, or create a unique
      // session ID for this connection
      const sessionId =
        url.searchParams.get("sessionId") || namespace.newUniqueId().toString();

      // Create a Transform Stream for SSE
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Send the endpoint event
      const endpointUrl = new URL(request.url);
      endpointUrl.pathname = encodeURI(`${basePath}/message`);
      endpointUrl.searchParams.set("sessionId", sessionId);
      const relativeUrlWithSession =
        endpointUrl.pathname + endpointUrl.search + endpointUrl.hash;
      const endpointMessage = `event: endpoint\ndata: ${relativeUrlWithSession}\n\n`;
      writer.write(encoder.encode(endpointMessage));

      // Get the Durable Object
      const agent = await getAgentByName(namespace, `sse:${sessionId}`, {
        props: ctx.props as Record<string, unknown> | undefined,
        jurisdiction: options.jurisdiction
      });

      // Connect to the Durable Object via WebSocket
      const existingHeaders: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        existingHeaders[key] = value;
      });
      if (ctx.props) agent.updateProps(ctx.props as Record<string, unknown>);
      const response = await agent.fetch(
        new Request(request.url, {
          headers: {
            ...existingHeaders,
            Upgrade: "websocket"
          }
        })
      );

      // Get the WebSocket
      const ws = response.webSocket;
      if (!ws) {
        console.error("Failed to establish WebSocket connection");
        await writer.close();
        return new Response("Failed to establish WebSocket connection", {
          status: 500
        });
      }

      // Accept the WebSocket
      ws.accept();

      // Handle messages from the Durable Object
      ws.addEventListener("message", (event) => {
        async function onMessage(event: MessageEvent) {
          try {
            const message = JSON.parse(event.data);

            // validate that the message is a valid JSONRPC message
            const result = JSONRPCMessageSchema.safeParse(message);
            if (!result.success) {
              // The message was not a valid JSONRPC message, so we will drop it
              // PartyKit will broadcast state change messages to all connected clients
              // and we need to filter those out so they are not passed to MCP clients
              return;
            }

            // Send the message as an SSE event
            const messageText = `event: message\ndata: ${JSON.stringify(result.data)}\n\n`;
            await writer.write(encoder.encode(messageText));
          } catch (error) {
            console.error("Error forwarding message to SSE:", error);
          }
        }
        onMessage(event).catch(console.error);
      });

      // Handle WebSocket errors
      ws.addEventListener("error", (error) => {
        async function onError(_error: Event) {
          try {
            await writer.close();
          } catch (_e) {
            // Ignore errors when closing
          }
        }
        onError(error).catch(console.error);
      });

      // Handle WebSocket closure
      ws.addEventListener("close", () => {
        async function onClose() {
          try {
            await writer.close();
          } catch (error) {
            console.error("Error closing SSE connection:", error);
          }
        }
        onClose().catch(console.error);
      });

      // Return the SSE response
      return new Response(readable, {
        headers: {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
          ...corsHeaders(request, options.corsOptions)
        }
      });
    }

    // Handle incoming MCP messages. These will be passed to McpAgent
    // but the response will be sent back via the open SSE connection
    // so we only need to return a 202 Accepted response for success
    if (request.method === "POST" && messagePattern.test(url)) {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        return new Response(
          `Missing sessionId. Expected POST to ${basePath} to initiate new one`,
          { status: 400 }
        );
      }

      const contentType = request.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return new Response(`Unsupported content-type: ${contentType}`, {
          status: 400
        });
      }

      // check if the request body is too large
      const contentLength = Number.parseInt(
        request.headers.get("content-length") || "0",
        10
      );
      if (contentLength > MAXIMUM_MESSAGE_SIZE_BYTES) {
        return new Response(`Request body too large: ${contentLength} bytes`, {
          status: 400
        });
      }

      // Get the Durable Object
      const agent = await getAgentByName(namespace, `sse:${sessionId}`, {
        props: ctx.props as Record<string, unknown> | undefined,
        jurisdiction: options.jurisdiction
      });

      const messageBody = await request.json();

      // Build MessageExtraInfo with filtered headers
      const headers = Object.fromEntries(request.headers.entries());

      const extraInfo: MessageExtraInfo = {
        requestInfo: { headers }
      };

      const error = await agent.onSSEMcpMessage(
        sessionId,
        messageBody,
        extraInfo
      );

      if (error) {
        return new Response(error.message, {
          headers: {
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
            ...corsHeaders(request, options.corsOptions)
          },
          status: 400
        });
      }

      return new Response("Accepted", {
        headers: {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
          ...corsHeaders(request, options.corsOptions)
        },
        status: 202
      });
    }

    return new Response("Not Found", { status: 404 });
  };
};

// CORS helper functions
export function corsHeaders(_request: Request, corsOptions: CORSOptions = {}) {
  const origin = "*";
  return {
    "Access-Control-Allow-Headers":
      corsOptions.headers ||
      "Content-Type, Accept, mcp-session-id, mcp-protocol-version",
    "Access-Control-Allow-Methods":
      corsOptions.methods || "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Origin": corsOptions.origin || origin,
    "Access-Control-Expose-Headers":
      corsOptions.exposeHeaders || "mcp-session-id",
    "Access-Control-Max-Age": (corsOptions.maxAge || 86400).toString()
  };
}

export function handleCORS(
  request: Request,
  corsOptions?: CORSOptions
): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(request, corsOptions) });
  }

  return null;
}

export function isDurableObjectNamespace(
  namespace: unknown
): namespace is DurableObjectNamespace<McpAgent> {
  return (
    typeof namespace === "object" &&
    namespace !== null &&
    "newUniqueId" in namespace &&
    typeof namespace.newUniqueId === "function" &&
    "idFromName" in namespace &&
    typeof namespace.idFromName === "function"
  );
}
