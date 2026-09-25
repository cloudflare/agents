import { SSE_HEADERS, formatSSEErrorEvent, formatSSEEvent } from "@a2a-js/sdk";
import { JsonRpcTransportHandler } from "@a2a-js/sdk/server";
import { isValidJsonRpcRequestId } from "./json-validation";

/**
 * Converts an SDK result iterator into SSE. The first item is awaited before
 * headers are committed so setup failures can still return JSON-RPC errors.
 */
export async function createJsonRpcSseResponse(
  result: AsyncIterable<unknown>,
  body: string,
  abortController = new AbortController()
): Promise<Response> {
  const iterator = result[Symbol.asyncIterator]();
  let first: IteratorResult<unknown>;
  try {
    first = await iterator.next();
  } catch (error) {
    return jsonRpcErrorResponse(body, error);
  }

  const encoder = new TextEncoder();
  const id = requestId(body);
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) {
        safeClose(controller);
        finished = true;
        return;
      }
      safeEnqueue(controller, encoder.encode(formatSSEEvent(first.value)));
    },
    async pull(controller) {
      if (finished) return;
      try {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          safeClose(controller);
          return;
        }
        safeEnqueue(controller, encoder.encode(formatSSEEvent(next.value)));
      } catch (error) {
        finished = true;
        safeEnqueue(
          controller,
          encoder.encode(
            formatSSEErrorEvent({
              jsonrpc: "2.0",
              id,
              error: JsonRpcTransportHandler.mapToJSONRPCError(error)
            })
          )
        );
        safeClose(controller);
      }
    },
    async cancel(reason) {
      finished = true;
      abortController.abort(reason);
      try {
        await iterator.return?.();
      } catch {
        // The consumer has disconnected; iterator cleanup is best effort.
      }
    }
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** Maps an error to JSON-RPC while preserving the original request ID. */
export function jsonRpcErrorResponse(body: string, error: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: requestId(body),
    error: JsonRpcTransportHandler.mapToJSONRPCError(error)
  });
}

function requestId(body: string): string | number | null {
  let id: string | number | null = null;
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    if (isValidJsonRpcRequestId(parsed.id)) {
      id = parsed.id;
    }
  } catch {
    // The transport error is enough when the body cannot be parsed.
  }
  return id;
}

function safeEnqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  value: Uint8Array
): void {
  try {
    controller.enqueue(value);
  } catch {
    // Cancellation may close the controller between an awaited read and enqueue.
  }
}

function safeClose(
  controller: ReadableStreamDefaultController<Uint8Array>
): void {
  try {
    controller.close();
  } catch {
    // Cancellation may already have closed the controller.
  }
}
