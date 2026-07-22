import {
  WebStandardStreamableHTTPServerTransport,
  isJSONRPCRequest,
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
import { KEEPALIVE_FRAME, KEEPALIVE_INTERVAL_MS } from "./sse-keepalive";

/**
 * Temporary adapter for Legacy compatibility on the SDK v2 transport.
 *
 * Local deltas from the upstream stateless fallback:
 *
 * - impossible stateless server-to-client requests fail immediately rather
 *   than leaving the tool handler waiting for a session response;
 * - active request resources are tracked so the parent handler can close them;
 * - streamed POST responses receive Cloudflare's 25-second SSE keepalive.
 *
 * Remove this adapter once the SDK exposes all three policies directly.
 */
export function createLegacyCompatibilityRequestHandler(
  factory: McpServerFactory,
  onerror?: (error: Error) => void
) {
  const activeTeardowns = new Set<() => Promise<void>>();

  const fetch = async (
    request: Request,
    options: McpHandlerRequestOptions | undefined
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
    let clearResponseKeepalive = () => {};
    let markResourcesReady!: () => void;
    const resourcesReady = new Promise<void>((resolve) => {
      markResourcesReady = resolve;
    });
    let resourcesAreReady = false;
    const ready = () => {
      if (resourcesAreReady) return;
      resourcesAreReady = true;
      markResourcesReady();
    };
    let teardownPromise: Promise<void> | undefined;
    const teardown = () =>
      (teardownPromise ??= (async () => {
        clearResponseKeepalive();
        await resourcesReady;
        activeTeardowns.delete(teardown);
        await Promise.all([
          transport?.close().catch(() => {}),
          product?.close().catch(() => {})
        ]);
      })());
    const onAbort = () => void teardown();
    activeTeardowns.add(teardown);

    try {
      product = await factory({
        era: "legacy",
        ...(options?.authInfo !== undefined && { authInfo: options.authInfo }),
        requestInfo: request
      });
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });
      ready();
      if (teardownPromise) {
        await teardown();
        throw new Error("This MCP handler has been closed");
      }

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
        ...(options?.authInfo !== undefined && {
          authInfo: options.authInfo
        }),
        ...(options?.parsedBody !== undefined && {
          parsedBody: options.parsedBody
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
      const encoder = new TextEncoder();
      let keepalive: ReturnType<typeof setInterval> | undefined;
      const clearKeepalive = () => {
        if (keepalive !== undefined) {
          clearInterval(keepalive);
          keepalive = undefined;
        }
      };
      clearResponseKeepalive = clearKeepalive;

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (teardownPromise) return;
          keepalive = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(KEEPALIVE_FRAME));
            } catch {
              clearKeepalive();
            }
          }, KEEPALIVE_INTERVAL_MS);
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              clearKeepalive();
              request.signal.removeEventListener("abort", onAbort);
              await teardown();
              controller.close();
            } else if (value !== undefined) {
              controller.enqueue(value);
            }
          } catch (error) {
            clearKeepalive();
            request.signal.removeEventListener("abort", onAbort);
            await teardown();
            controller.error(error);
          }
        },
        async cancel(reason) {
          clearKeepalive();
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
      ready();
      request.signal.removeEventListener("abort", onAbort);
      await teardown();
      reportHandlerError(onerror, error);
      return internalErrorResponse(
        requestIdFromParsedBody(options?.parsedBody)
      );
    }
  };

  return {
    fetch,
    close: () => Promise.all(Array.from(activeTeardowns, (close) => close()))
  };
}
