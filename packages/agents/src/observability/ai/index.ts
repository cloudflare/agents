import type { AISDKInstrumentationOptions } from "./options";
import { createAISDKV6Wrapper } from "./v6/wrap";
import { tracer } from "../tracing/cloudflare";

/**
 * Wraps an AI SDK namespace with tracing.
 */
export function wrapAISDK<T extends Record<string, unknown>>(
  ai: T,
  options: AISDKInstrumentationOptions = {}
): T {
  return createAISDKV6Wrapper(ai, {
    options,
    tracer
  });
}

export type { AISDKInstrumentationOptions } from "./options";
