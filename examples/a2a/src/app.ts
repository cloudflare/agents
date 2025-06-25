import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { A2AResponse, JSONRPCErrorResponse, JSONRPCSuccessResponse } from "@a2a-js/sdk";
import { A2AError } from "@a2a-js/sdk";
import type { A2ARequestHandler } from "@a2a-js/sdk";
import { JsonRpcTransportHandler } from "@a2a-js/sdk";

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
    public setupRoutes(app: Hono, baseUrl: string = ''): Hono {
        app.get(`${baseUrl}/.well-known/agent.json`, async (c: Context) => {
            try {
                const agentCard = await this.requestHandler.getAgentCard();
                return c.json(agentCard);
            } catch (error: any) {
                console.error("Error fetching agent card:", error);
                return c.json({ error: "Failed to retrieve agent card" }, 500);
            }
        });

        app.post(baseUrl, async (c: Context) => {
            try {
                const body = await c.req.json();
                const rpcResponseOrStream = await this.jsonRpcTransportHandler.handle(body);

                // Check if it's an AsyncGenerator (stream)
                if (typeof (rpcResponseOrStream as any)?.[Symbol.asyncIterator] === 'function') {
                    const stream = rpcResponseOrStream as AsyncGenerator<JSONRPCSuccessResponse, void, undefined>;

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
                        } catch (streamError: any) {
                            console.error(`Error during SSE streaming (request ${body?.id}):`, streamError);
                            const a2aError = streamError instanceof A2AError ? streamError : A2AError.internalError(streamError.message || 'Streaming error.');
                            const errorResponse: JSONRPCErrorResponse = {
                                error: a2aError.toJSONRPCError(),
                                id: body?.id || null,
                                jsonrpc: '2.0',
                            };
                            const errorChunk = `id: ${Date.now()}\nevent: error\ndata: ${JSON.stringify(errorResponse)}\n\n`;
                            await writer.write(new TextEncoder().encode(errorChunk));
                        } finally {
                            await writer.close();
                        }
                    })();

                    return new Response(readable, {
                        headers: {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache',
                            'Connection': 'keep-alive',
                        },
                    });
                } else {
                    // Single JSON-RPC response
                    const rpcResponse = rpcResponseOrStream as A2AResponse;
                    return c.json(rpcResponse);
                }
            } catch (error: any) {
                console.error("Unhandled error in A2AHonoApp POST handler:", error);
                const a2aError = error instanceof A2AError ? error : A2AError.internalError('General processing error.');
                const errorResponse: JSONRPCErrorResponse = {
                    error: a2aError.toJSONRPCError(),
                    id: null,
                    jsonrpc: '2.0',
                };
                return c.json(errorResponse, 500);
            }
        });

        return app;
    }
}