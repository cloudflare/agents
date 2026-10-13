import type { AISettings } from "../core/settings";
import {
  type Transport as CoreTransport,
  createTransport as createCoreTransport,
  errorFromResponse as coreErrorFromResponse,
  unwrapEnvelope as coreUnwrapEnvelope
} from "../core/transport";
import { CloudflareAIError, toAISDKError } from "./errors";

export {
  definedHeaders,
  errorMessageFrom,
  headersToObject,
  type TransportRequest
} from "../core/transport";

/**
 * The transport this module uses: `env.AI.run`, and nothing else. Every model
 * this module builds — Workers AI, catalog, dynamic route — is a run-path
 * request.
 *
 * @experimental This surface is experimental and may change.
 */
export type Transport = Omit<CoreTransport, "universal">;

/**
 * Unwraps the Cloudflare `{ success, result }` envelope, throwing an AI SDK
 * {@link CloudflareAIError} for a failed envelope.
 */
export function unwrapEnvelope(
  value: unknown,
  context?: Parameters<typeof coreUnwrapEnvelope>[1]
): unknown {
  try {
    return coreUnwrapEnvelope(value, context);
  } catch (error) {
    throw toAISDKError(error);
  }
}

/** The typed AI SDK error for a non-2xx response. */
export async function errorFromResponse(
  response: Response,
  context: Parameters<typeof coreErrorFromResponse>[1]
): Promise<CloudflareAIError> {
  return CloudflareAIError.fromCore(
    await coreErrorFromResponse(response, context)
  );
}

/**
 * Builds the transport for a set of provider settings, with every failure
 * lifted into the AI SDK error type.
 *
 * @experimental This surface is experimental and may change.
 */
export function createTransport(settings: AISettings): Transport {
  const inner = createCoreTransport(settings);
  return {
    logIdFallback: (response) => inner.logIdFallback(response),
    async run(request) {
      try {
        return await inner.run(request);
      } catch (error) {
        throw toAISDKError(error);
      }
    },
    url: inner.url
  };
}
