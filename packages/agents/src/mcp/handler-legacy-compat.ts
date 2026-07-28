import {
  WebStandardStreamableHTTPServerTransport,
  isJSONRPCRequest,
  type CreateMcpHandlerOptions,
  type McpHandlerRequestOptions,
  type McpServer,
  type McpServerFactory,
  type Server
} from "@modelcontextprotocol/server";
import {
  internalErrorResponse,
  reportHandlerError,
  requestIdFromParsedBody
} from "./handler-errors";
/**
 * Temporary adapter for Legacy compatibility on the SDK v2 transport.
 *
 * Local deltas from the upstream stateless fallback:
 *
 * - impossible stateless server-to-client requests fail immediately rather
 *   than leaving the tool handler waiting for a session response.
 *
 * Streaming and keepalive behavior remain delegated to the SDK transport.
 * Remove this adapter once the SDK exposes the reverse-request policy directly.
 */
export function createLegacyCompatibilityRequestHandler(
  factory: McpServerFactory,
  handlerOptions: Pick<CreateMcpHandlerOptions, "keepAliveMs" | "onerror"> = {}
) {
  const { keepAliveMs, onerror } = handlerOptions;
  const fetch = async (
    request: Request,
    requestOptions: McpHandlerRequestOptions | undefined
  ): Promise<Response> => {
    // Match the upstream Legacy fallback: GET and DELETE are session operations
    // and cannot be served by a fresh per-request transport. Reject
    // them before running a factory with application-visible side effects.
    if (request.method.toUpperCase() !== "POST") {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null
        },
        { status: 405 }
      );
    }

    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    let product: McpServer | Server | undefined;
    let transport: WebStandardStreamableHTTPServerTransport | undefined;
    let teardownPromise: Promise<void> | undefined;
    const teardown = () =>
      (teardownPromise ??= (async () => {
        await Promise.all([
          transport?.close().catch(() => {}),
          product?.close().catch(() => {})
        ]);
      })());
    const onAbort = () => void teardown();

    try {
      product = await factory({
        era: "legacy",
        ...(requestOptions?.authInfo !== undefined && {
          authInfo: requestOptions.authInfo
        }),
        requestInfo: request
      });
      transport = new WebStandardStreamableHTTPServerTransport({
        keepAliveMs,
        sessionIdGenerator: undefined
      });

      const send = transport.send.bind(transport);
      transport.send = async (message, sendOptions) => {
        if (isJSONRPCRequest(message)) {
          transport?.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message:
                "Server-to-client requests are unavailable in the Legacy compatibility lane. " +
                "Use inputRequired(...) for Stateless clients, or route " +
                "Legacy traffic to a sessionful transport."
            }
          });
          return;
        }
        await send(message, sendOptions);
      };

      await product.connect(transport);
      if (request.signal.aborted) {
        await teardown();
        return new Response(null, { status: 499 });
      }
      request.signal.addEventListener("abort", onAbort, { once: true });
      const response = await transport.handleRequest(request, {
        ...(requestOptions?.authInfo !== undefined && {
          authInfo: requestOptions.authInfo
        }),
        ...(requestOptions?.parsedBody !== undefined && {
          parsedBody: requestOptions.parsedBody
        })
      });

      if (
        response.body === null ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        request.signal.removeEventListener("abort", onAbort);
        await teardown();
        return response;
      }

      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              request.signal.removeEventListener("abort", onAbort);
              await teardown();
              controller.close();
            } else if (value !== undefined) {
              controller.enqueue(value);
            }
          } catch (error) {
            request.signal.removeEventListener("abort", onAbort);
            await teardown();
            controller.error(error);
          }
        },
        async cancel(reason) {
          request.signal.removeEventListener("abort", onAbort);
          await reader.cancel(reason).catch(() => {});
          await teardown();
        }
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      request.signal.removeEventListener("abort", onAbort);
      await teardown();
      reportHandlerError(onerror, error);
      return internalErrorResponse(
        requestIdFromParsedBody(requestOptions?.parsedBody)
      );
    }
  };

  return { fetch };
}
