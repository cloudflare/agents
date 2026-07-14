import {
  McpServer,
  Server,
  isJSONRPCRequest,
  type McpHandlerRequestOptions,
  type McpServerFactory
} from "@modelcontextprotocol/server";
import type { McpAuthContext } from "./auth-context";
import {
  internalErrorResponse,
  reportHandlerError,
  requestIdFromParsedBody
} from "./handler-errors";
import { createLegacyMcpHandlerInternal } from "./handler-legacy";
import { WorkerTransport } from "./worker-transport";

/**
 * Temporary beta.4 compatibility adapter.
 *
 * Upstream reference:
 * modelcontextprotocol/typescript-sdk@e81758caed29f6568ce8873f7f9a3bd65b017d9c
 * packages/server/src/server/createMcpHandler.ts#legacyStatelessFallback
 *
 * Local delta: Agents' WorkerTransport turns impossible stateless
 * server-to-client requests into an immediate JSON-RPC error, rather than
 * leaving the tool handler waiting for a session response that cannot arrive.
 * Remove this adapter once the SDK exposes that fail-fast policy directly.
 */
export function createStatelessLegacyRequestHandler(
  factory: McpServerFactory,
  route: string,
  onerror?: (error: Error) => void
) {
  const activeTeardowns = new Set<() => Promise<void>>();

  const fetch = async (
    request: Request,
    options: McpHandlerRequestOptions | undefined,
    authContext: McpAuthContext | undefined,
    workerCtx: ExecutionContext
  ): Promise<Response> => {
    let product: McpServer | Server | undefined;
    let transport: WorkerTransport | undefined;
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
      transport = new WorkerTransport({ sessionIdGenerator: undefined });
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
                "Server-to-client requests are unavailable in stateless legacy mode. " +
                "Use inputRequired(...) for MCP 2026-07-28 clients, or route " +
                "2025-era traffic to a sessionful transport."
            }
          });
          return;
        }
        await send(message, sendOptions);
      };

      const handler = createLegacyMcpHandlerInternal(
        product as never,
        {
          route,
          transport,
          ...(authContext !== undefined && { authContext })
        },
        {
          ...(options?.authInfo !== undefined && {
            authInfo: options.authInfo
          }),
          ...(options?.parsedBody !== undefined && {
            parsedBody: options.parsedBody
          })
        }
      );
      request.signal.addEventListener("abort", onAbort, { once: true });
      const response = await handler(request, undefined, workerCtx);

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
          await teardown();
          await reader.cancel(reason).catch(() => {});
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
