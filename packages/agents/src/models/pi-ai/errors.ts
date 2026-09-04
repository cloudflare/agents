/**
 * How a pi-ai stream reports failure: an `error` event carrying the assistant
 * message with `stopReason` and `errorMessage`, plus a diagnostic for the
 * failed dispatch. The framework-neutral `CloudflareAIError` from the core is
 * the source of the status, code and log id recorded there.
 */

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type StopReason
} from "@earendil-works/pi-ai";
import { CloudflareAIError, isAbortError } from "../core/errors";
import { errorFromResponse } from "../core/transport";

/** Diagnostic type under which a failed dispatch is recorded. */
export const CLOUDFLARE_ERROR_DIAGNOSTIC = "cloudflare-error";

function definedEntries(
  record: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Terminates a stream with a pi-ai `error` event built from a thrown value.
 * `aborted` when the caller's signal fired or the error is an abort; `error`
 * otherwise, with the failed dispatch recorded as a diagnostic.
 */
export function failStream(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
  error: unknown,
  signal: AbortSignal | undefined
): void {
  const aborted = signal?.aborted === true || isAbortError(error);
  const reason: Extract<StopReason, "aborted" | "error"> = aborted
    ? "aborted"
    : "error";
  message.stopReason = reason;
  message.errorMessage =
    error instanceof Error ? error.message : JSON.stringify(error);
  if (!aborted) {
    const details: Record<string, unknown> = {};
    if (error instanceof CloudflareAIError) {
      Object.assign(
        details,
        definedEntries({
          code: error.code,
          logId: error.logId,
          model: error.model,
          status: error.status
        })
      );
    }
    message.diagnostics = [
      ...(message.diagnostics ?? []),
      {
        details,
        error: {
          message: message.errorMessage,
          name: error instanceof Error ? error.name : "Error",
          ...(error instanceof CloudflareAIError ? { code: error.code } : {})
        },
        timestamp: Date.now(),
        type: CLOUDFLARE_ERROR_DIAGNOSTIC
      }
    ];
  }
  stream.push({ error: message, reason, type: "error" });
  stream.end(message);
}

/** Throws the typed error for a non-2xx response. */
export async function assertOk(
  response: Response,
  context: { model: string; url: string; requestBodyValues: unknown }
): Promise<void> {
  if (response.ok) return;
  throw await errorFromResponse(response, context);
}
