import type { AISDKInstrumentationOptions } from "./adapters/ai-sdk/options.js";
import { createAISDKV6Wrapper } from "./adapters/ai-sdk/v6/wrap.js";
import { tracer } from "./tracing/cloudflare.js";

/**
 * Wraps an AI SDK namespace with tracing.
 */
export function wrapAISDK<T extends Record<string, unknown>>(
  ai: T,
  options: AISDKInstrumentationOptions = {},
): T {
  return createAISDKV6Wrapper(ai, {
    options,
    tracer,
  });
}
