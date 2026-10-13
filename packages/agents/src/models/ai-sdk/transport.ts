import type { AISettings } from "../core/settings";
import {
  type Transport as CoreTransport,
  createTransport as createCoreTransport,
  errorFromGatewayEnvelope as coreErrorFromGatewayEnvelope,
  errorFromResponse as coreErrorFromResponse,
  unwrapEnvelope as coreUnwrapEnvelope
} from "../core/transport";
import { CloudflareAIError, toAISDKError } from "./errors";

export {
  definedHeaders,
  errorMessageFrom,
  headersToObject,
  isGatewayErrorEnvelope,
  type NativeRequest,
  type TransportRequest
} from "../core/transport";

/**
 * The typed AI SDK error for the gateway's own error envelope — a missing
 * gateway, an unpaid account — on the provider-native path.
 */
export function errorFromGatewayEnvelope(
  body: unknown,
  context: Parameters<typeof coreErrorFromGatewayEnvelope>[1]
): CloudflareAIError {
  return CloudflareAIError.fromCore(
    coreErrorFromGatewayEnvelope(body, context)
  );
}

/**
 * The transport this module uses, both halves through the binding:
 * `env.AI.run` for a model id, and the provider-native path for a vendor's
 * own model object.
 *
 * @experimental This surface is experimental and may change.
 */
export type Transport = CoreTransport;

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
    async native(request) {
      try {
        return await inner.native(request);
      } catch (error) {
        throw toAISDKError(error);
      }
    },
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
