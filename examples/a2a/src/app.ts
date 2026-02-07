import {
  A2AError,
  JsonRpcTransportHandler,
  type A2ARequestHandler,
  type A2AResponse,
  type JSONRPCErrorResponse,
  type JSONRPCSuccessResponse
} from "@a2a-js/sdk";
import type { Context, Hono } from "hono";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

export class A2AHonoApp {
  private requestHandler: A2ARequestHandler;
  private jsonRpcTransportHandler: JsonRpcTransportHandler;

  constructor(requestHandler: A2ARequestHandler) {
    this.requestHandler = requestHandler;
    this.jsonRpcTransportHandler = new JsonRpcTransportHandler(requestHandler);
  }

  /**
   * Adds A2A routes to an existing Hono app.
   * @param app Optional existing Hono app.
   * @param baseUrl The base URL for A2A endpoints (e.g., "/a2a/api").
   * @returns The Hono app with A2A routes.
   */
  public setupRoutes(app: Hono, baseUrl = ""): Hono {
    app.get(baseUrl, async (c: Context) => {
      return c.html(`
        <html>
          <body>
            <h1>A2A Agent</h1>
            <p>This is an A2A agent.</p>
            <p>
              <a href="${baseUrl}/.well-known/agent.json">Agent Card</a>
            </p>            
          </body>
        </html>
      `);
    });
    app.get(`${baseUrl}/.well-known/agent.json`, async (c: Context) => {
      try {
        const agentCard = await this.requestHandler.getAgentCard();
        return c.json(agentCard);
      } catch (error) {
        console.error("Error fetching agent card:", error);
        return c.json({ error: "Failed to retrieve agent card" }, 500);
      }
    });

    app.post(baseUrl, async (c: Context) => {
      try {
        const body = await c.req.json();
        const rpcResponseOrStream =
          await this.jsonRpcTransportHandler.handle(body);

        // Check if it's an AsyncGenerator (stream)
        if (isAsyncIterable(rpcResponseOrStream)) {
          const stream = rpcResponseOrStream as AsyncGenerator<
            JSONRPCSuccessResponse,
            void,
            undefined
          >;

          // Create streaming response
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();

          // Start streaming in the background
          (async () => {
            try {
              for await (const event of stream) {
                const chunk = `id: ${Date.now()}\ndata: ${JSON.stringify(event)}\n\n`;
                await writer.write(new TextEncoder().encode(chunk));
              }
            } catch (streamError) {
              console.error(
                `Error during SSE streaming (request ${body?.id}):`,
                streamError
              );
              const a2aError =
                streamError instanceof A2AError
                  ? streamError
                  : A2AError.internalError(
                      (streamError as Error).message || "Streaming error."
                    );
              const errorResponse: JSONRPCErrorResponse = {
                error: a2aError.toJSONRPCError(),
                id: body?.id || null,
                jsonrpc: "2.0"
              };
              const errorChunk = `id: ${Date.now()}\nevent: error\ndata: ${JSON.stringify(errorResponse)}\n\n`;
              await writer.write(new TextEncoder().encode(errorChunk));
            } finally {
              await writer.close();
            }
          })();

          return new Response(readable, {
            headers: {
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Content-Type": "text/event-stream"
            }
          });
        }
        // Single JSON-RPC response
        const rpcResponse = rpcResponseOrStream as A2AResponse;
        return c.json(rpcResponse);
      } catch (error) {
        console.error("Unhandled error in A2AHonoApp POST handler:", error);
        const a2aError =
          error instanceof A2AError
            ? error
            : A2AError.internalError("General processing error.");
        const errorResponse: JSONRPCErrorResponse = {
          error: a2aError.toJSONRPCError(),
          id: null,
          jsonrpc: "2.0"
        };
        return c.json(errorResponse, 500);
      }
    });

    return app;
  }
}
